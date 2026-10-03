import type { OracleId } from './ids.js';

/**
 * The evolution loop's statistics (docs/05 "Statistics"; roadmap 5.2).
 *
 * What is stored is **counts**, never rates: how many games a card was drawn in and how
 * many of those were won, how many times it was cast, and so on. Counts add, so a cycle's
 * statistics are the sum of its games', and the roll-up across cycles is a weighted sum
 * of theirs — which is how exponential decay is done without keeping every game. Rates
 * are worked out from counts when they are read, and shrunk toward the deck's own rate so
 * that three wins in three draws is a hint and not a verdict.
 *
 * The aggregator that reads event logs into these lives in `@mtg/sim`; the types live
 * here because the deck agent (roadmap 5.4) reads them from `@mtg/agents`.
 */

export interface Tally {
  readonly games: number;
  readonly wins: number;
}

/** One card, over the games its deck played with it in the main deck. */
export interface CardCounts {
  /** Games the card was in the main deck for. */
  readonly games: number;
  /** Games it was in hand at some point after the hand was kept, and the wins among them. */
  readonly drawn: Tally;
  readonly notDrawn: Tally;
  /** Of the games drawn, those it was cast (or, for a land, played) in at least once. */
  readonly cast: number;
  /** Games that ended with a copy still in hand, never cast. */
  readonly deadInHand: number;
  /** Sum of the turn — the player's own turn count — of its first cast, and how many. */
  readonly firstCastTurns: number;
  readonly firstCasts: number;
  /** Sum of the evaluator's swing over each of its resolutions, and how many. */
  readonly impact: number;
  readonly impacts: number;
  /** Games in which a copy was in a hand its player mulliganed away. */
  readonly mulliganed: number;
}

/** A deck as a whole, over the games it played. */
export interface DeckCounts {
  readonly games: number;
  readonly wins: number;
  /** Sum of game lengths in turns. */
  readonly turns: number;
  readonly onPlay: Tally;
  readonly onDraw: Tally;
  /** Fewer than three lands by the end of its fourth turn, of games that reached it. */
  readonly screwed: number;
  readonly screwChances: number;
  /** More than seven lands by the end of its eighth turn, of games that reached it. */
  readonly flooded: number;
  readonly floodChances: number;
  /** Games in which it ended a turn holding a spell its lands could pay for but not colour. */
  readonly colourScrewed: number;
}

/** docs/05 `matchupWinRate`: a card's drawn and not-drawn tallies against one deck. */
export interface MatchupCounts {
  readonly drawn: Tally;
  readonly notDrawn: Tally;
}

/** Everything one agent's deck has recorded. */
export interface AgentCounts {
  readonly deck: DeckCounts;
  readonly cards: Readonly<Record<OracleId, CardCounts>>;
  /** Keyed by the opponent's deck generation, then by card. */
  readonly matchups: Readonly<Record<number, Readonly<Record<OracleId, MatchupCounts>>>>;
}

const noTally: Tally = { games: 0, wins: 0 };

export const emptyCardCounts: CardCounts = {
  games: 0,
  drawn: noTally,
  notDrawn: noTally,
  cast: 0,
  deadInHand: 0,
  firstCastTurns: 0,
  firstCasts: 0,
  impact: 0,
  impacts: 0,
  mulliganed: 0,
};

export const emptyDeckCounts: DeckCounts = {
  games: 0,
  wins: 0,
  turns: 0,
  onPlay: noTally,
  onDraw: noTally,
  screwed: 0,
  screwChances: 0,
  flooded: 0,
  floodChances: 0,
  colourScrewed: 0,
};

export const emptyAgentCounts: AgentCounts = { deck: emptyDeckCounts, cards: {}, matchups: {} };

// --- Adding counts ---

const addTally = (a: Tally, b: Tally, weight: number): Tally => ({
  games: a.games + weight * b.games,
  wins: a.wins + weight * b.wins,
});

/** `a + weight × b`, field by field, for any record of numbers and tallies. */
const addFields = <T extends object>(a: T, b: T, weight: number): T => {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(a) as (keyof T & string)[]) {
    const [x, y] = [a[key], b[key]];
    out[key] =
      typeof x === 'number' ? x + weight * (y as number) : addTally(x as Tally, y as Tally, weight);
  }
  return out as T;
};

