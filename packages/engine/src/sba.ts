import {
  type ObjectId,
  type PlayerId,
  playerIds,
  playerZone,
  type SbaKind,
  type ZoneId,
} from '@mtg/shared';
import {
  characteristicsOf,
  counterCount,
  currentLoyalty,
  isPlaneswalker,
  remainingToughness,
} from './characteristics.js';
import type { EventEmitter } from './events/emitter.js';
import { runBatch } from './events/perform.js';
import type { MoveZoneEvent } from './events/rules-event.js';
import { playersLoseGame } from './game-end.js';
import type { GameState } from './state/game-state.js';
import { withCounters } from './state/object.js';
import { destroyObject, getObject, objectsIn, updateObject, updateState } from './state/update.js';

/**
 * State-based actions (CR 704).
 *
 * These are the rules that tidy up the game without anyone doing anything: creatures with
 * lethal damage die, players at zero life lose, a token that leaves the battlefield stops
 * existing. They are checked whenever a player would receive priority (CR 704.3), never
 * in the middle of something, and they repeat until none apply — killing one creature can
 * make another's toughness zero.
 *
 * Everything applicable happens at once rather than one at a time (CR 704.3), which is
 * what makes two creatures that dealt each other lethal damage die together instead of
 * the survivor being whichever the loop reached first.
 */

interface PendingActions {
  readonly losers: readonly PlayerId[];
  /** Permanents heading to their owner's graveyard, with the rule that sent them. */
  readonly destroyed: readonly { readonly id: ObjectId; readonly kind: SbaKind }[];
  /** Tokens that have left the battlefield and cease to exist. */
  readonly vanishing: readonly ObjectId[];
  /** Equipment that must stop being attached. */
  readonly unattaching: readonly ObjectId[];
  /** Objects whose +1/+1 and -1/-1 counters cancel out. */
  readonly annihilating: readonly ObjectId[];
}

const gather = (state: GameState): PendingActions => {
  const losers: PlayerId[] = [];
  const destroyed: { id: ObjectId; kind: SbaKind }[] = [];
  const vanishing: ObjectId[] = [];
  const unattaching: ObjectId[] = [];
  const annihilating: ObjectId[] = [];

  // CR 704.5a-c: the three ways a player loses without an effect saying so.
  for (const player of playerIds) {
    const seat = state.players[player];
    if (seat.life <= 0 || seat.drewFromEmptyLibrary || seat.poison >= 10) losers.push(player);
  }

  // CR 704.5e: a token anywhere but the battlefield ceases to exist.
  //
  // Walked by zone rather than over every object in the game. A library of thirty cards
  // and a graveyard of ten are most of `state.objects`, and this check runs on every
  // state-based action sweep — which is once per decision — to ask a question only a
  // token can answer yes to.
  for (const zone of tokenCanStrandIn) {
    for (const id of state.zones[zone]) {
      if (getObject(state, id).token) vanishing.push(id);
    }
  }

  for (const id of objectsIn(state, 'battlefield')) {
    const object = getObject(state, id);
    const traits = characteristicsOf(state, id);

    if (counterCount(object, '+1/+1') > 0 && counterCount(object, '-1/-1') > 0) {
      annihilating.push(id);
    }

    if (traits.isCreature) {
      // Zero toughness is not destruction, so indestructible does not save it (CR 704.5f).
      if ((traits.toughness ?? 0) <= 0) {
        destroyed.push({ id, kind: 'creatureZeroToughness' });
        continue;
      }
      if (!traits.keywords.indestructible) {
        if (object.deathtouched && object.damage > 0) {
          destroyed.push({ id, kind: 'creatureDeathtouched' });
          continue;
        }
        if (object.damage > 0 && remainingToughness(state, id) <= 0) {
          destroyed.push({ id, kind: 'creatureLethalDamage' });
          continue;
        }
      }
    }

    // CR 704.5i: a planeswalker with no loyalty counters goes to the graveyard.
    if (isPlaneswalker(state, id) && currentLoyalty(state, id) <= 0) {
      destroyed.push({ id, kind: 'planeswalkerZeroLoyalty' });
      continue;
    }

    // CR 704.5m/n: an aura attached to nothing legal dies; equipment merely falls off.
    if (object.attachment !== null) {
      const target = object.attachedTo === null ? null : state.objects.get(object.attachedTo);
      const illegal = target === undefined || target === null || target.zone !== 'battlefield';
      if (illegal) {
        if (object.attachment === 'aura') destroyed.push({ id, kind: 'auraIllegallyAttached' });
        else if (object.attachedTo !== null) unattaching.push(id);
      }
    }
  }

  return { losers, destroyed, vanishing, unattaching, annihilating };
};

