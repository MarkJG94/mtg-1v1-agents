import {
  type AgentKnowledge,
  defaultWeights,
  evaluate,
  greedyAgent,
  type MatchupRecord,
  type PlayAgent,
  type PlayDrawRecord,
  randomAgent,
  type SideboardPlan,
  searchAgent,
  searchLevels,
  sideboard,
  type Weights,
} from '@mtg/agents';
import { type CardDefinition, createRng } from '@mtg/engine';
import type { PlayerView } from '@mtg/engine/view';
import {
  type AgentCounts,
  type AgentLevel,
  addCounts,
  emptyAgentCounts,
  type GameEventLog,
  type OracleId,
  opponentOf,
  type PlayerId,
  type RunSettings,
} from '@mtg/shared';
import { cardsIn, type Deck } from './deck.js';
import { type MatchResult, playMatch, type SideboardContext } from './match.js';
import { sideboardCardsFor } from './sideboard-cards.js';
import { type CardFacts, cardFactsFor, StatsAccumulator } from './stats.js';

/**
 * One cycle of the evolution loop (docs/05 "The cycle"; roadmap 5.1): the two decks play
 * `matchesPerCycle` best-of-three matches, and the one with the lower match win rate is
 * the cycle's loser — the deck the deck agent will change (roadmap 5.4).
 *
 * - **Game 1's chooser alternates** from match to match, so neither deck always decides
 *   who plays first; after that the match's own rule applies (CR 103.1).
 * - **A match is worth a point for a win and half for a draw**, and a deck's match win
 *   rate is its points over the matches played.
 * - **A tie** — the two rates within `tieMargin` of each other — earns `tiebreakMatches`
 *   more, counted with the rest; if it is still a tie, a coin flipped from the cycle's
 *   seed names the loser. The loser is always somebody: a cycle that changed nothing
 *   would be a cycle wasted.
 * - **Play/draw records are kept as the games are played**, and each match's agents are
 *   made knowing the record so far, which is what docs/04 item 6 decides with.
 * - **Sideboarding** is the agents' `sideboard()`, told what the opponent has shown and
 *   how this deck has done against it this cycle, until the statistics aggregator
 *   (roadmap 5.2) can give it each card's record too.
 */

/** The settings a cycle reads (docs/05 "Run settings"). */
export type CycleSettings = Pick<
  RunSettings,
  'matchesPerCycle' | 'tieMargin' | 'tiebreakMatches' | 'turnCap' | 'maxSideboardSwaps'
>;

/** Makes a player's agent for one match, knowing what the cycle has learnt so far. */
export type AgentFactory = (player: PlayerId, knowledge: AgentKnowledge) => PlayAgent;

/** The agent docs/04 describes at each level, with the given evaluator weights. */
export const agentsAt =
  (level: AgentLevel, weights: Weights = defaultWeights): AgentFactory =>
  (_player, knowledge) => {
    switch (level) {
      case 'random':
        return randomAgent;
      case 'greedy':
        return greedyAgent(weights, knowledge);
      case 'search':
      case 'deep':
        return searchAgent(level, weights, searchLevels[level], undefined, knowledge);
    }
  };

