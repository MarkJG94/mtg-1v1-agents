import {
  type EventTarget,
  type ObjectId,
  type PlayerId,
  playerIds,
  type ZoneId,
} from '@mtg/shared';
import { characteristicsOf } from '../characteristics.js';
import { manaValue } from '../mana/cost.js';
import type { GameState } from '../state/game-state.js';
import { objectsIn } from '../state/update.js';
import type { CardDefinition } from './definition.js';
import type {
  Condition,
  Filter,
  ObjectSelector,
  PlayerSelector,
  Quantity,
  TargetSelector,
} from './vocabulary.js';

/**
 * Reading a card's vocabulary against a game (docs/03).
 *
 * Filters, quantities and selectors are data; this is where they mean something. Two
 * rules run through all of it. Characteristics are read through `characteristics()`, so a
 * filter sees the creature an anthem has made rather than the one that was printed. And
 * anything that cannot be answered — a target that is no longer there, a selector with
 * nothing to point at — comes back empty rather than throwing, because a spell whose
 * subject has left simply does nothing (CR 608.2b).
 */

export interface EffectContext {
  /** The ability's source. `~` in a script. */
  readonly source: ObjectId;
  readonly controller: PlayerId;
  /** Targets chosen as the spell or ability was put on the stack, by their script id. */
  readonly targets: Readonly<Record<string, readonly EventTarget[]>>;
  /** The value chosen for {X} as the spell was cast. */
  readonly x: number;
  /** The object an enclosing `forEach` is currently on. */
  readonly each?: ObjectId;
}

export const opponentOf = (player: PlayerId): PlayerId =>
  playerIds.find((other) => other !== player) ?? player;

/** Active player first (CR 101.4), which is the order simultaneous things happen in. */
export const inApnapOrder = (state: GameState): readonly PlayerId[] => [
  state.activePlayer,
  opponentOf(state.activePlayer),
];

export const definitionFor = (state: GameState, object: ObjectId): CardDefinition | undefined => {
  const found = state.objects.get(object);
  return found === undefined ? undefined : state.definitions.get(found.definitionId);
};

// --- Selectors ---

export const resolvePlayers = (
  state: GameState,
  context: EffectContext,
  selector: PlayerSelector,
): readonly PlayerId[] => {
  switch (selector.kind) {
    case 'you':
      return [context.controller];
    case 'opponent':
      return [opponentOf(context.controller)];
    case 'each':
      return inApnapOrder(state);
    case 'player':
      return [selector.player];
    case 'target': {
      const chosen = context.targets[selector.id] ?? [];
      return chosen.flatMap((target) => (target.kind === 'player' ? [target.player] : []));
    }
    case 'controllerOf': {
      const objects = resolveObjects(state, context, selector.object);
      return objects.flatMap((id) => {
        const object = state.objects.get(id);
        return object === undefined ? [] : [object.controller];
      });
    }
  }
};

export const resolveObjects = (
  state: GameState,
  context: EffectContext,
  selector: ObjectSelector,
): readonly ObjectId[] => {
  switch (selector.kind) {
    case 'source':
      return state.objects.has(context.source) ? [context.source] : [];
    case 'object':
      return state.objects.has(selector.object) ? [selector.object] : [];
    case 'each':
      return context.each !== undefined && state.objects.has(context.each) ? [context.each] : [];
    case 'target': {
      const chosen = context.targets[selector.id] ?? [];
      return chosen.flatMap((target) =>
        target.kind === 'object' && state.objects.has(target.object) ? [target.object] : [],
      );
    }
  }
};

/** A selector that can name either, the way "any target" does. */
export const resolveTargets = (
  state: GameState,
  context: EffectContext,
  selector: TargetSelector,
): readonly EventTarget[] => {
  switch (selector.kind) {
    case 'object':
      return resolveObjects(state, context, selector.object).map((object) => ({
        kind: 'object' as const,
        object,
      }));
    case 'player':
      return resolvePlayers(state, context, selector.player).map((player) => ({
        kind: 'player' as const,
        player,
      }));
    case 'chosen':
      return (context.targets[selector.id] ?? []).filter((target) =>
        target.kind === 'object' ? state.objects.has(target.object) : true,
      );
  }
};

// --- Filters ---

/**
 * Which zones a filter is about. Magic's convention is that "creature" means one on the
 * battlefield unless the card says otherwise, so that is the default; a filter that names
 * a zone, or asks for a spell, looks where it says instead.
 */
const zonesOf = (filter: Filter): readonly ZoneId[] => {
  switch (filter.kind) {
    case 'inZone':
      return [filter.zone];
    case 'spell':
      return ['stack'];
    case 'not':
      return zonesOf(filter.filter);
    case 'and':
    case 'or': {
      const zones = filter.filters.flatMap(zonesOf).filter((zone) => zone !== 'battlefield');
      return zones.length > 0 ? zones : ['battlefield'];
    }
    default:
      return ['battlefield'];
  }
};