/**
 * Where a token can be found outside the battlefield.
 *
 * It ceases to exist the moment it arrives, so this is only ever the zone it was just
 * moved to: a graveyard, exile, the stack for a copy, or a hand for a bounce. Never a
 * library — nothing shuffles a token in, because it stops existing on the way.
 */
const tokenCanStrandIn: readonly ZoneId[] = [
  'exile',
  'stack',
  'command',
  ...playerIds.flatMap((player): readonly ZoneId[] => [
    playerZone(player, 'graveyard'),
    playerZone(player, 'hand'),
  ]),
];

const isEmpty = (actions: PendingActions): boolean =>
  actions.losers.length === 0 &&
  actions.destroyed.length === 0 &&
  actions.vanishing.length === 0 &&
  actions.unattaching.length === 0 &&
  actions.annihilating.length === 0;

/**
 * Legendary permanents one player controls that share a name (CR 704.5j). The controller
 * chooses which to keep, so this needs a decision rather than a rule.
 */
export const legendGroups = (
  state: GameState,
): readonly {
  readonly player: PlayerId;
  readonly name: string;
  readonly objects: ObjectId[];
}[] => {
  const groups = new Map<string, { player: PlayerId; name: string; objects: ObjectId[] }>();

  for (const id of objectsIn(state, 'battlefield')) {
    const object = getObject(state, id);
    if (!object.legendary || object.name === null) continue;
    const key = `${object.controller}|${object.name}`;
    const group = groups.get(key);
    if (group) group.objects.push(id);
    else groups.set(key, { player: object.controller, name: object.name, objects: [id] });
  }

  return [...groups.values()].filter((group) => group.objects.length > 1);
};

const applyLosses = (
  state: GameState,
  emitter: EventEmitter,
  losers: readonly PlayerId[],
): GameState => {
  const loser = losers[0];
  const seat = loser === undefined ? undefined : state.players[loser];

  const reason = seat?.drewFromEmptyLibrary
    ? 'decked'
    : seat && seat.poison >= 10
      ? 'poison'
      : 'life';

  emitter.emit(state, { type: 'sba', kind: sbaKindForLoss(state, losers), objects: [] });
  // Both players losing at once is a draw (CR 104.4b).
  return playersLoseGame(state, emitter, losers, reason);
};

const sbaKindForLoss = (state: GameState, losers: readonly PlayerId[]): SbaKind => {
  const first = losers[0];
  if (first === undefined) return 'playerLosesLife';
  const seat = state.players[first];
  if (seat.drewFromEmptyLibrary) return 'playerDrewFromEmptyLibrary';
  if (seat.poison >= 10) return 'playerPoisoned';
  return 'playerLosesLife';
};

/**
 * Check and perform state-based actions until none apply (CR 704.3).
 *
 * Returns as soon as the game ends or a choice is needed, so the caller can hand the
 * decision to a player. The legend rule is the only one of these that asks anything.
 */
