import { describe, expect, it } from 'vitest';
import {
  addMana,
  emptyManaPool,
  isManaPoolEmpty,
  manaPoolSize,
  manaTypes,
  spendMana,
} from './mana.js';

describe('the mana pool', () => {
  it('starts empty in every type', () => {
    for (const type of manaTypes) expect(emptyManaPool[type]).toBe(0);
    expect(isManaPoolEmpty(emptyManaPool)).toBe(true);
    expect(manaPoolSize(emptyManaPool)).toBe(0);
  });

  it('adds mana without mutating the pool it was given', () => {
    const pool = addMana(emptyManaPool, 'R', 2);
    expect(pool.R).toBe(2);
    expect(emptyManaPool.R).toBe(0);
    expect(manaPoolSize(pool)).toBe(2);
    expect(isManaPoolEmpty(pool)).toBe(false);
  });

  it('accumulates across types', () => {
    const pool = addMana(addMana(emptyManaPool, 'G', 1), 'C', 3);
    expect(pool).toMatchObject({ G: 1, C: 3, W: 0 });
    expect(manaPoolSize(pool)).toBe(4);
  });

  it('returns the same pool when adding zero', () => {
    expect(addMana(emptyManaPool, 'W', 0)).toBe(emptyManaPool);
  });

  it('spends mana', () => {
    const pool = spendMana(addMana(emptyManaPool, 'U', 3), 'U', 2);
    expect(pool.U).toBe(1);
  });

  it('refuses to spend mana that is not there', () => {
    expect(() => spendMana(emptyManaPool, 'B', 1)).toThrow(RangeError);
    expect(() => spendMana(addMana(emptyManaPool, 'B', 1), 'B', 2)).toThrow(/pool holds 1/);
  });

  it('rejects negative and fractional amounts', () => {
    expect(() => addMana(emptyManaPool, 'R', -1)).toThrow(RangeError);
    expect(() => addMana(emptyManaPool, 'R', 1.5)).toThrow(RangeError);
    expect(() => spendMana(emptyManaPool, 'R', -1)).toThrow(RangeError);
  });
});