const addRecords = <V extends object>(
  a: Readonly<Record<string, V>>,
  b: Readonly<Record<string, V>>,
  empty: V,
  add: (x: V, y: V, weight: number) => V,
  weight: number,
): Record<string, V> => {
  const out: Record<string, V> = { ...a };
  for (const [key, value] of Object.entries(b)) out[key] = add(a[key] ?? empty, value, weight);
  return out;
};

const emptyMatchup: MatchupCounts = { drawn: noTally, notDrawn: noTally };

/** `a + weight × b`: one agent's counts with another set's added, scaled. */
export const addCounts = (a: AgentCounts, b: AgentCounts, weight = 1): AgentCounts => ({
  deck: addFields(a.deck, b.deck, weight),
  cards: addRecords(a.cards, b.cards, emptyCardCounts, addFields, weight),
  matchups: addRecords(
    a.matchups,
    b.matchups,
    {},
    (x, y, w) => addRecords(x, y, emptyMatchup, addFields, w),
    weight,
  ),
});

/** docs/05: statistics are rolled up across cycles with a half-life of three cycles. */
export const DECAY_HALF_LIFE = 3;

/**
 * Cycles' counts rolled into one, **newest last**, each weighted by how long ago it was:
 * the newest at 1, one cycle before at 2^(−1/3), three cycles before at a half. The
 * result is fractional games, which the rates below read like whole ones.
 */
export const rollUp = (cycles: readonly AgentCounts[], halfLife = DECAY_HALF_LIFE): AgentCounts => {
  let total = emptyAgentCounts;
  cycles.forEach((counts, index) => {
    const age = cycles.length - 1 - index;
    total = addCounts(total, counts, 0.5 ** (age / halfLife));
  });
  return total;
};

// --- Reading rates off counts ---

/** docs/05: the Beta prior's strength, in games. */
export const SHRINKAGE_GAMES = 20;

/**
 * A win rate shrunk toward `mean` by `n0` games of prior: with no games it is the mean,
 * and it moves to the tally's own rate only as the games pile up (docs/05).
 */
export const shrunkRate = (tally: Tally, mean: number, n0 = SHRINKAGE_GAMES): number =>
  (tally.wins + n0 * mean) / (tally.games + n0);

const rate = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null);

export interface CardStats {
  readonly games: number;
  readonly gamesDrawn: number;
  readonly gamesNotDrawn: number;
  readonly winRateDrawn: number | null;
  readonly winRateNotDrawn: number | null;
  /** Shrunk drawn rate less shrunk not-drawn rate: the primary contribution signal. */
  readonly delta: number;
  readonly castRate: number | null;
  readonly deadInHandRate: number | null;
  readonly avgTurnCast: number | null;
  readonly impact: number | null;
  /** Of the games it was in the deck for, the share in which it was in a hand mulliganed away. */
  readonly mulliganBlame: number | null;
}

export const cardStats = (
  card: CardCounts,
  deckWinRate: number,
  n0 = SHRINKAGE_GAMES,
): CardStats => ({
  games: card.games,
  gamesDrawn: card.drawn.games,
  gamesNotDrawn: card.notDrawn.games,
  winRateDrawn: rate(card.drawn.wins, card.drawn.games),
  winRateNotDrawn: rate(card.notDrawn.wins, card.notDrawn.games),
  delta: shrunkRate(card.drawn, deckWinRate, n0) - shrunkRate(card.notDrawn, deckWinRate, n0),
  castRate: rate(card.cast, card.drawn.games),
  deadInHandRate: rate(card.deadInHand, card.games),
  avgTurnCast: rate(card.firstCastTurns, card.firstCasts),
  impact: rate(card.impact, card.impacts),
  mulliganBlame: rate(card.mulliganed, card.games),
});

export interface DeckStats {
  readonly games: number;
  readonly winRate: number | null;
  readonly winRateOnPlay: number | null;
  readonly winRateOnDraw: number | null;
  readonly averageTurns: number | null;
  readonly screwRate: number | null;
  readonly floodRate: number | null;
  readonly colourScrewRate: number | null;
}

export const deckStats = (deck: DeckCounts): DeckStats => ({
  games: deck.games,
  winRate: rate(deck.wins, deck.games),
  winRateOnPlay: rate(deck.onPlay.wins, deck.onPlay.games),
  winRateOnDraw: rate(deck.onDraw.wins, deck.onDraw.games),
  averageTurns: rate(deck.turns, deck.games),
  screwRate: rate(deck.screwed, deck.screwChances),
  floodRate: rate(deck.flooded, deck.floodChances),
  colourScrewRate: rate(deck.colourScrewed, deck.games),
});
