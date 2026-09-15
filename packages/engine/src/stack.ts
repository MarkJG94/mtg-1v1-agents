import {
  type Colour,
  type EventTarget,
  type ObjectId,
  type OracleId,
  type PlayerId,
  playerZone,
  type ZoneId,
} from '@mtg/shared';
import { priorityDecision } from './decision.js';
import type { EventEmitter } from './events/emitter.js';
import { runEvent } from './events/perform.js';
import type { GameState } from './state/game-state.js';
import {
  createObject,
  destroyObject,
  getObject,
  moveObject,
  objectsIn,
  updateObject,
  updateState,
} from './state/update.js';
import { canBeTargeted, type TargetSource } from './targeting.js';

/**
 * The stack (CR 405).
 *
 * Per ADR 0002 the stack *is* the `stack` zone, ordered bottom to top, so the last element
 * of the zone array is the top. What a spell needs while it waits there — where it goes
 * when it resolves, whether it has split second — lives on the object itself.
 */

export interface StackProperties {
  /**
   * Where the object goes when it resolves. A permanent spell becomes a permanent on the
   * battlefield (CR 608.3); an instant or sorcery goes to its owner's graveyard
   * (CR 608.2m). Which of those applies is a card characteristic, so until card
   * definitions arrive in roadmap 2.1 the caster states it.
   */
  readonly resolvesTo: ZoneId;
  /** CR 702.61: while this is on the stack, nothing else can be cast or activated. */
  readonly splitSecond: boolean;
  /** What the spell targets (CR 115). Empty for a spell that targets nothing. */
  readonly targets: readonly EventTarget[];
  /** The spell's own colours, which decide what protection stops it. */
  readonly colours: readonly Colour[];
  /**
   * True for a triggered or activated ability. An ability is not a card: when it
   * finishes resolving it simply ceases to exist rather than going to a graveyard
   * (CR 608.2m), which is why resolution has to tell them apart.
   */
  readonly isAbility?: boolean;
  /** Which ability of its source this is, for the card script that supplies behaviour. */
  readonly abilityId?: string;
}

/** The object on top of the stack, or undefined when the stack is empty. */
export const topOfStack = (state: GameState): ObjectId | undefined =>
  objectsIn(state, 'stack').at(-1);

export const isStackEmpty = (state: GameState): boolean => objectsIn(state, 'stack').length === 0;

/**
 * Whether a split-second spell is waiting to resolve (CR 702.61a). While one is, players
 * may not cast spells or activate abilities that are not mana abilities.
 */
export const splitSecondActive = (state: GameState): boolean =>
  objectsIn(state, 'stack').some((id) => getObject(state, id).stack?.splitSecond === true);

export class IllegalStackActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalStackActionError';
  }
}

export interface PutOnStackOptions {
  /** Defaults to the owner's graveyard, which is where instants and sorceries go. */
  readonly resolvesTo?: ZoneId;
  readonly splitSecond?: boolean;
  /** Chosen targets; each is checked for legality as the spell is cast (CR 601.2c). */
  readonly targets?: readonly EventTarget[];
  readonly colours?: readonly Colour[];
}

/**
 * Put a card from a player's hand onto the stack as a spell (CR 601.2a).
 *
 * Costs are not paid here: choosing targets and modes, and paying, are the rest of
 * CR 601.2 and need card definitions (roadmap 2.1) and targeting (1.5). What this does
 * own is the part that is purely stack mechanics — the object moves to the stack, and the
 * caster gets priority back (CR 117.3c).
 */