export interface CycleOptions {
  readonly decks: Readonly<Record<PlayerId, Deck>>;
  /** Every card either deck holds, main or side. */
  readonly definitions: ReadonlyMap<OracleId, CardDefinition>;
  /** Match seeds are `${seed}:match-${n}`, and the coin is `${seed}:coin`. */
  readonly seed: string;
  readonly settings: CycleSettings;
  readonly agents: AgentFactory;
  /** Cards neither deck may side in. */
  readonly banned?: ReadonlySet<OracleId>;
  /** Each player's record on the play and on the draw when the cycle starts. */
  readonly playDraw?: Readonly<Record<PlayerId, PlayDrawRecord>>;
  /** Replaces the default sideboarding, or with `null` switches it off. */
  readonly sideboard?: ((context: SideboardContext) => SideboardPlan) | null;
  /** Told of each match as it finishes, for progress. */
  readonly observe?: (match: MatchResult, index: number) => void;
  /** Each deck's generation, for the logs and the matchup statistics; 0 if not given. */
  readonly generations?: Readonly<Record<PlayerId, number>>;
  /**
   * Each deck's statistics from earlier cycles, rolled up (`rollUp` in `@mtg/shared`).
   * Sideboarding reads each card's record against the opponent's current deck from these
   * and from this cycle's games so far.
   */
  readonly history?: Readonly<Record<PlayerId, AgentCounts>>;
  /** The printed facts the aggregator needs; worked out from `definitions` if not given. */
  readonly facts?: ReadonlyMap<OracleId, CardFacts>;
  /** How each decision's position is scored for `impact`; the default evaluator if not given. */
  readonly score?: (view: PlayerView) => number;
  /** Handed each game's event log as it finishes, to keep; the cycle keeps none. */
  readonly onGame?: (log: GameEventLog) => void;
}

export interface CycleResult {
  readonly matches: readonly MatchResult[];
  /** How many of `matches`, at the end, were the tiebreak batch. */
  readonly tiebreakMatches: number;
  readonly winRate: Readonly<Record<PlayerId, number>>;
  readonly loser: PlayerId;
  readonly decidedBy: 'winRate' | 'tiebreak' | 'coinFlip';
  /** The records as they stand at the end of the cycle. */
  readonly playDraw: Readonly<Record<PlayerId, PlayDrawRecord>>;
  /** This cycle's statistics for each deck, read from every game's event log (docs/05). */
  readonly stats: Readonly<Record<PlayerId, AgentCounts>>;
}

const noRecord: PlayDrawRecord = { play: { games: 0, wins: 0 }, draw: { games: 0, wins: 0 } };

/** Points over matches, a draw worth half; 0.5 each before any match is played. */
export const matchWinRates = (matches: readonly MatchResult[]): Record<PlayerId, number> => {
  if (matches.length === 0) return { A: 0.5, B: 0.5 };
  let a = 0;
  for (const match of matches) a += match.winner === 'A' ? 1 : match.winner === null ? 0.5 : 0;
  return { A: a / matches.length, B: 1 - a / matches.length };
};

/**
 * A tie is two rates closer than the margin — or exactly level, which is a tie whatever
 * the margin, since neither deck can then be called the loser.
 */
export const isTie = (rates: Readonly<Record<PlayerId, number>>, margin: number): boolean =>
  rates.A === rates.B || Math.abs(rates.A - rates.B) < margin;

export const runCycle = (options: CycleOptions): CycleResult => {
  const { settings } = options;
  const matches: MatchResult[] = [];
  const playDraw: Record<PlayerId, PlayDrawRecord> = {
    A: options.playDraw?.A ?? noRecord,
    B: options.playDraw?.B ?? noRecord,
  };
  const facts =
    options.facts ??
    new Map([...options.definitions].map(([oracleId, card]) => [oracleId, cardFactsFor(card)]));
  const stats = new StatsAccumulator(facts);
  const score = options.score ?? ((view: PlayerView) => evaluate(view, defaultWeights));
  const hook =
    options.sideboard === undefined
      ? defaultSideboard(options, matches, () => stats.totals)
      : options.sideboard;

  const play = (count: number) => {
    for (let i = 0; i < count; i += 1) {
      const index = matches.length;
      const match = playMatch({
        players: {
          A: {
            deck: options.decks.A,
            agent: options.agents('A', { playDraw: playDraw.A }),
            ...(hook === null ? {} : { sideboard: hook }),
          },
          B: {
            deck: options.decks.B,
            agent: options.agents('B', { playDraw: playDraw.B }),
            ...(hook === null ? {} : { sideboard: hook }),
          },
        },
        definitions: options.definitions,
        seed: `${options.seed}:match-${index}`,
        firstChooser: index % 2 === 0 ? 'A' : 'B',
        turnCap: settings.turnCap,
        ...(options.generations === undefined ? {} : { generations: options.generations }),
        score,
        onGame: (log) => {
          stats.add(log);
          options.onGame?.(log);
        },
      });
      for (const game of match.games) {
        for (const player of ['A', 'B'] as const) {
          playDraw[player] = recorded(
            playDraw[player],
            game.onPlay === player,
            game.result?.winner === player,
          );
        }
      }
      matches.push(match);
      options.observe?.(match, index);
    }
  };

  const tied = (rates: Record<PlayerId, number>) => isTie(rates, settings.tieMargin);

  play(settings.matchesPerCycle);
  let decidedBy: CycleResult['decidedBy'] = 'winRate';
  let tiebreakMatches = 0;
  if (tied(matchWinRates(matches))) {
    play(settings.tiebreakMatches);
    tiebreakMatches = settings.tiebreakMatches;
    decidedBy = 'tiebreak';
  }
  const winRate = matchWinRates(matches);
  let loser: PlayerId = winRate.A < winRate.B ? 'A' : 'B';
  if (tied(winRate)) {
    loser = createRng(`${options.seed}:coin`).nextBoolean() ? 'A' : 'B';
    decidedBy = 'coinFlip';
  }

  return { matches, tiebreakMatches, winRate, loser, decidedBy, playDraw, stats: stats.totals };
};

