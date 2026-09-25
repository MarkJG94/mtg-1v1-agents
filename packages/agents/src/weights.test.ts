import { describe, expect, it } from 'vitest';
import { defaultWeights, InvalidWeightsError, parseWeights } from './weights.js';

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
