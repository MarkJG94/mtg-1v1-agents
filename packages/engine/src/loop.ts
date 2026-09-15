import { allZoneIds, playerIds } from '@mtg/shared';
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

/**
 * A 53-bit hash of a state, as two independent FNV-1a passes combined.
 *
 * A 32-bit hash is not enough. Two hundred states in a turn collide with probability
 * about one in two hundred thousand, and a collision here is a game wrongly called a
 * draw. At 53 bits — every integer JavaScript can hold exactly — the same figure is
 * around one in a hundred billion, which is smaller than the chance of the machine
 * getting the arithmetic wrong.
 */
export const hashState = (state: GameState): number => {
  let a = 0x811c9dc5;
  let b = 0x01000193;

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

  const num = (value: number): void => mix(String(value));

  num(state.turn);
  mix(state.step);
  mix(state.activePlayer);
  mix(state.priority ?? '-');
  num(state.passesInARow);
  for (const word of state.rng) num(word);

  for (const player of playerIds) {
    const seat = state.players[player];
    num(seat.life);
    num(seat.poison);
    num(seat.landsPlayedThisTurn);
    num(seat.maxLandsPerTurn);
    mix(seat.drewFromEmptyLibrary ? '1' : '0');
    num(seat.manaPool.length);
    for (const unit of seat.manaPool) {
      mix(unit.type);
      mix(unit.snow ? 's' : '-');
      mix(unit.restriction ?? '-');
    }
  }

  for (const zone of allZoneIds) {
    mix(zone);
    for (const id of state.zones[zone]) {
      num(id);
      const object = state.objects.get(id);
      if (!object) continue;
      mix(object.controller);
      mix(object.tapped ? 't' : '-');
      num(object.damage);
      mix(object.deathtouched ? 'd' : '-');
      mix(object.summoningSick ? 's' : '-');
      num(object.attachedTo ?? -1);
      // Counter kinds are sorted so two equal states cannot differ by insertion order.
      for (const kind of Object.keys(object.counters).sort()) {
        mix(kind);
        num(object.counters[kind] ?? 0);
      }
      mix(object.stack?.abilityId ?? '-');
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
  mix(state.pendingDecision?.kind ?? '-');

  // Two 32-bit words into one exact integer: the low 21 bits of `b` on top of all of `a`.
  return a + (b % 0x200000) * 0x100000000;
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