const recorded = (record: PlayDrawRecord, onPlay: boolean, won: boolean): PlayDrawRecord => {
  const side = onPlay ? record.play : record.draw;
  const next = { games: side.games + 1, wins: side.wins + (won ? 1 : 0) };
  return onPlay ? { ...record, play: next } : { ...record, draw: next };
};

/**
 * docs/04's sideboarding agent, given what a match and the statistics can tell it: the
 * cards the opponent has shown, this deck's games and wins against the opponent's deck
 * this cycle, and each card's record against that deck — docs/05's `matchupWinRate`,
 * keyed by the opponent's generation — from earlier cycles and this one so far.
 */
const defaultSideboard = (
  options: CycleOptions,
  matches: readonly MatchResult[],
  sofar: () => Readonly<Record<PlayerId, AgentCounts>>,
) => {
  const pool = new Set<OracleId>([
    ...cardsIn(options.decks.A).keys(),
    ...cardsIn(options.decks.B).keys(),
  ]);
  const cards = sideboardCardsFor(
    [...pool].flatMap((oracleId) => {
      const definition = options.definitions.get(oracleId);
      return definition === undefined ? [] : [definition];
    }),
  );
  return (context: SideboardContext): SideboardPlan => {
    let games = 0;
    let wins = 0;
    for (const match of [...matches, { games: context.games }]) {
      for (const game of match.games) {
        games += 1;
        if (game.result?.winner === context.player) wins += 1;
      }
    }
    return sideboard({
      main: context.deck.main,
      side: context.deck.side,
      cards,
      opponentSeen: context.opponentSeen,
      matchup: { games, wins },
      records: matchupRecords(options, sofar()[context.player], context.player),
      banned: options.banned ?? new Set(),
      settings: { maxSwaps: options.settings.maxSideboardSwaps },
    });
  };
};

/**
 * Each card's record against the opponent's current deck, from earlier cycles' rolled-up
 * counts and this cycle's so far, in the shape the sideboarding agent reads.
 */
const matchupRecords = (
  options: CycleOptions,
  cycle: AgentCounts,
  player: PlayerId,
): Map<OracleId, MatchupRecord> => {
  const all = addCounts(options.history?.[player] ?? emptyAgentCounts, cycle);
  const against = all.matchups[options.generations?.[opponentOf(player)] ?? 0] ?? {};
  return new Map(
    Object.entries(against).map(([oracleId, counts]) => [
      oracleId as OracleId,
      {
        gamesDrawn: counts.drawn.games,
        winsDrawn: counts.drawn.wins,
        gamesNotDrawn: counts.notDrawn.games,
        winsNotDrawn: counts.notDrawn.wins,
      },
    ]),
  );
};
