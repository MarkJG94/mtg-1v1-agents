import { describe, expect, it } from 'vitest';
import { createRng, rngFromState, stateFromSeed } from './rng.js';

const draw = (seed: string | number | bigint, count = 20): number[] => {
  const rng = createRng(seed);
  return Array.from({ length: count }, () => rng.nextUint32());
};

describe('createRng', () => {
  it('is deterministic: the same seed gives the same stream', () => {
    expect(draw('12345')).toEqual(draw('12345'));
  });

  it('gives different streams for different seeds', () => {
    expect(draw('1')).not.toEqual(draw('2'));
  });

  it('treats a decimal string, a number and a bigint seed as the same seed', () => {
    expect(draw('987654321')).toEqual(draw(987654321));
    expect(draw('987654321')).toEqual(draw(987654321n));
  });

  it('accepts a full 64-bit seed', () => {
    const stream = draw('18446744073709551615');
    expect(stream).toHaveLength(20);
    expect(new Set(stream).size).toBeGreaterThan(15);
  });

  it('hashes a non-numeric seed rather than rejecting it', () => {
    expect(draw('cycle-3/match-7')).toEqual(draw('cycle-3/match-7'));
    expect(draw('cycle-3/match-7')).not.toEqual(draw('cycle-3/match-8'));
  });

  it('never produces an all-zero state', () => {
    for (const seed of ['0', '1', 'x', '4294967296']) {
      expect(stateFromSeed(seed).some((word) => word !== 0)).toBe(true);
    }
  });

  it('emits unsigned 32-bit integers', () => {
    for (const value of draw('7', 500)) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(2 ** 32);
    }
  });
});

