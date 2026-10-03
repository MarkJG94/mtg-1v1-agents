import type { Colour } from '@mtg/shared';

/**
 * The mana pool (CR 106).
 *
 * Mana is held as individual units rather than as a count per colour, because a unit of
 * mana carries more than its type: whether it came from a snow source (which {S} costs
 * care about) and any "spend this mana only on ..." rider. Counting by colour would throw
 * that away, and docs/02 lists exactly those riders as part of what makes payment a
 * constraint problem.
 */

/** The six types mana can be (CR 106.1): the five colours plus colourless. */
export const manaTypes = ['W', 'U', 'B', 'R', 'G', 'C'] as const;
export type ManaType = (typeof manaTypes)[number];

export const isColouredMana = (type: ManaType): type is Colour => type !== 'C';

export interface ManaUnit {
  readonly type: ManaType;
  /** Produced by a snow source, so it can pay {S} (CR 107.4h). */
  readonly snow: boolean;
  /**
   * An opaque "spend only on ..." rider (CR 106.6). The engine carries it; deciding
   * whether a given spell satisfies it needs to know what is being cast, which arrives
   * with casting in roadmap 1.4.
   */
  readonly restriction?: string;
}

export type ManaPool = readonly ManaUnit[];

export const emptyManaPool: ManaPool = Object.freeze([]);

export const manaPoolSize = (pool: ManaPool): number => pool.length;

export const isManaPoolEmpty = (pool: ManaPool): boolean => pool.length === 0;

export const countMana = (pool: ManaPool, type: ManaType): number =>
  pool.reduce((total, unit) => (unit.type === type ? total + 1 : total), 0);

/** Counts by type, for display and for the evaluator. */
export const manaPoolCounts = (pool: ManaPool): Record<ManaType, number> => {
  const counts = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  for (const unit of pool) counts[unit.type] += 1;
  return counts;
};

export interface AddManaOptions {
  readonly snow?: boolean;
  readonly restriction?: string;
}

export const addMana = (
  pool: ManaPool,
  type: ManaType,
  amount = 1,
  options: AddManaOptions = {},
): ManaPool => {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new RangeError(`mana amount must be a non-negative integer, got ${amount}`);
  }
  if (amount === 0) return pool;

  const unit: ManaUnit =
    options.restriction === undefined
      ? { type, snow: options.snow ?? false }
      : { type, snow: options.snow ?? false, restriction: options.restriction };
  return [...pool, ...Array.from({ length: amount }, () => unit)];
};

/**
 * Remove specific units, by identity. The payment solver picks which units to spend, so
 * removal takes the units themselves rather than a type and a count.
 */
export const removeMana = (pool: ManaPool, units: readonly ManaUnit[]): ManaPool => {
  const remaining = [...pool];
  for (const unit of units) {
    const index = remaining.indexOf(unit);
    if (index === -1) throw new RangeError('cannot spend a mana unit that is not in the pool');
    remaining.splice(index, 1);
  }
  return remaining;
};

/**
 * Empty the pool. Happens as each step and phase ends (CR 500.4); mana that "doesn't
 * empty" is a rider the units will carry when such cards are scripted.
 */
export const emptyPool = (): ManaPool => emptyManaPool;
