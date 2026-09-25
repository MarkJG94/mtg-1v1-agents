import { greedyAgent, type PlayAgent, randomAgent } from '@mtg/agents';
import { createRng, type Rng } from '@mtg/engine';
import { fuzzBoard } from '@mtg/engine/testing';
import type { PlayerId } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { playGame, StalledGameError } from './game.js';

/**
 * Agents meeting real games. Everything here runs the engine for real, so an agent that
 * answered with something illegal would be refused by `applyDecision` and fail the test
 * that played it.
 */

const board = (seed: string) => fuzzBoard(seed, { creatures: 3, librarySize: 30 });

/** One-sided exact binomial tail: P(X >= k) for X ~ Binomial(n, 1/2). */
const tailAtLeast = (k: number, n: number): number => {
  let total = 0;
  let term = 0.5 ** n; // C(n, 0) / 2^n
  for (let i = 0; i <= n; i += 1) {
    if (i >= k) total += term;
    term = (term * (n - i)) / (i + 1);
  }
  return total;
};

describe('the sanity ladder, first rung (docs/09)', () => {
  /**
   * Greedy against random, alternating seats so that neither is always on the play. A
   * draw — the game running out its turn limit — counts for neither, and what is tested
   * is that greedy wins more of the decided games than a fair coin plausibly would.
   */
  it('greedy beats random far more often than chance allows', () => {
    const greedy = greedyAgent();
    let wins = 0;
    let decided = 0;
    for (let i = 0; i < 60; i += 1) {
      const seat: PlayerId = i % 2 === 0 ? 'A' : 'B';
      const agents = seat === 'A' ? { A: greedy, B: randomAgent } : { A: randomAgent, B: greedy };
      const { result } = playGame(board(`ladder-${i}`), agents, `ladder-${i}`);
      if (result === null || result.winner === null) continue;
      decided += 1;
      if (result.winner === seat) wins += 1;
    }

    expect(decided).toBeGreaterThan(40);
    expect(tailAtLeast(wins, decided)).toBeLessThan(0.001);
  }, 60_000);

  it('the binomial tail it is judged by is the right one', () => {
    expect(tailAtLeast(0, 10)).toBeCloseTo(1);
    expect(tailAtLeast(10, 10)).toBeCloseTo(1 / 1024);
    expect(tailAtLeast(6, 10)).toBeCloseTo(386 / 1024);
  });
});

describe('a game is a pure function of its seed and its agents', () => {
  it('plays the same game twice from the same seed', () => {
    const agents = { A: randomAgent, B: randomAgent };
    const first = playGame(board('same'), agents, 'same');
    const second = playGame(board('same'), agents, 'same');
    expect(second.decisions).toEqual(first.decisions);
    expect(second.result).toEqual(first.result);
  });

  it('plays a different game from a different seed', () => {
    const agents = { A: randomAgent, B: randomAgent };
    const first = playGame(board('same'), agents, 'one');
    const second = playGame(board('same'), agents, 'two');
    expect(second.decisions).not.toEqual(first.decisions);
  });

  /**
   * Each seat has its own generator, forked from the seed by seat. Were they one shared
   * generator, how many draws one agent made would move every draw of the other's, and
   * changing one seat's agent would silently change how the other played.
   */
  it('gives each seat its own generator, seeded by seat', () => {
    const firstState = new Map<PlayerId, readonly number[]>();
    const seen = new Map<PlayerId, Rng>();
    const recording = (agent: PlayAgent): PlayAgent => ({
      level: agent.level,
      decide: (view, decision, rng) => {
        if (!seen.has(decision.player)) {
          seen.set(decision.player, rng);
          firstState.set(decision.player, rng.save());
        }
        return agent.decide(view, decision, rng);
      },
    });

    playGame(board('seats'), { A: recording(randomAgent), B: recording(randomAgent) }, 'seats');

    expect(seen.get('A')).not.toBe(seen.get('B'));
    expect(firstState.get('A')).toEqual(createRng('seats:seat:A').save());
    expect(firstState.get('B')).toEqual(createRng('seats:seat:B').save());
  });
});

describe('what an agent is handed (ADR 0009)', () => {
  it('is the view of the player being asked, never the state', () => {
    let asked = 0;
    const checking: PlayAgent = {
      level: 'random',
      decide: (view, decision, rng) => {
        asked += 1;
        expect(view.viewer).toBe(decision.player);
        expect(view.you.player).toBe(decision.player);
        expect('zones' in view).toBe(false);
        expect('pendingDecision' in view).toBe(false);
        expect('hand' in view.opponent).toBe(false);
        return randomAgent.decide(view, decision, rng);
      },
    };

    playGame(board('views'), { A: checking, B: checking }, 'views');
    expect(asked).toBeGreaterThan(10);
  });
});

describe('a game that will not end', () => {
  it('is stopped, and says which seed it was', () => {
    expect(() => playGame(board('stall'), { A: randomAgent, B: randomAgent }, 'stall', 5)).toThrow(
      StalledGameError,
    );
  });
});

describe('greedy against itself', () => {
  it('plays whole games without being refused or stalling', () => {
    const greedy = greedyAgent();
    for (let i = 0; i < 5; i += 1) {
      const { result } = playGame(board(`mirror-${i}`), { A: greedy, B: greedy }, `mirror-${i}`);
      expect(result).not.toBeNull();
    }
  });
});
