import { defaultWeights, tunableTerms, type Weights } from '@mtg/agents';
import { createRng } from '@mtg/engine';
import { describe, expect, it } from 'vitest';
import { playRung } from './ladder.js';
import { agentWith, type Climb, compareWeights, hillClimb, moveKey, propose } from './tuning.js';

/**
 * The weight-tuning harness (roadmap 4.7, docs/04 item 1), on greedy, where a game costs
 * a few tens of milliseconds.
 *
 * The fixture is a set that hoards its hand: a card in hand worth fifteen, ten times the
 * default, so no creature is ever worth casting. The default beats it 19–1 over twenty
 * games, which is a gap wide enough to test the harness's logic without testing its luck.
 */

const hoarding: Weights = { ...defaultWeights, cardInHand: 15 };

describe('mirrored games', () => {
  /**
   * The second game of a pair is the first with the names swapped, so two identical agents
   * split every pair. Fresh boards give the same two agents 7–13 on these seeds — noise
   * the pairing takes away.
   */
  it('splits every pair between two identical agents', () => {
    const same = agentWith('greedy', defaultWeights);
    const mirrored = playRung({
      stronger: same,
      weaker: same,
      games: 20,
      seed: 'p',
      mirrored: true,
    });
    expect(mirrored.wins).toBe(mirrored.losses);
    const fresh = playRung({ stronger: same, weaker: same, games: 20, seed: 'p' });
    expect(fresh.wins).not.toBe(fresh.losses);
  });
});

describe('compareWeights', () => {
  it('plays every board from both seats', () => {
    const result = compareWeights({
      challenger: defaultWeights,
      incumbent: defaultWeights,
      level: 'greedy',
      games: 20,
      seed: 'p',
    });
    expect(result.wins).toBe(result.losses);
  });

  it('finds the default far ahead of a set that never casts its creatures', () => {
    const result = compareWeights({
      challenger: defaultWeights,
      incumbent: hoarding,
      level: 'greedy',
      games: 20,
      seed: 'p',
    });
    expect(result.pValue).toBeLessThan(0.001);
  });
});

describe('propose', () => {
  const draws = (weights: Weights, terms: readonly (keyof Weights)[], factor: number) => {
    const rng = createRng('propose');
    return Array.from({ length: 40 }, () => propose(weights, terms, factor, rng));
  };

  it('scales a term up or down by the factor, to four significant figures', () => {
    const seen = new Set(draws(defaultWeights, ['creatureToughness'], 3).map((p) => p?.to));
    expect(seen).toEqual(new Set([1.5, 0.1667]));
  });

  it('moves a count by one, and never below its floor', () => {
    const seen = new Set(
      draws({ ...defaultWeights, landTarget: 1 }, ['landTarget'], 3).map((p) => p?.to),
    );
    expect(seen).toEqual(new Set([2]));
  });

  /** Doubling `spareLand` would make it equal `landBeyondTarget`, which `parseWeights` refuses. */
  it('goes the other way when one way breaks a rule the weights must keep', () => {
    const seen = new Set(draws(defaultWeights, ['spareLand'], 2).map((p) => p?.to));
    expect(seen).toEqual(new Set([0.025]));
  });

  it('skips a move already refused from these weights', () => {
    const refused = new Set([moveKey('creatureToughness', 1.5)]);
    const rng = createRng('refused');
    for (let i = 0; i < 10; i += 1) {
      expect(propose(defaultWeights, ['creatureToughness'], 3, rng, refused)?.to).toBe(0.1667);
    }
    refused.add(moveKey('creatureToughness', 0.1667));
    expect(propose(defaultWeights, ['creatureToughness'], 3, rng, refused)).toBeNull();
  });

  it('draws another term when one cannot move, and gives up only when none can', () => {
    const rng = createRng('stuck');
    expect(propose(defaultWeights, ['win'], 2, rng)).toBeNull();
    for (let i = 0; i < 10; i += 1) {
      expect(propose(defaultWeights, ['win', 'life'], 2, rng)?.term).toBe('life');
    }
  });

  it('never proposes the value of a win, which is not tuned', () => {
    const terms = new Set(draws(defaultWeights, tunableTerms, 1.25).map((p) => p?.term));
    expect(terms.has('win')).toBe(false);
    expect(terms.size).toBeGreaterThan(10);
  });
});

describe('hillClimb', () => {
  const climb = (alpha: number): Climb =>
    hillClimb({
      start: hoarding,
      level: 'greedy',
      seed: 'climb',
      trials: 6,
      gamesPerTrial: 20,
      alpha,
      factor: 10,
      confirmGames: 20,
      terms: ['cardInHand'],
    });

  const kept = climb(0.05);

  /**
   * On these seeds the climb tries 1.5 (and keeps it, 19–1), then 15 again (2–18, refused),
   * then 0.15 (9–9, refused) — and then has nothing left to try.
   */
  it('keeps a step that wins by more than chance and refuses one that does not', () => {
    const result = kept;
    expect(result.trials.map((trial) => [trial.to, trial.accepted])).toEqual([
      [1.5, true],
      [15, false],
      [0.15, false],
    ]);
    expect(result.weights.cardInHand).toBe(1.5);
  });

  /** A refused move is not played again from the same weights: it would ask the same question. */
  it('stops when every move from where it is has been refused, however many trials are left', () => {
    expect(kept.trials).toHaveLength(3);
    expect(kept.converged).toBe(true);
  });

  it('confirms what it found against the start, on seeds no trial played', () => {
    const result = kept;
    expect(result.confirmation?.pValue).toBeLessThan(0.001);
    const trialSeeds = result.trials.map((trial) => trial.seed);
    expect(trialSeeds).not.toContain(result.confirmation?.seed);
    expect(new Set(trialSeeds).size).toBe(trialSeeds.length);
  });

  /**
   * Once the weights change, a move refused from the old ones asks a new question. On these
   * seeds creature toughness at 0.05 is refused from the hoarding set, the hand is then
   * fixed, and toughness at 0.05 is tried again from there.
   */
  it('tries a refused move again once another step has been kept', () => {
    const result = hillClimb({
      start: hoarding,
      level: 'greedy',
      seed: 'f',
      trials: 5,
      gamesPerTrial: 20,
      alpha: 0.05,
      factor: 10,
      confirmGames: 2,
      terms: ['cardInHand', 'creatureToughness'],
    });
    expect(result.trials.map((trial) => `${trial.term}=${trial.to}`)).toEqual([
      'cardInHand=150',
      'creatureToughness=0.05',
      'creatureToughness=5',
      'cardInHand=1.5',
      'creatureToughness=0.05',
    ]);
    expect(result.trials[3]?.accepted).toBe(true);
  });

  it('keeps the start, and plays no confirmation, when nothing clears the bar', () => {
    const result = climb(0);
    expect(result.trials.every((trial) => !trial.accepted)).toBe(true);
    expect(result.trials.map((trial) => trial.to).sort((a, b) => a - b)).toEqual([1.5, 150]);
    expect(result.weights).toBe(hoarding);
    expect(result.confirmation).toBeNull();
  });
});
