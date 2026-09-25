import { type AgentKnowledge, greedyAgent, type PlayDrawRecord, randomAgent } from '@mtg/agents';
import type { CardDefinition } from '@mtg/engine';
import { createRng } from '@mtg/engine';
import {
  fuzzBurn,
  fuzzCreature,
  fuzzDeck,
  fuzzLand,
  fuzzRemoval,
  fuzzTrigger,
} from '@mtg/engine/testing';
import { type AgentCounts, emptyAgentCounts, type GameEventLog, type PlayerId } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import {
  type AgentFactory,
  agentsAt,
  type CycleOptions,
  type CycleSettings,
  isTie,
  matchWinRates,
  runCycle,
} from './cycle.js';
import type { Deck } from './deck.js';
import type { MatchResult } from './match.js';

/**
 * One cycle of the evolution loop (roadmap 5.1, docs/05 "The cycle"): the matches, the
 * alternating first choice, the tie rule and its coin, and what the agents are told.
 */

const slot = (card: CardDefinition, count: number) => ({ oracleId: card.oracleId, count });
const deck: Deck = {
  main: [
    slot(fuzzLand, 22),
    slot(fuzzCreature, 16),
    slot(fuzzTrigger, 4),
    slot(fuzzBurn, 14),
    slot(fuzzRemoval, 4),
  ],
  side: [slot(fuzzBurn, 5), slot(fuzzRemoval, 5), slot(fuzzCreature, 5)],
};
const definitions = new Map(fuzzDeck.map((card) => [card.oracleId, card]));

const settings: CycleSettings = {
  matchesPerCycle: 4,
  tieMargin: 0.04,
  tiebreakMatches: 2,
  turnCap: 30,
  maxSideboardSwaps: 4,
};

const cycle = (over: Partial<CycleOptions> = {}) =>
  runCycle({
    decks: { A: deck, B: deck },
    definitions,
    seed: 'cycle',
    settings,
    agents: agentsAt('greedy'),
    ...over,
  });

const matchWon = (winner: PlayerId | null): MatchResult => ({
  games: [],
  wins: { A: 0, B: 0 },
  winner,
  sideboarding: { A: null, B: null },
});

describe('match win rates', () => {
  it('counts a won match as one and a drawn match as half', () => {
    expect(matchWinRates([matchWon('A'), matchWon(null), matchWon('B'), matchWon('A')])).toEqual({
      A: 0.625,
      B: 0.375,
    });
    expect(matchWinRates([])).toEqual({ A: 0.5, B: 0.5 });
  });
});

describe('what counts as a tie', () => {
  it('is two rates closer than the margin, or exactly level', () => {
    expect(isTie({ A: 0.51, B: 0.49 }, 0.04)).toBe(true);
    expect(isTie({ A: 0.53, B: 0.47 }, 0.04)).toBe(false);
    expect(isTie({ A: 0.5, B: 0.5 }, 0)).toBe(true);
    expect(isTie({ A: 0.51, B: 0.49 }, 0)).toBe(false);
  });
});

describe('the cycle', () => {
  it('plays its matches with the first choice alternating between the decks', () => {
    const result = cycle();
    expect(result.matches.length).toBeGreaterThanOrEqual(settings.matchesPerCycle);
    result.matches.forEach((match, i) => {
      expect(match.games[0]?.chooser).toBe(i % 2 === 0 ? 'A' : 'B');
    });
  });

  /** A strong deck pilot against a weak one: no tie, no tiebreak, the weak one loses. */
  it('names the deck with the lower match win rate as the loser', () => {
    const lopsided: AgentFactory = (player, knowledge) =>
      player === 'A' ? greedyAgent(undefined, knowledge) : randomAgent;
    const result = cycle({ agents: lopsided });
    expect(result.decidedBy).toBe('winRate');
    expect(result.tiebreakMatches).toBe(0);
    expect(result.matches).toHaveLength(settings.matchesPerCycle);
    expect(result.winRate.A).toBeGreaterThan(result.winRate.B);
    expect(result.loser).toBe('B');
  });

  /**
   * Level after the first batch — each deck's pilot is strong in alternate matches — so a
   * tiebreak batch is played, and in it A's pilot is the strong one.
   */
  it('plays a tiebreak batch on a tie, and lets it decide', () => {
    let made = 0;
    const alternating: AgentFactory = (player, knowledge) => {
      const match = Math.floor(made / 2);
      made += 1;
      const strong = match < settings.matchesPerCycle ? (match % 2 === 0 ? 'A' : 'B') : 'A';
      return player === strong ? greedyAgent(undefined, knowledge) : randomAgent;
    };
    const result = cycle({ agents: alternating });
    expect(matchWinRates(result.matches.slice(0, settings.matchesPerCycle))).toEqual({
      A: 0.5,
      B: 0.5,
    });
    expect(result.tiebreakMatches).toBe(settings.tiebreakMatches);
    expect(result.matches).toHaveLength(settings.matchesPerCycle + settings.tiebreakMatches);
    expect(result.decidedBy).toBe('tiebreak');
    expect(result.loser).toBe('B');
  });

  /** Two turns are too few to win in, so every match is drawn and the coin decides. */
  it('flips the cycle’s coin when the tiebreak is still a tie', () => {
    for (const seed of ['coin-1', 'coin-2', 'coin-3', 'coin-4']) {
      const result = cycle({ seed, settings: { ...settings, turnCap: 2 } });
      expect(result.decidedBy).toBe('coinFlip');
      expect(result.matches).toHaveLength(settings.matchesPerCycle + settings.tiebreakMatches);
      expect(result.loser).toBe(createRng(`${seed}:coin`).nextBoolean() ? 'A' : 'B');
    }
  });

  it('is the same cycle from the same seed', () => {
    expect(cycle({ seed: 'again' })).toEqual(cycle({ seed: 'again' }));
  });
});

