import { isMainPhase, type ObjectId, type PlayerId, playerZone } from '@mtg/shared';
import type { EventEmitter } from '../events/emitter.js';
import type { GameState } from '../state/game-state.js';
import { isGameOver } from '../state/game-state.js';
import { getObject, moveObject, objectsIn, updatePlayer } from '../state/update.js';

/**
 * Playing lands (CR 305).
 *
 * Playing a land is a special action: it uses no stack and cannot be responded to. A
 * player may do it during their own main phase while the stack is empty and they have
 * priority, and only as many times per turn as their land-drop allowance (CR 305.2,
 * normally once, raised by effects such as Exploration).
 *
 * What is *not* checked here is that the card is a land, because that is a characteristic
 * and characteristics need card definitions and the layer system (roadmap 2.1 and 1.9).
 * Until then the caller supplies a land; `legalActions` in roadmap 1.5 becomes the single
 * place that decides what may be played.
 */

export const landsRemainingThisTurn = (state: GameState, player: PlayerId): number =>
  Math.max(0, state.players[player].maxLandsPerTurn - state.players[player].landsPlayedThisTurn);

/** Whether the timing and the land-drop allowance both permit a land right now. */
export const canPlayLand = (state: GameState, player: PlayerId): boolean =>
  !isGameOver(state) &&
  state.activePlayer === player &&
  isMainPhase(state.step) &&
  objectsIn(state, 'stack').length === 0 &&
  landsRemainingThisTurn(state, player) > 0;

export class IllegalLandPlayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalLandPlayError';
  }
}

/** Put a land from a player's hand onto the battlefield and spend their land drop. */
export const playLand = (
  state: GameState,
  emitter: EventEmitter,
  player: PlayerId,
  id: ObjectId,
): GameState => {
  if (!canPlayLand(state, player)) {
    throw new IllegalLandPlayError(
      `${player} cannot play a land in turn ${state.turn} ${state.step} ` +
        `(${landsRemainingThisTurn(state, player)} land drop(s) left)`,
    );
  }

  const hand = playerZone(player, 'hand');
  const object = getObject(state, id);
  if (object.zone !== hand) {
    throw new IllegalLandPlayError(`object ${id} is in ${object.zone}, not ${player}'s hand`);
  }

  const played = updatePlayer(moveObject(state, id, 'battlefield'), player, {
    landsPlayedThisTurn: state.players[player].landsPlayedThisTurn + 1,
  });
  emitter.emit(played, { type: 'playLand', player, object: id });
  return played;
};
