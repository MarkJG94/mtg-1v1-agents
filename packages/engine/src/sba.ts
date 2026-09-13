import { type ObjectId, type PlayerId, playerIds, playerZone, type SbaKind } from '@mtg/shared';
import {
  counterCount,
  currentLoyalty,
  effectiveToughness,
  isCreature,
  isPlaneswalker,
  remainingToughness,
} from './characteristics.js';
import type { EventEmitter } from './events/emitter.js';
import type { GameState } from './state/game-state.js';
import { withCounters } from './state/object.js';
import {
  destroyObject,
  getObject,
  moveObject,
  objectsIn,
  updateObject,
  updateState,
} from './state/update.js';
import { queueTriggers, triggersFromZoneChange } from './triggers.js';

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
  for (const [id, object] of state.objects) {
    if (object.token && object.zone !== 'battlefield') vanishing.push(id);
  }

  for (const id of objectsIn(state, 'battlefield')) {
    const object = getObject(state, id);

    if (counterCount(object, '+1/+1') > 0 && counterCount(object, '-1/-1') > 0) {
      annihilating.push(id);
    }

    if (isCreature(object)) {
      // Zero toughness is not destruction, so indestructible does not save it (CR 704.5f).
      if (effectiveToughness(object) <= 0) {
        destroyed.push({ id, kind: 'creatureZeroToughness' });
        continue;
      }
      if (!object.keywords.indestructible) {
        if (object.deathtouched && object.damage > 0) {
          destroyed.push({ id, kind: 'creatureDeathtouched' });
          continue;
        }
        if (object.damage > 0 && remainingToughness(object) <= 0) {
          destroyed.push({ id, kind: 'creatureLethalDamage' });
          continue;
        }
      }
    }

    // CR 704.5i: a planeswalker with no loyalty counters goes to the graveyard.
    if (isPlaneswalker(object) && currentLoyalty(object) <= 0) {
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
  // Both players losing at once is a draw (CR 104.4b).
  const winner =
    losers.length === playerIds.length
      ? null
      : (playerIds.find((p) => !losers.includes(p)) ?? null);
  const loser = losers[0];
  const seat = loser === undefined ? undefined : state.players[loser];

  const reason = seat?.drewFromEmptyLibrary
    ? 'decked'
    : seat && seat.poison >= 10
      ? 'poison'
      : 'life';

  emitter.emit(state, { type: 'sba', kind: sbaKindForLoss(state, losers), objects: [] });
  const ended = updateState(state, {
    result: { winner, reason, turn: state.turn },
    pendingDecision: null,
  });
  emitter.emit(ended, { type: 'gameEnd', winner, reason });
  return ended;
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

  // Everything that dies, dies together.
  for (const { id, kind } of actions.destroyed) {
    const object = getObject(next, id);
    const graveyard = playerZone(object.owner, 'graveyard');

    // Capture what died before it leaves: a dies trigger has to remember the creature as
    // it last was on the battlefield (CR 603.10).
    const fired = triggersFromZoneChange(next, id, object, 'dies');

    next = queueTriggers(moveObject(next, id, graveyard), fired);
    emitter.emit(next, { type: 'sba', kind, objects: [id] });
    emitter.emit(next, {
      type: 'moveZone',
      object: id,
      from: 'battlefield',
      to: graveyard,
      cause: 'stateBasedAction',
    });
  }

  for (const id of actions.vanishing) {
    next = destroyObject(next, id);
    emitter.emit(next, { type: 'sba', kind: 'tokenNotOnBattlefield', objects: [id] });
  }

  return next;
};

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

  let next = state;
  const doomed = options.filter((id) => id !== keep);
  for (const id of doomed) {
    const object = getObject(next, id);
    const graveyard = playerZone(object.owner, 'graveyard');
    next = moveObject(next, id, graveyard);
    emitter.emit(next, {
      type: 'moveZone',
      object: id,
      from: 'battlefield',
      to: graveyard,
      cause: 'stateBasedAction',
    });
  }
  emitter.emit(next, { type: 'sba', kind: 'legendRule', objects: doomed });
  return next;
};
