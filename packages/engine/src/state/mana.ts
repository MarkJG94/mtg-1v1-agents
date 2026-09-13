/**
 * Mana types (CR 106.1). Costs, the payment solver and mana abilities are roadmap 1.3;
 * the pool itself is simple enough to belong to the core state model.
 */
export const manaTypes = ['W', 'U', 'B', 'R', 'G', 'C'] as const;
export type ManaType = (typeof manaTypes)[number];

export type ManaPool = Readonly<Record<ManaType, number>>;

export const emptyManaPool: ManaPool = Object.freeze({ W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 });

export const manaPoolSize = (pool: ManaPool): number =>
  pool.W + pool.U + pool.B + pool.R + pool.G + pool.C;

export const isManaPoolEmpty = (pool: ManaPool): boolean => manaPoolSize(pool) === 0;

export const addMana = (pool: ManaPool, type: ManaType, amount: number): ManaPool => {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new RangeError(`mana amount must be a non-negative integer, got ${amount}`);
  }
  return amount === 0 ? pool : { ...pool, [type]: pool[type] + amount };
};

export const spendMana = (pool: ManaPool, type: ManaType, amount: number): ManaPool => {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new RangeError(`mana amount must be a non-negative integer, got ${amount}`);
  }
  if (pool[type] < amount) {
    throw new RangeError(`cannot spend ${amount} ${type}: pool holds ${pool[type]}`);
  }
  return amount === 0 ? pool : { ...pool, [type]: pool[type] - amount };
};
