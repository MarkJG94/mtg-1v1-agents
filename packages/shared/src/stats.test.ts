import { describe, expect, it } from 'vitest';
import { asOracleId } from './ids.js';
import {
  type AgentCounts,
  addCounts,
  type CardCounts,
  cardStats,
  deckStats,
  emptyAgentCounts,
  emptyCardCounts,
  emptyDeckCounts,
  rollUp,
  shrunkRate,
} from './stats.js';

/**
 * Statistics as counts (roadmap 5.2, docs/05 "Statistics"): they add, they roll up with
 * a half-life, and rates read off them are shrunk toward the deck's own.
 */

const bear = asOracleId('bear');
const bolt = asOracleId('bolt');

const card = (over: Partial<CardCounts>): CardCounts => ({ ...emptyCardCounts, ...over });
const agent = (games: number, cards: Record<string, CardCounts>, matchups = {}): AgentCounts => ({
  deck: { ...emptyDeckCounts, games, wins: games / 2 },
  cards,
  matchups,
});

describe('shrinkage (docs/05: a Beta prior of twenty games)', () => {
  it('is the deck’s rate with no games, and moves to the card’s own as games pile up', () => {
    expect(shrunkRate({ games: 0, wins: 0 }, 0.4)).toBe(0.4);
    expect(shrunkRate({ games: 20, wins: 20 }, 0.4)).toBeCloseTo(0.7);
    expect(shrunkRate({ games: 2000, wins: 2000 }, 0.4)).toBeGreaterThan(0.99);
  });

  /** Three wins in three draws is a hint, not a verdict. */
  it('makes a short run count for little', () => {
    const delta = cardStats(
      card({ games: 6, drawn: { games: 3, wins: 3 }, notDrawn: { games: 3, wins: 0 } }),
      0.5,
    ).delta;
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThan(0.15);
  });
});

describe('adding counts', () => {
  it('adds every field, tallies included, and cards either side has', () => {
    const sum = addCounts(
      agent(4, { [bear]: card({ games: 4, drawn: { games: 2, wins: 1 }, cast: 2 }) }),
      agent(6, {
        [bear]: card({ games: 6, drawn: { games: 3, wins: 3 }, cast: 1 }),
        [bolt]: card({ games: 6 }),
      }),
    );
    expect(sum.deck.games).toBe(10);
    expect(sum.deck.wins).toBe(5);
    expect(sum.cards[bear]).toMatchObject({ games: 10, drawn: { games: 5, wins: 4 }, cast: 3 });
    expect(sum.cards[bolt]?.games).toBe(6);
  });

  it('adds matchups by opponent generation, then by card', () => {
    const tally = (games: number) => ({
      drawn: { games, wins: 0 },
      notDrawn: { games: 0, wins: 0 },
    });
    const sum = addCounts(
      agent(1, {}, { 2: { [bear]: tally(1) } }),
      agent(1, {}, { 2: { [bear]: tally(2), [bolt]: tally(1) }, 5: { [bear]: tally(4) } }),
    );
    expect(sum.matchups[2]?.[bear]?.drawn.games).toBe(3);
    expect(sum.matchups[2]?.[bolt]?.drawn.games).toBe(1);
    expect(sum.matchups[5]?.[bear]?.drawn.games).toBe(4);
  });

  it('scales what it adds by the weight', () => {
    expect(addCounts(emptyAgentCounts, agent(8, {}), 0.25).deck.games).toBe(2);
  });
});

describe('the roll-up across cycles (docs/05: a half-life of three cycles)', () => {
  it('weighs the newest cycle fully and one three cycles older by half', () => {
    const cycles = [agent(100, {}), agent(100, {}), agent(100, {}), agent(100, {})];
    const rolled = rollUp(cycles);
    const expected = 100 * (1 + 0.5 ** (1 / 3) + 0.5 ** (2 / 3) + 0.5);
    expect(rolled.deck.games).toBeCloseTo(expected);
  });

  it('is the newest cycle alone when there is one', () => {
    expect(rollUp([agent(40, {})]).deck.games).toBe(40);
  });

  it('counts the newest last', () => {
    expect(rollUp([agent(100, {}), agent(0, {})]).deck.games).toBeCloseTo(100 * 0.5 ** (1 / 3));
  });
});

describe('rates read off counts', () => {
  it('reads each card rate, and none where there is nothing to read', () => {
    const stats = cardStats(
      card({
        games: 10,
        drawn: { games: 8, wins: 6 },
        notDrawn: { games: 2, wins: 0 },
        cast: 4,
        deadInHand: 3,
        firstCastTurns: 12,
        firstCasts: 4,
        impact: 2,
        impacts: 4,
        mulliganed: 1,
      }),
      0.5,
    );
    expect(stats).toMatchObject({
      winRateDrawn: 0.75,
      winRateNotDrawn: 0,
      castRate: 0.5,
      deadInHandRate: 0.3,
      avgTurnCast: 3,
      impact: 0.5,
      mulliganBlame: 0.1,
    });
    expect(cardStats(emptyCardCounts, 0.5)).toMatchObject({
      castRate: null,
      avgTurnCast: null,
      delta: 0,
    });
  });

  it('reads the deck’s rates, screw and flood over the games that could show them', () => {
    const stats = deckStats({
      ...emptyDeckCounts,
      games: 10,
      wins: 6,
      turns: 120,
      onPlay: { games: 5, wins: 4 },
      onDraw: { games: 5, wins: 2 },
      screwed: 1,
      screwChances: 4,
      flooded: 0,
      floodChances: 2,
      colourScrewed: 2,
    });
    expect(stats).toEqual({
      games: 10,
      winRate: 0.6,
      winRateOnPlay: 0.8,
      winRateOnDraw: 0.4,
      averageTurns: 12,
      screwRate: 0.25,
      floodRate: 0,
      colourScrewRate: 0.2,
    });
  });
});