export const putOnStack = (
  state: GameState,
  emitter: EventEmitter,
  player: PlayerId,
  id: ObjectId,
  options: PutOnStackOptions = {},
): GameState => {
  if (state.priority !== player) {
    throw new IllegalStackActionError(`${player} does not have priority`);
  }
  if (splitSecondActive(state)) {
    throw new IllegalStackActionError(
      'a spell with split second is on the stack, so nothing else can be cast (CR 702.61a)',
    );
  }

  const object = getObject(state, id);
  const hand = playerZone(player, 'hand');
  if (object.zone !== hand) {
    throw new IllegalStackActionError(`object ${id} is in ${object.zone}, not ${player}'s hand`);
  }

  const targets = options.targets ?? [];
  const colours = options.colours ?? [];
  const source: TargetSource = { controller: player, colours };

  // Targets are chosen as the spell is cast and must be legal then (CR 601.2c).
  for (const target of targets) {
    const legality = canBeTargeted(state, target, source);
    if (!legality.legal) {
      throw new IllegalStackActionError(
        `${describeTarget(target)} cannot be targeted by ${player}'s spell (${legality.reason})`,
      );
    }
  }

  const stackProperties: StackProperties = {
    resolvesTo: options.resolvesTo ?? playerZone(object.owner, 'graveyard'),
    splitSecond: options.splitSecond ?? false,
    targets,
    colours,
  };

  const moved = updateObject(moveObject(state, id, 'stack'), id, { stack: stackProperties });
  emitter.emit(moved, { type: 'cast', player, object: id, targets: [] });
  emitter.emit(moved, { type: 'putOnStack', object: id });

  // The caster receives priority again (CR 117.3c), and the pass count restarts because
  // a spell went on the stack. Handing priority back here rather than leaving the caller
  // to do it keeps the state always answerable.
  return updateState(moved, {
    passesInARow: 0,
    priority: player,
    pendingDecision: priorityDecision(player),
  });
};

const describeTarget = (target: EventTarget): string =>
  target.kind === 'player' ? `player ${target.player}` : `object ${target.object}`;

/**
 * Whether every target a spell chose has since become illegal (CR 608.2b). A spell with
 * no targets never fizzles; one that keeps even a single legal target still resolves, and
 * simply does nothing to the targets it lost.
 */
export const hasFizzled = (state: GameState, id: ObjectId): boolean => {
  const object = getObject(state, id);
  const stack = object.stack;
  if (!stack || stack.targets.length === 0) return false;

  const source: TargetSource = { controller: object.controller, colours: stack.colours };
  return stack.targets.every((target) => !canBeTargeted(state, target, source).legal);
};

/**
 * Resolve the top object on the stack (CR 608). It goes wherever its `resolvesTo` says:
 * the battlefield for a permanent spell, its owner's graveyard for an instant or sorcery.
 *
 * A spell all of whose targets have become illegal does not resolve at all: it is
 * countered by the rules (CR 608.2b), which players call fizzling.
 *
 * Leaving the stack is a proposed event like any other, so replacement effects get their
 * say: a permanent's own "this enters tapped" (CR 614.1c) applies here, as does a
 * graveyard replacement on an instant that has finished resolving. Because such an effect
 * can need a choice, this may return a state waiting on a decision, with the object still
 * on the stack until the batch finishes.
 *
 * What a spell *does* on resolution is its card script, so that arrives with definitions
 * in roadmap 2.1.
 */
export const resolveTopOfStack = (state: GameState, emitter: EventEmitter): GameState => {
  const id = topOfStack(state);
  if (id === undefined) throw new IllegalStackActionError('the stack is empty');

  if (hasFizzled(state, id)) return fizzle(state, emitter, id);

  const object = getObject(state, id);

  // An ability leaves the game entirely rather than going anywhere (CR 608.2m).
  if (object.stack?.isAbility === true) {
    emitter.emit(state, { type: 'resolve', object: id });
    return destroyObject(state, id);
  }

  const destination = object.stack?.resolvesTo ?? playerZone(object.owner, 'graveyard');

  emitter.emit(state, { type: 'resolve', object: id });
  const cleared = updateObject(state, id, { stack: undefined });

  if (destination === 'battlefield') {
    return runEvent(cleared, emitter, {
      kind: 'entersBattlefield',
      object: id,
      from: 'stack',
      tapped: false,
      // A planeswalker arrives with loyalty counters equal to its printed loyalty
      // (CR 306.5b). Seeding them into the event rather than setting them afterwards is
      // what lets a Doubling Season see them, since that is a replacement effect.
      counters: object.loyalty === null ? {} : { loyalty: object.loyalty },
    });
  }

  return runEvent(cleared, emitter, {
    kind: 'moveZone',
    object: id,
    from: 'stack',
    to: destination,
    cause: 'resolve',
    destruction: false,
  });
};