export const checkStateBasedActions = (
  state: GameState,
  emitter: EventEmitter,
  limit = 100,
): GameState => {
  let current = state;

  for (let pass = 0; pass < limit; pass += 1) {
    if (current.result !== null) return current;

    const actions = gather(current);

    if (actions.losers.length > 0) return applyLosses(current, emitter, actions.losers);

    if (isEmpty(actions)) {
      // Nothing mechanical left; the legend rule is all that can still apply.
      const groups = legendGroups(current);
      const group = groups[0];
      if (!group) return current;

      return updateState(current, {
        pendingDecision: {
          kind: 'chooseOption',
          player: group.player,
          reason: 'legendRule',
          options: group.objects,
        },
      });
    }

    current = applyActions(current, emitter, actions);

    // A replacement effect on one of the deaths may need a choice (CR 616.1); the batch
    // is paused and resumes once the player answers, which re-enters this loop.
    if (current.pendingDecision !== null) return current;
  }

  throw new Error(`state-based actions did not settle within ${limit} passes`);
};

const applyActions = (
  state: GameState,
  emitter: EventEmitter,
  actions: PendingActions,
): GameState => {
  let next = state;

  // Counters cancel one for one (CR 704.5q).
  for (const id of actions.annihilating) {
    const object = getObject(next, id);
    const plus = counterCount(object, '+1/+1');
    const minus = counterCount(object, '-1/-1');
    const cancelled = Math.min(plus, minus);
    const updated = withCounters(
      withCounters(object, '+1/+1', plus - cancelled),
      '-1/-1',
      minus - cancelled,
    );
    next = updateObject(next, id, { counters: updated.counters });
    emitter.emit(next, { type: 'sba', kind: 'counterAnnihilation', objects: [id] });
  }

  for (const id of actions.unattaching) {
    next = updateObject(next, id, { attachedTo: null });
    emitter.emit(next, { type: 'sba', kind: 'equipmentIllegallyAttached', objects: [id] });
  }

  for (const id of actions.vanishing) {
    next = destroyObject(next, id);
    emitter.emit(next, { type: 'sba', kind: 'tokenNotOnBattlefield', objects: [id] });
  }

  // Everything that dies, dies together — as one batch of proposed events, so that
  // replacement effects see them all and a regeneration shield can pull one back out.
  if (actions.destroyed.length === 0) return next;

  const events: MoveZoneEvent[] = [];
  for (const { id, kind } of actions.destroyed) {
    const object = getObject(next, id);
    emitter.emit(next, { type: 'sba', kind, objects: [id] });
    events.push({
      kind: 'moveZone',
      object: id,
      from: 'battlefield',
      to: playerZone(object.owner, 'graveyard'),
      cause: 'stateBasedAction',
      destruction: isDestruction(kind),
    });
  }

  return runBatch(next, emitter, { kind: 'plain' }, events);
};

/**
 * Which state-based actions *destroy* a permanent (CR 701.7) rather than merely putting
 * it somewhere. The distinction is what regeneration hangs on: lethal damage destroys, so
 * a shield saves the creature, but zero toughness and a planeswalker out of loyalty are
 * put into the graveyard directly and no shield applies (CR 704.5f, 704.5i).
 */
const isDestruction = (kind: SbaKind): boolean =>
  kind === 'creatureLethalDamage' || kind === 'creatureDeathtouched';

/** Answer the legend rule: keep `keep`, and the rest go to their owners' graveyards. */
export const applyLegendRule = (
  state: GameState,
  emitter: EventEmitter,
  options: readonly ObjectId[],
  keep: ObjectId,
): GameState => {
  if (!options.includes(keep)) {
    throw new Error(`object ${keep} is not one of the legendary permanents in question`);
  }

  const doomed = options.filter((id) => id !== keep);
  emitter.emit(state, { type: 'sba', kind: 'legendRule', objects: doomed });

  // Put into the graveyard rather than destroyed (CR 704.5j), so no shield saves them —
  // but "if it would be put into a graveyard, exile it instead" still applies.
  const events: MoveZoneEvent[] = doomed.map((id) => ({
    kind: 'moveZone',
    object: id,
    from: 'battlefield',
    to: playerZone(getObject(state, id).owner, 'graveyard'),
    cause: 'stateBasedAction',
    destruction: false,
  }));

  return runBatch(state, emitter, { kind: 'plain' }, events);
};
