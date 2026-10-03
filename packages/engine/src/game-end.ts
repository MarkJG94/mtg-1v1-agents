import { type GameEndReason, opponentOf, type PlayerId, playerIds } from '@mtg/shared';
import type { EventEmitter } from './events/emitter.js';
import type { GameState } from './state/game-state.js';
import { updateState } from './state/update.js';

/**
 * Ending a game (CR 104).
 *
 * A game ends the moment somebody wins or loses, and there are more ways than the
 * state-based actions in `sba.ts`: a player can concede at any time (CR 104.3a), an
 * effect can say a player wins or loses outright (CR 104.3b, 104.2b), and the game can
 * run out of our own patience — the turn cap, the decision cap and loop detection are all
 * draws by house rule rather than by the Comprehensive Rules.
 *
 * Everything funnels through `endGame` so that however a game finishes it records the
 * same shape of result and emits the same event. Nothing else writes `state.result`.
 */

/**
 * End the game. `winner` is `null` for a draw (CR 104.4).
 *
 * Also clears any pending decision: once the game is over nobody is waiting on anything,
 * and a driver that kept answering would be answering a decision that no longer exists.
 */
export const endGame = (
  state: GameState,
  emitter: EventEmitter,
  winner: PlayerId | null,
  reason: GameEndReason,
): GameState => {
  // The first ending wins. A second one cannot change the result, and quietly overwriting
  // it would lose the reason the game actually finished.
  if (state.result !== null) return state;

  const ended = updateState(state, {
    result: { winner, reason, turn: state.turn },
    pendingDecision: null,
  });
  emitter.emit(ended, { type: 'gameEnd', winner, reason });
  return ended;
};

/**
 * A player concedes (CR 104.3a). They leave the game immediately, at any time, even
 * without priority — conceding is the one thing a player may always do.
 */
export const concede = (state: GameState, emitter: EventEmitter, player: PlayerId): GameState =>
  endGame(state, emitter, opponentOf(player), 'concede');

/**
 * An effect makes a player lose the game (CR 104.3b), such as Phage or a Door to
 * Nothingness. Distinct from losing to a state-based action, which records why.
 */
export const playerLosesGame = (
  state: GameState,
  emitter: EventEmitter,
  player: PlayerId,
): GameState => endGame(state, emitter, opponentOf(player), 'effect');

/** An effect makes a player win the game outright (CR 104.2b). */
export const playerWinsGame = (
  state: GameState,
  emitter: EventEmitter,
  player: PlayerId,
): GameState => endGame(state, emitter, player, 'effect');

/**
 * Several players lose at once, which in a two-player game is a draw (CR 104.4b). The
 * state-based actions use this: two players at zero life die together, not in whatever
 * order a loop happened to visit them.
 */
export const playersLoseGame = (
  state: GameState,
  emitter: EventEmitter,
  losers: readonly PlayerId[],
  reason: GameEndReason,
): GameState => {
  const winner =
    losers.length >= playerIds.length
      ? null
      : (playerIds.find((player) => !losers.includes(player)) ?? null);
  return endGame(state, emitter, winner, reason);
};

/** A draw by one of our own limits: the turn cap, the decision cap, or a detected loop. */
export const drawGame = (
  state: GameState,
  emitter: EventEmitter,
  reason: Extract<GameEndReason, 'turnCap' | 'decisionCap' | 'loop'>,
): GameState => endGame(state, emitter, null, reason);
