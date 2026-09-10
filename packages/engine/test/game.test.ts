import { describe, expect, it } from 'vitest';
import { createGame, step } from '../src/game.js';
import { nextInt, nextU32, Rng, seedRng, shuffle } from '../src/rng.js';
import { playGame, replayGame, scenario } from '../src/testing/index.js';
import { CARDS, redDeck } from './fixtures/cards.js';

describe('rng', () => {
  it('is deterministic and uniform-ish', () => {
    const a = seedRng('x');
    const b = seedRng('x');
    expect(nextU32(a)[0]).toBe(nextU32(b)[0]);
    expect(nextU32(seedRng('y'))[0]).not.toBe(nextU32(a)[0]);
    let s = a;
    const counts = [0, 0, 0];
    for (let i = 0; i < 3000; i++) {
      const [v, ns] = nextInt(s, 3);
      counts[v]!++;
      s = ns;
    }
    for (const c of counts) expect(c).toBeGreaterThan(800);
    const [sh] = shuffle(a, [1, 2, 3, 4, 5]);
    expect(sh.slice().sort()).toEqual([1, 2, 3, 4, 5]);
    const r = Rng.from(1);
    expect(r.int(1)).toBe(0);
  });
});

describe('mulligans and game start (CR 103)', () => {
  it('draws seven, asks each player, and bottoms one card per mulligan (London mulligan)', () => {
    const { state } = createGame({
      definitions: CARDS,
      decks: { A: redDeck(), B: redDeck() },
      seed: 7,
      onPlay: 'A',
    });
    expect(state.pendingDecision?.kind).toBe('mulligan');
    expect(state.pendingDecision?.kind === 'mulligan' && state.pendingDecision.player).toBe('A');
    expect(state.zones.A.hand).toHaveLength(7);
    let s = step(state, { kind: 'mulligan', keep: false }).state;
    expect(s.zones.A.hand).toHaveLength(7);
    expect(s.players.A.mulligans).toBe(1);
    s = step(s, { kind: 'mulligan', keep: true }).state;
    expect(s.pendingDecision?.kind).toBe('bottomCards');
    const hand = s.zones.A.hand;
    s = step(s, { kind: 'bottomCards', cards: [hand[0]!] }).state;
    expect(s.zones.A.hand).toHaveLength(6);
    expect(s.zones.A.library[s.zones.A.library.length - 1]).toBe(hand[0]);
    expect(s.pendingDecision?.kind === 'mulligan' && s.pendingDecision.player).toBe('B');
    s = step(s, { kind: 'mulligan', keep: true }).state;
    expect(s.turn).toBe(1);
    expect(s.activePlayer).toBe('A');
    expect(s.step).toBe('upkeep');
    expect(s.pendingDecision?.kind).toBe('priority');
  });

  it('rejects answers that do not match the pending decision', () => {
    const { state } = createGame({
      definitions: CARDS,
      decks: { A: redDeck(), B: redDeck() },
      seed: 7,
      onPlay: 'A',
    });
    expect(() => step(state, { kind: 'yesNo', yes: true })).toThrow();
  });
});

describe('game end and determinism', () => {
  it('same seed and answers reproduce the identical event log', () => {
    const decks = { A: redDeck(), B: redDeck() };
    const a = playGame({ definitions: CARDS, decks, seed: 'det' });
    const b = replayGame({ definitions: CARDS, decks, seed: 'det' }, a.answers);
    expect(b.events).toEqual(a.events);
    expect(b.state.result).toEqual(a.state.result);
  });

  it('ends in a draw after the decision cap', () => {
    const r = playGame({
      definitions: CARDS,
      decks: { A: redDeck(), B: redDeck() },
      seed: 3,
      config: { decisionCap: 50 },
    });
    expect(r.state.result?.reason).toBe('decisionCap');
  });

  it('detects a repeated-state loop within a turn', () => {
    const s = scenario(CARDS)
      .player('A')
      .battlefield('Idle Engine')
      .library('Island')
      .player('B')
      .library('Island')
      .start();
    let guard = 0;
    while (!s.state.result && guard++ < 200) s.activate('Idle Engine', 0).resolveAll();
    expect(s.state.result).toEqual({ winner: null, reason: 'loop' });
  });
});