/**
 * A spell whose targets have all become illegal is countered on resolution (CR 608.2b).
 * It never resolves, so it does nothing at all.
 */
const fizzle = (state: GameState, emitter: EventEmitter, id: ObjectId): GameState => {
  const object = getObject(state, id);
  const graveyard = playerZone(object.owner, 'graveyard');

  emitter.emit(state, {
    type: 'fizzle',
    object: id,
    reason: 'every target is now illegal',
  });
  return runEvent(updateObject(state, id, { stack: undefined }), emitter, {
    kind: 'moveZone',
    object: id,
    from: 'stack',
    to: graveyard,
    cause: 'effect',
    destruction: false,
  });
};

/**
 * Counter an object on the stack (CR 701.5): it leaves the stack for its owner's
 * graveyard without resolving, so it never does what it says.
 */
export const counterObject = (
  state: GameState,
  emitter: EventEmitter,
  id: ObjectId,
  by: ObjectId,
): GameState => {
  const object = getObject(state, id);
  if (object.zone !== 'stack') {
    throw new IllegalStackActionError(`object ${id} is in ${object.zone}, not on the stack`);
  }

  const graveyard = playerZone(object.owner, 'graveyard');
  const cleared = updateObject(state, id, { stack: undefined });
  emitter.emit(cleared, { type: 'counter', object: id, by });
  return runEvent(cleared, emitter, {
    kind: 'moveZone',
    object: id,
    from: 'stack',
    to: graveyard,
    cause: 'effect',
    destruction: false,
  });
};

/** Identifies an ability being put on the stack as an object in its own right. */
export interface AbilityOnStack {
  readonly abilityId: string;
  readonly source: ObjectId;
  readonly controller: PlayerId;
  readonly definitionId: OracleId;
}

/**
 * An ability becomes an object on the stack (CR 113.7), controlled by the ability's
 * controller and destroyed rather than buried when it resolves (CR 608.2m).
 */
const createAbilityOnStack = (
  state: GameState,
  ability: AbilityOnStack,
): { readonly state: GameState; readonly id: ObjectId } => {
  const created = createObject(state, {
    definitionId: ability.definitionId,
    owner: ability.controller,
    controller: ability.controller,
    zone: 'stack',
  });

  return {
    state: updateObject(created.state, created.object.id, {
      stack: {
        resolvesTo: 'exile',
        splitSecond: false,
        targets: [],
        colours: [],
        isAbility: true,
        abilityId: ability.abilityId,
      },
    }),
    id: created.object.id,
  };
};

/** Put a triggered ability on the stack (CR 603.3). */
export const putTriggerOnStack = (
  state: GameState,
  emitter: EventEmitter,
  trigger: AbilityOnStack,
): GameState => {
  const { state: next, id } = createAbilityOnStack(state, trigger);
  emitter.emit(next, {
    type: 'trigger',
    controller: trigger.controller,
    source: trigger.source,
    abilityIndex: 0,
  });
  emitter.emit(next, { type: 'putOnStack', object: id });
  return next;
};

/**
 * Put an activated ability on the stack (CR 602.2), and hand priority back to the player
 * who activated it (CR 117.3c) — the same shape as casting a spell, so a driver is never
 * left holding a state with nothing to answer.
 */
export const putActivatedAbilityOnStack = (
  state: GameState,
  emitter: EventEmitter,
  ability: AbilityOnStack,
): GameState => {
  const { state: created, id } = createAbilityOnStack(state, ability);
  emitter.emit(created, {
    type: 'activate',
    player: ability.controller,
    source: ability.source,
    abilityIndex: 0,
    targets: [],
  });
  emitter.emit(created, { type: 'putOnStack', object: id });

  return updateState(created, {
    passesInARow: 0,
    priority: ability.controller,
    pendingDecision: priorityDecision(ability.controller),
  });
};
