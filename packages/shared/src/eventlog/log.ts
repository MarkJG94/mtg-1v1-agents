import type { PlayerId } from '../game/player.js';
import type { GameEndReason } from '../game/result.js';
import type { GameId, OracleId } from '../ids.js';
import type { EventLogObject, GameEvent } from './events.js';

/** One card name and how many copies of it a deck holds. */
export interface DeckSlot {
  readonly oracleId: OracleId;
  readonly count: number;
}

export interface EventLogPlayer {
  /** Which generation of this agent's lineage played the game. */
  readonly deckGeneration: number;
  readonly main: readonly DeckSlot[];
  readonly side: readonly DeckSlot[];
}

/**
 * A complete game, replayable on its own (docs/06 "Event log format").
 *
 * `seed` plus the recorded decisions is enough to re-derive the whole game in the
 * engine; `events` plus `objects` is enough to render it without the engine at all.
 */
export interface GameEventLog {
  readonly version: number;
  readonly gameId: GameId;
  /**
   * The seed the game was played from: the label its generator was made from, derived
   * from the run's seed (`${run}:match-3:game-2`), not the run's decimal seed itself.
   */
  readonly seed: string;
  readonly players: Readonly<Record<PlayerId, EventLogPlayer>>;
  /** Object id → identity, so a replay needs no card lookups. */
  readonly objects: readonly EventLogObject[];
  readonly events: readonly GameEvent[];
  readonly result: {
    readonly winner: PlayerId | null;
    readonly reason: GameEndReason;
    readonly turns: number;
  };
}

/** Events belonging to one turn, for the UI's timeline. */
export const eventsByTurn = (log: GameEventLog): Map<number, GameEvent[]> => {
  const byTurn = new Map<number, GameEvent[]>();
  for (const event of log.events) {
    const bucket = byTurn.get(event.turn);
    if (bucket) bucket.push(event);
    else byTurn.set(event.turn, [event]);
  }
  return byTurn;
};
