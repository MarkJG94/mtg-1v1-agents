import { describe, expect, it } from 'vitest';
import type { ManaPool, ManaUnit } from './pool.js';
import {
  addMana,
  countMana,
  emptyManaPool,
  isColouredMana,
  isManaPoolEmpty,
  manaPoolCounts,
  manaPoolSize,
  manaTypes,
  removeMana,
} from './pool.js';

/** Index into a pool with a real check, so tests need no non-null assertions. */
const unitAt = (pool: ManaPool, index: number): ManaUnit => {
  const unit = pool[index];
  if (!unit) throw new Error(`expected a mana unit at index ${index}`);
  return unit;
};

describe('the mana pool', () => {
  it('starts empty', () => {
    expect(isManaPoolEmpty(emptyManaPool)).toBe(true);
    expect(manaPoolSize(emptyManaPool)).toBe(0);
    expect(manaPoolCounts(emptyManaPool)).toEqual({ W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 });
  });

  it('covers the five colours plus colourless', () => {
    expect(manaTypes).toEqual(['W', 'U', 'B', 'R', 'G', 'C']);
    expect(manaTypes.filter(isColouredMana)).toEqual(['W', 'U', 'B', 'R', 'G']);
  });

  it('adds mana without mutating the pool it was given', () => {
    const pool = addMana(emptyManaPool, 'R', 2);
    expect(manaPoolSize(pool)).toBe(2);
    expect(countMana(pool, 'R')).toBe(2);
    expect(emptyManaPool).toHaveLength(0);
  });

  it('defaults to adding a single mana', () => {
    expect(manaPoolSize(addMana(emptyManaPool, 'G'))).toBe(1);
  });

  it('accumulates across types', () => {
    const pool = addMana(addMana(emptyManaPool, 'G', 1), 'C', 3);
    expect(manaPoolCounts(pool)).toMatchObject({ G: 1, C: 3, W: 0 });
    expect(manaPoolSize(pool)).toBe(4);
  });

  it('returns the same pool when adding zero', () => {
    expect(addMana(emptyManaPool, 'W', 0)).toBe(emptyManaPool);
  });

  it('rejects negative and fractional amounts', () => {
    expect(() => addMana(emptyManaPool, 'R', -1)).toThrow(RangeError);
    expect(() => addMana(emptyManaPool, 'R', 1.5)).toThrow(RangeError);
  });
});

describe('mana carries more than its type', () => {
  it('records that mana came from a snow source', () => {
    const pool = addMana(emptyManaPool, 'G', 1, { snow: true });
    expect(pool[0]).toMatchObject({ type: 'G', snow: true });
  });

  it('defaults to not snow', () => {
    expect(unitAt(addMana(emptyManaPool, 'G'), 0).snow).toBe(false);
  });

  it('records a spend restriction when one is given', () => {
    const pool = addMana(emptyManaPool, 'R', 1, { restriction: 'creature-spells-only' });
    expect(pool[0]?.restriction).toBe('creature-spells-only');
  });

  it('leaves the restriction absent rather than undefined when there is none', () => {
    expect(Object.hasOwn(unitAt(addMana(emptyManaPool, 'R'), 0), 'restriction')).toBe(false);
  });
});

describe('removeMana', () => {
  it('removes the units it is given', () => {
    const pool = addMana(addMana(emptyManaPool, 'R', 1), 'G', 1);
    const remaining = removeMana(pool, [unitAt(pool, 0)]);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.type).toBe('G');
  });

  it('removes one occurrence per unit, not every matching one', () => {
    const pool = addMana(emptyManaPool, 'R', 3);
    expect(removeMana(pool, [unitAt(pool, 0)])).toHaveLength(2);
    expect(removeMana(pool, [unitAt(pool, 0), unitAt(pool, 1)])).toHaveLength(1);
  });

  it('does not mutate the original pool', () => {
    const pool = addMana(emptyManaPool, 'R', 2);
    removeMana(pool, [unitAt(pool, 0)]);
    expect(pool).toHaveLength(2);
  });

  it('refuses to spend mana that is not in the pool', () => {
    const pool = addMana(emptyManaPool, 'R', 1);
    const foreign = unitAt(addMana(emptyManaPool, 'U', 1), 0);
    expect(() => removeMana(pool, [foreign])).toThrow(RangeError);
  });

  it('removing nothing leaves the pool as it was', () => {
    const pool = addMana(emptyManaPool, 'R', 2);
    expect(removeMana(pool, [])).toEqual(pool);
  });
});

describe('countMana', () => {
  it('counts one type', () => {
    const pool = addMana(addMana(emptyManaPool, 'U', 2), 'R', 1);
    expect(countMana(pool, 'U')).toBe(2);
    expect(countMana(pool, 'R')).toBe(1);
    expect(countMana(pool, 'W')).toBe(0);
  });
});
