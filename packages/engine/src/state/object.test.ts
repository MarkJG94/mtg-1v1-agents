import { asOracleId } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { stateFromSeed } from '../rng.js';
import { createGameState } from './game-state.js';
import { countersOf, withCounters } from './object.js';
import { createObject } from './update.js';

const anObject = () =>
  createObject(createGameState({ rng: stateFromSeed('1'), onPlay: 'A' }), {
    definitionId: asOracleId('oracle-x'),
    owner: 'A',
    zone: 'battlefield',
  }).object;

describe('counters', () => {
  it('reports zero for a counter the object does not have', () => {
    expect(countersOf(anObject(), '+1/+1')).toBe(0);
  });

  it('sets and reads a counter without mutating the original', () => {
    const before = anObject();
    const after = withCounters(before, '+1/+1', 3);
    expect(countersOf(after, '+1/+1')).toBe(3);
    expect(countersOf(before, '+1/+1')).toBe(0);
  });

  it('removes the key when a counter drops to zero', () => {
    const withOne = withCounters(anObject(), 'loyalty', 1);
    const withNone = withCounters(withOne, 'loyalty', 0);
    expect(withNone.counters).toEqual({});
    expect(countersOf(withNone, 'loyalty')).toBe(0);
  });

  it('keeps other counters when one changes', () => {
    const both = withCounters(withCounters(anObject(), '+1/+1', 2), 'charge', 1);
    const changed = withCounters(both, '+1/+1', 5);
    expect(changed.counters).toEqual({ '+1/+1': 5, charge: 1 });
  });

  it('allows negative counts, which -1/-1 annihilation needs mid-calculation', () => {
    expect(countersOf(withCounters(anObject(), '-1/-1', -2), '-1/-1')).toBe(-2);
  });

  it('rejects a fractional count', () => {
    expect(() => withCounters(anObject(), '+1/+1', 1.5)).toThrow(RangeError);
  });
});