export const matchesFilter = (
  state: GameState,
  context: EffectContext,
  filter: Filter,
  subject: EventTarget,
): boolean => {
  if (subject.kind === 'player') {
    switch (filter.kind) {
      case 'any':
      case 'player':
        return true;
      case 'controlledBy':
        return playerMatches(context, filter.player, subject.player);
      case 'not':
        return !matchesFilter(state, context, filter.filter, subject);
      case 'and':
        return filter.filters.every((each) => matchesFilter(state, context, each, subject));
      case 'or':
        return filter.filters.some((each) => matchesFilter(state, context, each, subject));
      default:
        return false;
    }
  }

  const object = state.objects.get(subject.object);
  if (object === undefined) return false;
  const traits = characteristicsOf(state, subject.object);
  const definition = definitionFor(state, subject.object);

  switch (filter.kind) {
    case 'any':
      // "Any target": a creature, a planeswalker, a battle or a player (CR 115.4).
      return traits.isCreature || object.loyalty !== null;
    case 'player':
      return false;
    case 'creature':
      return traits.isCreature && object.zone === 'battlefield';
    case 'planeswalker':
      return object.loyalty !== null && object.zone === 'battlefield';
    case 'permanent':
      return object.zone === 'battlefield';
    case 'spell':
      return object.zone === 'stack' && object.stack?.isAbility !== true;
    case 'type':
      return filter.type === 'creature'
        ? traits.isCreature
        : (definition?.types.includes(filter.type) ?? false);
    case 'subtype':
      return definition?.subtypes?.includes(filter.subtype) ?? false;
    case 'colour':
      return traits.colours.includes(filter.colour);
    case 'controlledBy':
      return playerMatches(context, filter.player, object.controller);
    case 'inZone':
      return object.zone === filter.zone;
    case 'tapped':
      return object.tapped === filter.tapped;
    case 'attacking':
      return state.combat?.attackers.some((attack) => attack.attacker === object.id) ?? false;
    case 'blocking':
      return (
        state.combat?.attackers.some((attack) => attack.blockedBy.includes(object.id)) ?? false
      );
    case 'hasKeyword':
      return traits.keywords[filter.keyword] === true;
    case 'powerAtLeast':
      return (traits.power ?? 0) >= filter.amount;
    case 'powerAtMost':
      return (traits.power ?? 0) <= filter.amount;
    case 'toughnessAtMost':
      return (traits.toughness ?? 0) <= filter.amount;
    case 'manaValueAtMost':
      return definition !== undefined && manaValue(definition.manaCost) <= filter.amount;
    case 'token':
      return object.token === filter.token;
    case 'named':
      return traits.name === filter.name;
    case 'not':
      return !matchesFilter(state, context, filter.filter, subject);
    case 'and':
      return filter.filters.every((each) => matchesFilter(state, context, each, subject));
    case 'or':
      return filter.filters.some((each) => matchesFilter(state, context, each, subject));
  }
};

const playerMatches = (
  context: EffectContext,
  relation: 'you' | 'opponent' | 'any',
  player: PlayerId,
): boolean => {
  switch (relation) {
    case 'you':
      return player === context.controller;
    case 'opponent':
      return player !== context.controller;
    case 'any':
      return true;
  }
};

/** Every object a filter matches, in the zones it is about. */
export const objectsMatching = (
  state: GameState,
  context: EffectContext,
  filter: Filter,
): readonly ObjectId[] =>
  zonesOf(filter)
    .flatMap((zone) => objectsIn(state, zone))
    .filter((object) => matchesFilter(state, context, filter, { kind: 'object', object }));

// --- Quantities and conditions ---

export const evaluateQuantity = (
  state: GameState,
  context: EffectContext,
  quantity: Quantity,
): number => {
  if (typeof quantity === 'number') return quantity;

  switch (quantity.kind) {
    case 'x':
      return context.x;
    case 'count':
      return objectsMatching(state, context, quantity.of).length;
    case 'cardsInHand':
      return resolvePlayers(state, context, quantity.player).reduce(
        (total, player) => total + objectsIn(state, `${player}:hand` as ZoneId).length,
        0,
      );
    case 'lifeTotal':
      return resolvePlayers(state, context, quantity.player).reduce(
        (total, player) => total + state.players[player].life,
        0,
      );
    case 'powerOf':
      return resolveObjects(state, context, quantity.object).reduce(
        (total, object) => total + (characteristicsOf(state, object).power ?? 0),
        0,
      );
    case 'toughnessOf':
      return resolveObjects(state, context, quantity.object).reduce(
        (total, object) => total + (characteristicsOf(state, object).toughness ?? 0),
        0,
      );
    case 'countersOn':
      return resolveObjects(state, context, quantity.object).reduce(
        (total, object) => total + (state.objects.get(object)?.counters[quantity.counter] ?? 0),
        0,
      );
    case 'add':
      return (
        evaluateQuantity(state, context, quantity.left) +
        evaluateQuantity(state, context, quantity.right)
      );
    case 'sub':
      return (
        evaluateQuantity(state, context, quantity.left) -
        evaluateQuantity(state, context, quantity.right)
      );
    case 'mul':
      return (
        evaluateQuantity(state, context, quantity.left) *
        evaluateQuantity(state, context, quantity.right)
      );
  }
};

export const holds = (state: GameState, context: EffectContext, condition: Condition): boolean => {
  switch (condition.kind) {
    case 'atLeast':
      return (
        evaluateQuantity(state, context, condition.amount) >=
        evaluateQuantity(state, context, condition.than)
      );
    case 'equal':
      return (
        evaluateQuantity(state, context, condition.amount) ===
        evaluateQuantity(state, context, condition.than)
      );
    case 'exists':
      return objectsMatching(state, context, condition.filter).length > 0;
    case 'notExists':
      return objectsMatching(state, context, condition.filter).length === 0;
    case 'not':
      return !holds(state, context, condition.condition);
    case 'and':
      return condition.conditions.every((each) => holds(state, context, each));
    case 'or':
      return condition.conditions.some((each) => holds(state, context, each));
  }
};
