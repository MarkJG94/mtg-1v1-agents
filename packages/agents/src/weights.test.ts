import { describe, expect, it } from 'vitest';
import {
  defaultWeights,
  InvalidWeightsError,
  parseWeights,
  tunableTerms,
  weightTuning,
} from './weights.js';

/**
 * The weights file (docs/04). A tuned set arrives as JSON from the tuning harness, so the
 * only thing standing between a typo and an agent that silently picks its first option
 * every time — `undefined` arithmetic is `NaN`, and `NaN` loses every comparison — is
 * this check.
 */
describe('parseWeights', () => {
  it('accepts the default set, which is checked like any other file', () => {
    expect(parseWeights({ ...defaultWeights })).toEqual(defaultWeights);
  });

  it('refuses a set that leaves a term out', () => {
    const { life: _dropped, ...rest } = defaultWeights;
    expect(() => parseWeights(rest)).toThrow(InvalidWeightsError);
    expect(() => parseWeights(rest)).toThrow(/life must be a finite number/);
  });

  it('refuses a term that is not a finite number', () => {
    expect(() => parseWeights({ ...defaultWeights, land: Number.NaN })).toThrow(/land/);
    expect(() => parseWeights({ ...defaultWeights, land: '2' })).toThrow(/land/);
    expect(() => parseWeights({ ...defaultWeights, land: Number.POSITIVE_INFINITY })).toThrow(
      /land/,
    );
  });

  /** A misspelt term is a weight nothing reads, and the one it meant to set stays default. */
  it('refuses a term the evaluator does not have', () => {
    expect(() => parseWeights({ ...defaultWeights, lnad: 3 })).toThrow(/lnad is not a weight/);
  });

  it('refuses something that is not an object at all', () => {
    expect(() => parseWeights(null)).toThrow(InvalidWeightsError);
    expect(() => parseWeights([1, 2])).toThrow(InvalidWeightsError);
  });
});

/**
 * The terms that have to agree with each other. The tuning harness (roadmap 4.7) proposes
 * weights nobody has looked at, and these are the proposals that would break an agent
 * without making a single number non-finite.
 */
describe('parseWeights: terms that must agree', () => {
  /** Playing a spare land moves its worth from `spareLand` to `landBeyondTarget`. */
  it('refuses a spare land in hand worth as much as one in play, which is never played', () => {
    const equal = { ...defaultWeights, spareLand: defaultWeights.landBeyondTarget };
    expect(() => parseWeights(equal)).toThrow(/spareLand must be below landBeyondTarget/);
    expect(() =>
      parseWeights({ ...defaultWeights, spareLand: defaultWeights.landBeyondTarget - 0.01 }),
    ).not.toThrow();
  });

  it('refuses a count of lands or of life that is not a whole number', () => {
    expect(() => parseWeights({ ...defaultWeights, landTarget: 7.5 })).toThrow(/landTarget/);
    expect(() => parseWeights({ ...defaultWeights, dangerThreshold: -1 })).toThrow(
      /dangerThreshold/,
    );
    expect(() => parseWeights({ ...defaultWeights, dangerThreshold: 0 })).not.toThrow();
  });
});

describe('how the harness may move each term', () => {
  it('names every term, and tunes every one but the value of a win', () => {
    expect(Object.keys(weightTuning).sort()).toEqual(Object.keys(defaultWeights).sort());
    expect(tunableTerms).not.toContain('win');
    expect(tunableTerms).toHaveLength(Object.keys(defaultWeights).length - 1);
  });

  it('moves the counts by whole steps and everything else by a factor', () => {
    expect(weightTuning.landTarget).toEqual({ kind: 'count', min: 1 });
    expect(weightTuning.dangerThreshold).toEqual({ kind: 'count', min: 0 });
    expect(weightTuning.creaturePower).toEqual({ kind: 'scale' });
  });
});
