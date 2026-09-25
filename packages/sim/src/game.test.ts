import { greedyAgent, type PlayAgent, randomAgent } from '@mtg/agents';
import { createRng, type Rng } from '@mtg/engine';
import { fuzzBoard } from '@mtg/engine/testing';
import type { PlayerId } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { playGame, StalledGameError } from './game.js';
import { playRung, tailAtLeast } from './ladder.js';

/**
 * Agents meeting real games. Everything here runs the engine for real, so an agent that
 * answered with something illegal would be refused by `applyDecision` and fail the test
 * that played it.
 */

const board = (seed: string) => fuzzBoard(seed, { creatures: 3, librarySize: 30 });

describe('the sanity ladder, first rung (docs/09)', () => {
  /**
   * Greedy against random, alternating seats so that neither is always on the play. A
   * draw — the game running out its turn limit — counts for neither, and what is tested
   * is that greedy wins more of the decided games than a fair coin plausibly would. The
   * margin is wide enough that 60 games show it; `pnpm ladder` plays docs/09's 500.
   */
  it('greedy beats random far more often than chance allows', () => {
    const rung = playRung({
      stronger: greedyAgent(),
      weaker: randomAgent,
      games: 60,
      seed: 'ladder',
    });
    expect(rung.wins + rung.losses).toBeGreaterThan(40);
    expect(rung.pValue).toBeLessThan(0.001);
  }, 60_000);

  it('the binomial tail it is judged by is the right one', () => {
    expect(tailAtLeast(0, 10)).toBeCloseTo(1);
    expect(tailAtLeast(10, 10)).toBeCloseTo(1 / 1024);
    expect(tailAtLeast(6, 10)).toBeCloseTo(386 / 1024);
  });

  it('counts each game once, for the side that won it', () => {
    const rung = playRung({ stronger: randomAgent, weaker: randomAgent, games: 6, seed: 'count' });
    expect(rung.wins + rung.losses + rung.draws).toBe(6);
    expect(rung.pValue).toBe(tailAtLeast(rung.wins, rung.wins + rung.losses));
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
      decide: (view, decision, rng, simulator) => {
        if (!seen.has(decision.player)) {
          seen.set(decision.player, rng);
          firstState.set(decision.player, rng.save());
        }
        return agent.decide(view, decision, rng, simulator);
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
      decide: (view, decision, rng, simulator) => {
        asked += 1;
        expect(view.viewer).toBe(decision.player);
        // The simulator samples what *this* player cannot see, and nobody else's view.
        expect(simulator.viewer).toBe(decision.player);
        expect(view.you.player).toBe(decision.player);
        expect('zones' in view).toBe(false);
        expect('pendingDecision' in view).toBe(false);
        expect('hand' in view.opponent).toBe(false);
        return randomAgent.decide(view, decision, rng, simulator);
      },
    };

    playGame(board('views'), { A: checking, B: checking }, 'views');
    expect(asked).toBeGreaterThan(10);
  });
});

describe('who plays first (CR 103.1)', () => {
  /** The chooser is asked through the same door as every other decision. */
  it('asks the chooser, and plays the game the way they chose', () => {
    const board = (seed: string) =>
      fuzzBoard(seed, { creatures: 3, librarySize: 30, chooser: 'B' });
    const drawing = greedyAgent(undefined, {
      playDraw: { play: { games: 40, wins: 10 }, draw: { games: 40, wins: 30 } },
    });

    const played = playGame(board('choose'), { A: randomAgent, B: greedyAgent() }, 'choose');
    expect(played.state.config.playerOnPlay).toBe('B');

    const drew = playGame(board('choose'), { A: randomAgent, B: drawing }, 'choose');
    expect(drew.state.config.playerOnPlay).toBe('A');
  });
});

describe('a game that will not end', () => {
  it('is stopped, and says which seed it was', () => {
    expect(() =>
      playGame(board('stall'), { A: randomAgent, B: randomAgent }, 'stall', { maxDecisions: 5 }),
    ).toThrow(StalledGameError);
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

describe('what a game records (roadmap 5.2)', () => {
  it('keeps every event the engine emitted, and records no decisions unless asked', () => {
    const played = playGame(board('events'), { A: greedyAgent(), B: greedyAgent() }, 'events');
    expect(played.events[0]?.seq).toBe(0);
    expect(played.events.some((event) => event.type === 'gameStart')).toBe(true);
    expect(played.events.some((event) => event.type === 'decision')).toBe(false);
  });

  /** docs/05's `impact` is read off these: each decision, scored for the player deciding. */
  it('records each decision with the score of the decider’s own view, when asked', () => {
    const scored: { viewer: PlayerId; turn: number }[] = [];
    const played = playGame(board('scores'), { A: greedyAgent(), B: greedyAgent() }, 'scores', {
      score: (view) => {
        scored.push({ viewer: view.viewer, turn: view.turn });
        return scored.length;
      },
    });
    const decisions = played.events.filter((event) => event.type === 'decision');
    expect(decisions).toHaveLength(played.decisions.length);
    decisions.forEach((event, i) => {
      expect(event.type === 'decision' && event.score).toBe(i + 1);
      expect(event.type === 'decision' && event.player).toBe(scored[i]?.viewer);
      expect(event.turn).toBe(scored[i]?.turn);
    });
  });
});
