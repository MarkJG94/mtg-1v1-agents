import { type ObjectId, type PlayerId, playerZone, type ZoneId } from '@mtg/shared';
import { priorityDecision } from './decision.js';
import type { EventEmitter } from './events/emitter.js';
import type { GameState } from './state/game-state.js';
import { getObject, moveObject, objectsIn, updateObject, updateState } from './state/update.js';

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

  const stackProperties: StackProperties = {
    resolvesTo: options.resolvesTo ?? playerZone(object.owner, 'graveyard'),
    splitSecond: options.splitSecond ?? false,
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

/**
 * Resolve the top object on the stack (CR 608). It goes wherever its `resolvesTo` says:
 * the battlefield for a permanent spell, its owner's graveyard for an instant or sorcery.
 *
 * What a spell *does* on resolution is its card script, so that arrives with definitions
 * in roadmap 2.1. Fizzling — countering a spell on resolution because every target became
 * illegal (CR 608.2b) — needs targeting, which is 1.5.
 */
export const resolveTopOfStack = (state: GameState, emitter: EventEmitter): GameState => {
  const id = topOfStack(state);
  if (id === undefined) throw new IllegalStackActionError('the stack is empty');

  const object = getObject(state, id);
  const destination = object.stack?.resolvesTo ?? playerZone(object.owner, 'graveyard');

  emitter.emit(state, { type: 'resolve', object: id });
  const resolved = updateObject(moveObject(state, id, destination), id, { stack: undefined });
  emitter.emit(resolved, {
    type: 'moveZone',
    object: id,
    from: 'stack',
    to: destination,
    cause: 'resolve',
  });

  // A permanent entering the battlefield has summoning sickness until its controller's
  // next turn begins (CR 302.6).
  return destination === 'battlefield'
    ? updateObject(resolved, id, { summoningSick: true })
    : resolved;
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
  const countered = updateObject(moveObject(state, id, graveyard), id, { stack: undefined });
  emitter.emit(countered, { type: 'counter', object: id, by });
  emitter.emit(countered, {
    type: 'moveZone',
    object: id,
    from: 'stack',
    to: graveyard,
    cause: 'effect',
  });
  return countered;
};