describe('what the agents are told', () => {
  /** docs/04 item 6: the play/draw record is what the choice is made from. */
  it('keeps each deck’s record on the play and on the draw, game by game', () => {
    const result = cycle();
    const games = result.matches.flatMap((match) => match.games);
    for (const player of ['A', 'B'] as const) {
      const record = result.playDraw[player];
      const onPlay = games.filter((game) => game.onPlay === player);
      const onDraw = games.filter((game) => game.onPlay !== player);
      expect(record.play).toEqual({
        games: onPlay.length,
        wins: onPlay.filter((game) => game.result?.winner === player).length,
      });
      expect(record.draw).toEqual({
        games: onDraw.length,
        wins: onDraw.filter((game) => game.result?.winner === player).length,
      });
    }
  });

  it('makes each match’s agents knowing the record of the matches before it', () => {
    const told: { player: PlayerId; knowledge: AgentKnowledge }[] = [];
    const start: Record<PlayerId, PlayDrawRecord> = {
      A: { play: { games: 30, wins: 10 }, draw: { games: 30, wins: 20 } },
      B: { play: { games: 0, wins: 0 }, draw: { games: 0, wins: 0 } },
    };
    const result = cycle({
      playDraw: start,
      agents: (player, knowledge) => {
        told.push({ player, knowledge });
        return greedyAgent(undefined, knowledge);
      },
    });
    expect(told[0]).toEqual({ player: 'A', knowledge: { playDraw: start.A } });
    // Before the last match, the record counts every game but the last match's.
    const earlier = result.matches.slice(0, -1).flatMap((match) => match.games);
    const lastA = told.filter((entry) => entry.player === 'A').at(-1);
    const expected = earlier.filter((game) => game.onPlay === 'A').length + start.A.play.games;
    expect(lastA?.knowledge.playDraw?.play.games).toBe(expected);
  });

  it('sideboards by default when a match reaches game 3, and not when told not to', () => {
    const withSide = cycle({ seed: 'side' });
    const thirdGames = withSide.matches.filter((match) => match.games.length === 3);
    expect(thirdGames.length).toBeGreaterThan(0);
    for (const match of thirdGames) {
      expect(match.sideboarding.A).not.toBeNull();
      expect(match.sideboarding.B).not.toBeNull();
    }
    const without = cycle({ seed: 'side', sideboard: null });
    for (const match of without.matches) expect(match.sideboarding).toEqual({ A: null, B: null });
  });
});

describe('the cycle’s statistics (roadmap 5.2)', () => {
  it('reads every game it played into each deck’s counts, and hands each log on', () => {
    const logs: GameEventLog[] = [];
    const result = cycle({ generations: { A: 4, B: 9 }, onGame: (log) => logs.push(log) });
    const games = result.matches.flatMap((match) => match.games);
    expect(logs).toHaveLength(games.length);
    expect(result.stats.A.deck.games).toBe(games.length);
    expect(result.stats.B.deck.games).toBe(games.length);
    expect(result.stats.A.deck.wins).toBe(
      games.filter((game) => game.result?.winner === 'A').length,
    );
    // Decisions are scored, so resolutions have an impact.
    const impacts = Object.values(result.stats.A.cards).reduce(
      (sum, card) => sum + card.impacts,
      0,
    );
    expect(impacts).toBeGreaterThan(0);
    expect(logs.every((log) => log.players.A.deckGeneration === 4)).toBe(true);
    // A's cards are filed against B's generation, and B's against A's.
    expect(Object.keys(result.stats.A.matchups)).toEqual(['9']);
    expect(Object.keys(result.stats.B.matchups)).toEqual(['4']);
  });

  /**
   * History that says A's creatures lose when drawn against B's generation 5 — and only
   * against it — makes A side them out before game 3; the same history filed under another
   * generation says nothing about this opponent.
   */
  it('sideboards on each card’s record against the opponent’s current deck', () => {
    const creature = fuzzCreature.oracleId;
    const history = (generation: number): Record<PlayerId, AgentCounts> => ({
      A: {
        ...emptyAgentCounts,
        matchups: {
          [generation]: {
            [creature]: { drawn: { games: 200, wins: 20 }, notDrawn: { games: 200, wins: 180 } },
          },
        },
      },
      B: emptyAgentCounts,
    });
    const outs = (generation: number) =>
      cycle({ seed: 'side', generations: { A: 0, B: 5 }, history: history(generation) })
        .matches.flatMap((match) => match.sideboarding.A?.swaps ?? [])
        .filter((swap) => swap.out === creature && swap.outScore.basis === 'record');
    expect(outs(5).length).toBeGreaterThan(0);
    expect(outs(6)).toEqual([]);
  });
});
