import type { CardPoolQuery, DeckAgentInput, DeckCard } from '@mtg/agents';
import { type CardDefinition, createRng } from '@mtg/engine';
import {
  type AgentCounts,
  applyDeckChange,
  type BanAction,
  type BanEvent,
  type BanList,
  banListOf,
  banViolations,
  type Deck75,
  type DeckChange,
  emptyAgentCounts,
  type OracleId,
  type PlayerId,
  playerIds,
} from '@mtg/shared';
import { cardsIn } from './deck.js';
import type { AfterGame, DeckUpdate } from './match.js';
import { deckCardsFor } from './sideboard-cards.js';

/**
 * The run's ban list and its enforcement (docs/05 "Bans and restrictions"; roadmap 5.5).
 *
 * **`BanRegistry`** keeps the audit trail docs/06 stores in `ban_events`: every edit, who
 * asked for it and why, and after which game it took effect. An edit is asked for at any
 * time — the operator edits the list live — but takes effect only when the game in
 * progress ends, so a game is never played under two lists. Until then it is pending, and
 * the list everything else reads is the one the applied edits make.
 *
 * **`banEnforcer`** is what applies them: asked after every game, it applies whatever is
 * pending and, if that leaves a deck holding more of a card than the list allows,
 * legalises it with the deck agent — both decks, each on its own. The match in progress
 * goes on with the legalised decks, and the games already played still count. Unbanning
 * a card never changes a deck, since a legal deck stays legal.
 */

export class BanRegistry {
  private readonly events: BanEvent[];

  constructor(history: readonly BanEvent[] = []) {
    this.events = [...history];
  }

  /** Asks for an edit. It takes effect after the game in progress (`applyPending`). */
  request(
    oracleId: OracleId,
    action: BanAction,
    details: { readonly note?: string; readonly by: string; readonly at: string },
  ): void {
    this.events.push({
      oracleId,
      action,
      note: details.note ?? '',
      by: details.by,
      at: details.at,
      appliedAfterGameId: null,
    });
  }

  /** Edits asked for and not yet in effect, oldest first. */
  get pending(): readonly BanEvent[] {
    return this.events.filter((event) => event.appliedAfterGameId === null);
  }

  /** Every edit, applied or not, in the order asked for: the audit trail. */
  get history(): readonly BanEvent[] {
    return [...this.events];
  }

  /** The list in effect. */
  get list(): BanList {
    return banListOf(this.events);
  }

  /** Puts every pending edit into effect after `gameId`, and returns them. */
  applyPending(gameId: string): readonly BanEvent[] {
    const applied: BanEvent[] = [];
    this.events.forEach((event, index) => {
      if (event.appliedAfterGameId !== null) return;
      const done = { ...event, appliedAfterGameId: gameId };
      this.events[index] = done;
      applied.push(done);
    });
    return applied;
  }
}

/** What legalises a deck: the deck agent's `legalise`. */
export interface Legaliser {
  legalise(input: DeckAgentInput): Promise<DeckChange[]>;
}

export interface BanEnforcerOptions {
  readonly registry: BanRegistry;
  readonly agent: Legaliser;
  /** The pool replacements come from; it must hand back what it scripts. */
  readonly pool: CardPoolQuery & {
    definitions(): ReadonlyMap<OracleId, CardDefinition>;
  };
  /** Definitions of the cards already in play. */
  readonly definitions: () => ReadonlyMap<OracleId, CardDefinition>;
  /** Each deck's statistics, for ranking replacements; none if not given. */
  readonly counts?: (player: PlayerId) => AgentCounts;
  /** Legalising a deck after game `g` draws from `${seed}:${g}:${player}`. */
  readonly seed: string;
  /** Told of every edit that takes effect: the `banApplied` event docs/07 sends. */
  readonly onApplied?: (events: readonly BanEvent[]) => void;
}

/** The `afterGame` hook a match or cycle takes (see `MatchOptions.afterGame`). */
export const banEnforcer = (options: BanEnforcerOptions): AfterGame => {
  return async ({ gameId, decks }): Promise<DeckUpdate | null> => {
    if (options.registry.pending.length === 0) return null;
    const applied = options.registry.applyPending(gameId);
    options.onApplied?.(applied);
    const list = options.registry.list;

    const next: Record<PlayerId, Deck75> = { A: decks.A, B: decks.B };
    const changes: Record<PlayerId, DeckChange[]> = { A: [], B: [] };
    for (const player of playerIds) {
      if (banViolations(decks[player], list).length === 0) continue;
      const known = new Map([...options.definitions(), ...options.pool.definitions()]);
      const forced = await options.agent.legalise({
        deck: decks[player],
        cards: cardsOf(decks[player], known),
        counts: options.counts?.(player) ?? emptyAgentCounts,
        opponent: { seen: [], cards: new Map() },
        banList: list,
        pool: options.pool,
        rng: createRng(`${options.seed}:${gameId}:${player}`),
      });
      const legal = forced.reduce((deck, change) => applyDeckChange(deck, change), decks[player]);
      const [still] = banViolations(legal, list);
      if (still !== undefined) {
        throw new Error(
          `legalising ${player}'s deck left ${still.held} of ${still.oracleId}, which is ${still.status}`,
        );
      }
      next[player] = legal;
      changes[player] = forced;
    }
    if (changes.A.length === 0 && changes.B.length === 0) return null;
    return { decks: next, definitions: options.pool.definitions(), changes };
  };
};

const cardsOf = (
  deck: Deck75,
  known: ReadonlyMap<OracleId, CardDefinition>,
): ReadonlyMap<OracleId, DeckCard> =>
  deckCardsFor(
    [...cardsIn(deck).keys()].flatMap((oracleId) => {
      const definition = known.get(oracleId);
      return definition === undefined ? [] : [definition];
    }),
  );
