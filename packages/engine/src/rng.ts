/**
 * Seeded pseudo-random number generator (xoshiro128**).
 *
 * Determinism is non-negotiable (docs/00-overview.md): every shuffle, coin flip and
 * AI determinisation draws from one of these, and a game is a pure function of
 * `(seed, deck lists, decision sequence)`. The generator is therefore:
 *
 * - deterministic across platforms (32-bit integer maths only, no floats in the core);
 * - serialisable, so a game state can be checkpointed and resumed mid-game;
 * - forkable, so independent streams (per match, per game, per determinisation) can be
 *   derived from one run seed without one stream's draws shifting another's.
 */

/** The generator's four 32-bit words. Serialisable as-is. */
export type RngState = readonly [number, number, number, number];

export interface Rng {
  /** Uniform integer in [0, 2^32). */
  nextUint32(): number;
  /** Uniform float in [0, 1). */
  nextFloat(): number;
  /** Uniform integer in [0, maxExclusive). Unbiased; `maxExclusive` must be >= 1. */
  nextInt(maxExclusive: number): number;
  /** Uniform integer in [min, maxInclusive]. */
  nextIntBetween(min: number, maxInclusive: number): number;
  /** True with probability `p`. */
  nextBoolean(p?: number): boolean;
  /** Uniformly chosen element. Throws on an empty array. */
  pick<T>(items: readonly T[]): T;
  /** Index chosen in proportion to `weights`. Weights must be finite and non-negative. */
  pickWeightedIndex(weights: readonly number[]): number;
  /** A new array holding a uniformly random permutation (Fisher-Yates). */
  shuffled<T>(items: readonly T[]): T[];
  /**
   * An independent generator derived from this one's current state and `label`.
   * Advances this generator by one draw, so forks are reproducible in order.
   */
  fork(label: string): Rng;
  /** Current state, for checkpointing. */
  save(): RngState;
}

const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

/** SplitMix32: used only to expand a seed into a well-mixed xoshiro state. */
const splitMix32 = (seed: number): (() => number) => {
  let state = seed | 0;
  return () => {
    state = (state + 0x9e3779b9) | 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return (z ^ (z >>> 15)) >>> 0;
  };
};

/** FNV-1a over UTF-16 code units. Only used to turn labels and string seeds into words. */
const hashString = (value: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
};

/**
 * Accepted seed forms. A run's seed is a 64-bit value carried as a decimal string
 * (see `@mtg/shared`), but numbers and bigints are accepted for convenience in tests.
 */
export type RngSeed = number | bigint | string;

const seedToWords = (seed: RngSeed): [number, number] => {
  if (typeof seed === 'number') {
    if (!Number.isFinite(seed)) throw new RangeError(`rng seed must be finite, got ${seed}`);
    const asBig = BigInt(Math.trunc(seed));
    return bigintToWords(asBig < 0n ? -asBig : asBig);
  }
  if (typeof seed === 'bigint') return bigintToWords(seed < 0n ? -seed : seed);
  // A decimal string is a numeric seed; anything else is hashed as text.
  if (/^(0|[1-9][0-9]*)$/.test(seed)) return bigintToWords(BigInt(seed));
  return [hashString(seed), hashString(`${seed}#high`)];
};

const bigintToWords = (value: bigint): [number, number] => [
  Number(value & 0xffffffffn) >>> 0,
  Number((value >> 32n) & 0xffffffffn) >>> 0,
];

/** xoshiro is undefined on an all-zero state, so substitute a fixed non-zero one. */
const nonZero = (state: RngState): RngState =>
  state.some((word) => word !== 0) ? state : [0x9e3779b9, 0x243f6a88, 0xb7e15162, 0x85a308d3];

/** Expand a seed into a xoshiro state that is never all-zero. */
export const stateFromSeed = (seed: RngSeed): RngState => {
  const [low, high] = seedToWords(seed);
  const mix = splitMix32((low ^ Math.imul(high, 0x9e3779b9)) >>> 0);
  return nonZero([mix(), mix(), mix(), mix()]);
};

/** Create a generator from a seed. */
export const createRng = (seed: RngSeed): Rng => rngFromState(stateFromSeed(seed));

/** Restore a generator from a checkpointed state. */
export const rngFromState = (initial: RngState): Rng => {
  let [s0, s1, s2, s3] = initial;

  const nextUint32 = (): number => {
    const result = Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (s1 << 9) >>> 0;
    s2 = (s2 ^ s0) >>> 0;
    s3 = (s3 ^ s1) >>> 0;
    s1 = (s1 ^ s2) >>> 0;
    s0 = (s0 ^ s3) >>> 0;
    s2 = (s2 ^ t) >>> 0;
    s3 = rotl(s3, 11);
    return result;
  };

  const nextInt = (maxExclusive: number): number => {
    if (!Number.isInteger(maxExclusive) || maxExclusive < 1) {
      throw new RangeError(`nextInt bound must be a positive integer, got ${maxExclusive}`);
    }
    if (maxExclusive > 0x100000000) {
      throw new RangeError(`nextInt bound must be at most 2^32, got ${maxExclusive}`);
    }
    // Lemire-style rejection: discard the biased tail so every value is equally likely.
    const limit = 0x100000000 - (0x100000000 % maxExclusive);
    let draw = nextUint32();
    while (draw >= limit) draw = nextUint32();
    return draw % maxExclusive;
  };

  const rng: Rng = {
    nextUint32,
    nextFloat: () => nextUint32() * 2 ** -32,
    nextInt,
    nextIntBetween: (min, maxInclusive) => {
      if (!Number.isInteger(min) || !Number.isInteger(maxInclusive)) {
        throw new RangeError('nextIntBetween bounds must be integers');
      }
      if (maxInclusive < min) {
        throw new RangeError(`empty range [${min}, ${maxInclusive}]`);
      }
      return min + nextInt(maxInclusive - min + 1);
    },
    nextBoolean: (p = 0.5) => rng.nextFloat() < p,
    pick: <T>(items: readonly T[]): T => {
      if (items.length === 0) throw new RangeError('pick from an empty array');
      // biome-ignore lint/style/noNonNullAssertion: index is in range by construction.
      return items[nextInt(items.length)]!;
    },
    pickWeightedIndex: (weights) => {
      let total = 0;
      for (const weight of weights) {
        if (!Number.isFinite(weight) || weight < 0) {
          throw new RangeError(`weights must be finite and non-negative, got ${weight}`);
        }
        total += weight;
      }
      if (total <= 0) throw new RangeError('weights must not sum to zero');
      let threshold = rng.nextFloat() * total;
      for (let i = 0; i < weights.length; i += 1) {
        threshold -= weights[i] ?? 0;
        if (threshold < 0) return i;
      }
      return weights.length - 1;
    },
    shuffled: <T>(items: readonly T[]): T[] => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = nextInt(i + 1);
        // biome-ignore lint/style/noNonNullAssertion: both indices are within the array.
        const tmp = out[i]!;
        // biome-ignore lint/style/noNonNullAssertion: both indices are within the array.
        out[i] = out[j]!;
        out[j] = tmp;
      }
      return out;
    },
    fork: (label) => {
      const mix = splitMix32((nextUint32() ^ hashString(label)) >>> 0);
      return rngFromState(nonZero([mix(), mix(), mix(), mix()]));
    },
    save: () => [s0, s1, s2, s3] as RngState,
  };

  return rng;
};
