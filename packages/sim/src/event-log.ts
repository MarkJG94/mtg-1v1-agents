import { identityOf } from '@mtg/engine';
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
  const named = new Set(played.objects.map((object) => object.id));
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
    // What each object was as an event first named it — abilities and tokens included,
    // which have ceased to exist by the end — then anything still in the game that no
    // event ever named, such as a card that sat in a library all game.
    objects: [
      ...played.objects,
      ...[...played.state.objects]
        .filter(([id]) => !named.has(id))
        .map(([, object]) => identityOf(object)),
    ],
    events: played.events,
    result: {
      winner: played.result.winner,
      reason: played.result.reason,
      turns: played.result.turn,
    },
  };
};
