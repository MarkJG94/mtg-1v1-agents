import {
  asGameId,
  CURRENT_EVENT_LOG_VERSION,
  type DeckSlot,
  type GameEventLog,
  type PlayerId,
} from '@mtg/shared';
import type { PlayedGame } from './game.js';

/**
 * A played game as an event log (docs/06 "Event log format"; roadmap 5.2): everything
 * the engine emitted, a header saying what each object id is, and which deck each player
 * brought. It is what the statistics are read from, and what a replay would render.
 */

export interface LoggedPlayer {
  /** Which generation of this player's deck lineage played the game. */
  readonly generation: number;
  /** The sixty it played with, which in game 3 of a match is the sideboarded sixty. */
  readonly main: readonly DeckSlot[];
  readonly side: readonly DeckSlot[];
}

export class UnfinishedGameError extends Error {
  constructor(gameId: string) {
    super(`game ${gameId} has no result, so it has no log`);
    this.name = 'UnfinishedGameError';
  }
}

export const eventLogOf = (input: {
  readonly gameId: string;
  readonly seed: string;
  readonly played: PlayedGame;
  readonly players: Readonly<Record<PlayerId, LoggedPlayer>>;
}): GameEventLog => {
  const { played } = input;
  if (played.result === null) throw new UnfinishedGameError(input.gameId);
  const player = (logged: LoggedPlayer) => ({
    deckGeneration: logged.generation,
    main: logged.main,
    side: logged.side,
  });
  return {
    version: CURRENT_EVENT_LOG_VERSION,
    gameId: asGameId(input.gameId),
    seed: input.seed,
    players: { A: player(input.players.A), B: player(input.players.B) },
    // An object keeps its id wherever it goes in this engine, so the final table names
    // every card that was ever in the game.
    objects: [...played.state.objects].map(([id, object]) => ({
      id,
      oracleId: object.definitionId,
      owner: object.owner,
      ...(object.token ? { token: true } : {}),
    })),
    events: played.events,
    result: {
      winner: played.result.winner,
      reason: played.result.reason,
      turns: played.result.turn,
    },
  };
};
