import { allZoneIds, type PlayerId, playerIds } from '@mtg/shared';
import type { GameState } from './state/game-state.js';

/**
 * Loop detection (CR 726) and the decision cap.
 *
 * Magic can reach positions that repeat forever with neither player able to stop it. The
 * tournament rules call those draws, and docs/02 asks for the same: a state that repeats
 * within a turn is a loop, and the game ends in a draw.
 *
 * The whole difficulty is avoiding false positives. A draw declared by mistake is a
 * silently wrong result, not a crash, so the projection below has to cover *everything*
 * that makes two positions different — including the things that look like bookkeeping,
 * such as how many players have passed in a row and where the random number generator
 * has got to. If any of that differs, the game has moved on and there is no loop.
 *
 * Erring the other way is cheap: a loop the projection cannot see just runs until the
 * decision cap, which ends the same game as the same kind of draw.
 */

/** Seat number, so a player mixes as one integer instead of a string. */
const seatIndex = (player: PlayerId): number => playerIds.indexOf(player);

/** Murmur3's finaliser: cheap, and gives each pass proper avalanche. */
const fmix32 = (value: number): number => {
  let x = value >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
};

/**
 * A 53-bit hash of a state, as two independent passes combined.
 *
 * A 32-bit hash is not enough. Two hundred states in a turn collide with probability
 * about one in two hundred thousand, and a collision here is a game wrongly called a
 * draw. At 53 bits — every integer JavaScript can hold exactly — the same figure is
 * around one in a hundred billion, which is smaller than the chance of the machine
 * getting the arithmetic wrong.
 *
 * This runs at every decision point over every object in every zone, which makes it the
 * engine's hottest function by a distance: the 1.14 benchmarks found nine tenths of a
 * game's time in here. That is why numbers are mixed as numbers — `String(value)` and a
 * walk over its digits was most of that time — and why each object's flags are packed
 * into one integer rather than mixed one at a time.
 *
 * *What* is hashed has not changed, because that is the part correctness rests on: a
 * field left out is two different positions that hash alike, and so a game called a draw
 * while it was still going.
 */
/**
 * The two passes in progress. Module-level rather than local to `hashState` so that the
 * mixers below are plain functions instead of closures rebuilt on every call, which is
 * worth about a third of the time here. Nothing observes them: `hashState` sets them,
 * runs to completion synchronously, and reads the answer out.
 */
let a = 0;
let b = 0;

/** One integer into both passes. Every number in a state is a small integer. */
const num = (value: number): void => {
  a = Math.imul(a ^ value, 0x01000193) >>> 0;
  b = Math.imul(b ^ (value + 0x9e3779b9), 0x85ebca6b) >>> 0;
};

const mix = (value: string): void => {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x85ebca6b) >>> 0;
  }
  // A separator, so that ["ab","c"] and ["a","bc"] are not the same hash.
  a = Math.imul(a ^ 0x1f, 0x01000193) >>> 0;
  b = Math.imul(b ^ 0x1f, 0x85ebca6b) >>> 0;
};

const player = (value: PlayerId | null): void => num(value === null ? 0 : seatIndex(value) + 1);

export const hashState = (state: GameState): number => {
  a = 0x811c9dc5;
  b = 0x01000193;

  num(state.turn);
  mix(state.step);
  player(state.activePlayer);
  player(state.priority);
  num(state.passesInARow);
  for (const word of state.rng) num(word);

  for (const seat of playerIds) {
    const values = state.players[seat];
    num(values.life);
    num(values.poison);
    num(values.landsPlayedThisTurn);
    num(values.maxLandsPerTurn);
    num(values.drewFromEmptyLibrary ? 1 : 0);
    num(values.manaPool.length);
    for (const unit of values.manaPool) {
      mix(unit.type);
      num(unit.snow ? 1 : 0);
      mix(unit.restriction ?? '-');
    }
  }

  for (let z = 0; z < allZoneIds.length; z += 1) {
    const zone = allZoneIds[z];
    if (zone === undefined) continue;
    num(z);
    for (const id of state.zones[zone]) {
      num(id);
      const object = state.objects.get(id);
      if (!object) continue;
      // Everything about the object that is a yes or no, in one integer.
      num(
        (object.tapped ? 1 : 0) |
          (object.deathtouched ? 2 : 0) |
          (object.summoningSick ? 4 : 0) |
          (seatIndex(object.controller) << 3),
      );
      num(object.damage);
      num(object.attachedTo ?? -1);
      const kinds = Object.keys(object.counters);
      if (kinds.length > 0) {
        // Counter kinds are sorted so two equal states cannot differ by insertion order.
        for (const kind of kinds.sort()) {
          mix(kind);
          num(object.counters[kind] ?? 0);
        }
      }
      mix(object.stack?.abilityId ?? '-');
    }
  }

  /*
   * Combat, which the 1.14 benchmarks caught this projection missing.
   *
   * Ordering blockers for one attacker changes nothing else about the position, so
   * without this a turn with two attackers each blocked by two creatures looked like a
   * position repeating and the game was called a draw — 36% of the benchmark's wider
   * boards. Blockers are mixed in order, because the order *is* the decision (CR 509.2).
   */
  if (state.combat === null) {
    num(-1);
  } else {
    num(state.combat.attackers.length);
    num(state.combat.firstStrikeDone ? 1 : 0);
    for (const attack of state.combat.attackers) {
      num(attack.attacker);
      num((attack.blocked ? 1 : 0) | (attack.orderSettled ? 2 : 0));
      if (attack.defender.kind === 'player') {
        player(attack.defender.player);
      } else {
        num(attack.defender.object);
      }
      num(attack.blockedBy.length);
      for (const blocker of attack.blockedBy) num(blocker);
    }
  }

  // The things a later phase can change under our feet: effects in force, triggers
  // waiting, and how far through a replacement batch the game is.
  num(state.effects.length);
  for (const effect of state.effects) num(effect.id);
  num(state.replacements.length);
  for (const effect of state.replacements) {
    num(effect.id);
    mix(JSON.stringify(effect.change));
  }
  num(state.pendingTriggers.length);
  for (const trigger of state.pendingTriggers) mix(trigger.abilityId);
  num(state.delayedTriggers.length);
  num(state.extraTurns.length);
  num(state.loyaltyActivatedThisTurn.length);
  num(state.triggersFiredThisTurn.length);
  // A batch paused part-way is a different position from the same batch a step further
  // on, and the only thing that separates them is how much of it is left.
  if (state.pendingReplacement === null) {
    num(-1);
  } else {
    num(state.pendingReplacement.resolved.length);
    num(state.pendingReplacement.queue.length);
    num(state.pendingReplacement.options.length);
    player(state.pendingReplacement.player);
  }
  mix(state.pendingDecision?.kind ?? '-');

  // Two 32-bit words into one exact integer: the low 21 bits of `b` on top of all of `a`.
  return fmix32(a) + (fmix32(b) % 0x200000) * 0x100000000;
};

/**
 * Whether this state has already happened this turn. The caller records states as they
 * are reached; a repeat means nothing has changed and nothing will (CR 726).
 */
export const isRepeatedState = (state: GameState, hash: number): boolean =>
  state.statesThisTurn.includes(hash);

/** Record a state as seen this turn. */
export const rememberState = (state: GameState, hash: number): readonly number[] => [
  ...state.statesThisTurn,
  hash,
];