describe('nextFloat', () => {
  it('stays in [0, 1)', () => {
    const rng = createRng('99');
    for (let i = 0; i < 2000; i += 1) {
      const value = rng.nextFloat();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('has roughly the right mean', () => {
    const rng = createRng('mean');
    let total = 0;
    const n = 100_000;
    for (let i = 0; i < n; i += 1) total += rng.nextFloat();
    expect(total / n).toBeCloseTo(0.5, 2);
  });
});

describe('nextInt', () => {
  it('stays in range', () => {
    const rng = createRng('range');
    for (let i = 0; i < 2000; i += 1) {
      const value = rng.nextInt(7);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(7);
    }
  });

  it('covers every value of a small range roughly evenly', () => {
    const rng = createRng('uniform');
    const counts = new Array<number>(6).fill(0);
    const n = 60_000;
    for (let i = 0; i < n; i += 1) bump(counts, rng.nextInt(6));
    for (const count of counts) expect(Math.abs(count - n / 6)).toBeLessThan(n / 60);
  });

  it('always returns 0 for a bound of 1', () => {
    const rng = createRng('one');
    for (let i = 0; i < 50; i += 1) expect(rng.nextInt(1)).toBe(0);
  });

  it.each([0, -1, 1.5, 2 ** 32 + 1])('rejects the bound %s', (bound) => {
    expect(() => createRng('bad').nextInt(bound)).toThrow(RangeError);
  });
});

describe('nextIntBetween', () => {
  it('includes both endpoints', () => {
    const rng = createRng('endpoints');
    const seen = new Set<number>();
    for (let i = 0; i < 500; i += 1) seen.add(rng.nextIntBetween(3, 5));
    expect([...seen].sort()).toEqual([3, 4, 5]);
  });

  it('handles a single-value range', () => {
    expect(createRng('x').nextIntBetween(4, 4)).toBe(4);
  });

  it('rejects an inverted range', () => {
    expect(() => createRng('x').nextIntBetween(5, 4)).toThrow(RangeError);
  });
});

describe('pick and pickWeightedIndex', () => {
  it('picks from the array', () => {
    const rng = createRng('pick');
    const items = ['a', 'b', 'c'] as const;
    for (let i = 0; i < 100; i += 1) expect(items).toContain(rng.pick(items));
  });

  it('throws on an empty array', () => {
    expect(() => createRng('x').pick([])).toThrow(RangeError);
  });

  it('never picks a zero-weight index', () => {
    const rng = createRng('weights');
    for (let i = 0; i < 500; i += 1) expect(rng.pickWeightedIndex([1, 0, 1])).not.toBe(1);
  });

  it('respects the weights (30/50/20, decision D17)', () => {
    const rng = createRng('colours');
    const counts = [0, 0, 0];
    const n = 30_000;
    for (let i = 0; i < n; i += 1) bump(counts, rng.pickWeightedIndex([30, 50, 20]));
    expect((counts[0] ?? 0) / n).toBeCloseTo(0.3, 1);
    expect((counts[1] ?? 0) / n).toBeCloseTo(0.5, 1);
    expect((counts[2] ?? 0) / n).toBeCloseTo(0.2, 1);
  });

  it('rejects weights that sum to zero or are negative', () => {
    expect(() => createRng('x').pickWeightedIndex([0, 0])).toThrow(RangeError);
    expect(() => createRng('x').pickWeightedIndex([1, -1])).toThrow(RangeError);
  });
});

describe('shuffled', () => {
  const deck = Array.from({ length: 60 }, (_, i) => i);

  it('returns a permutation and leaves the input untouched', () => {
    const input = [...deck];
    const out = createRng('shuffle').shuffled(input);
    expect(out).not.toBe(input);
    expect(input).toEqual(deck);
    expect([...out].sort((a, b) => a - b)).toEqual(deck);
  });

  it('is deterministic for a seed', () => {
    expect(createRng('s').shuffled(deck)).toEqual(createRng('s').shuffled(deck));
    expect(createRng('s').shuffled(deck)).not.toEqual(createRng('t').shuffled(deck));
  });

  it('actually moves cards', () => {
    expect(createRng('s').shuffled(deck)).not.toEqual(deck);
  });

  it('handles empty and single-element arrays', () => {
    expect(createRng('s').shuffled([])).toEqual([]);
    expect(createRng('s').shuffled(['only'])).toEqual(['only']);
  });

  it('reaches every permutation of a 3-element array', () => {
    const rng = createRng('perm');
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) seen.add(rng.shuffled([1, 2, 3]).join(''));
    expect(seen.size).toBe(6);
  });
});

describe('save and restore', () => {
  it('resumes the exact stream from a checkpoint', () => {
    const rng = createRng('checkpoint');
    for (let i = 0; i < 10; i += 1) rng.nextUint32();
    const state = rng.save();
    const expected = Array.from({ length: 10 }, () => rng.nextUint32());
    const resumed = rngFromState(state);
    expect(Array.from({ length: 10 }, () => resumed.nextUint32())).toEqual(expected);
  });

  it('returns a snapshot that later draws do not mutate', () => {
    const rng = createRng('snapshot');
    const before = rng.save();
    rng.nextUint32();
    expect(rng.save()).not.toEqual(before);
    expect(before).toEqual(createRng('snapshot').save());
  });
});

describe('fork', () => {
  it('derives reproducible independent streams', () => {
    const a = createRng('run').fork('match-1');
    const b = createRng('run').fork('match-1');
    expect(draw24(a)).toEqual(draw24(b));
  });

  it('gives different streams for different labels', () => {
    const parent = createRng('run');
    const first = parent.fork('match-1');
    const second = createRng('run').fork('match-2');
    expect(draw24(first)).not.toEqual(draw24(second));
  });

  it('advances the parent, so forks in sequence differ', () => {
    const parent = createRng('run');
    const first = parent.fork('game');
    const second = parent.fork('game');
    expect(draw24(first)).not.toEqual(draw24(second));
  });

  it('leaves a fork unaffected by further draws on the parent', () => {
    const parent = createRng('run');
    const child = parent.fork('game');
    const expected = draw24(child);
    const parent2 = createRng('run');
    const child2 = parent2.fork('game');
    for (let i = 0; i < 100; i += 1) parent2.nextUint32();
    expect(draw24(child2)).toEqual(expected);
  });
});

function draw24(rng: { nextUint32(): number }): number[] {
  return Array.from({ length: 24 }, () => rng.nextUint32());
}

function bump(counts: number[], index: number): void {
  counts[index] = (counts[index] ?? 0) + 1;
}
