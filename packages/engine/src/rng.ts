/** xoshiro128** state: four 32-bit words. Kept as a plain tuple so it can live inside GameState. */
export type RngState = readonly [number, number, number, number];

function splitmix32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    t ^= t >>> 15;
    return t >>> 0;
  };
}

function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function seedRng(seed: string | number): RngState {
  const base = typeof seed === 'number' ? seed >>> 0 : hashString(seed);
  const next = splitmix32(base);
  let s: RngState = [next(), next(), next(), next()];
  if (s[0] === 0 && s[1] === 0 && s[2] === 0 && s[3] === 0) s = [1, 2, 3, 4];
  return s;
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

export function nextU32(s: RngState): [number, RngState] {
  const [s0, s1, s2, s3] = s;
  const result = Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
  const t = (s1 << 9) >>> 0;
  let n2 = (s2 ^ s0) >>> 0;
  let n3 = (s3 ^ s1) >>> 0;
  const n1 = (s1 ^ n2) >>> 0;
  const n0 = (s0 ^ n3) >>> 0;
  n2 = (n2 ^ t) >>> 0;
  n3 = rotl(n3, 11);
  return [result, [n0, n1, n2, n3]];
}

/** Uniform integer in [0, n). */
export function nextInt(s: RngState, n: number): [number, RngState] {
  if (n <= 0) throw new Error('nextInt: n must be positive');
  // Rejection sampling to avoid modulo bias.
  const limit = 0x100000000 - (0x100000000 % n);
  let state = s;
  for (;;) {
    const [v, ns] = nextU32(state);
    state = ns;
    if (v < limit) return [v % n, state];
  }
}

/** Fisher–Yates shuffle returning a new array. */
export function shuffle<T>(s: RngState, items: readonly T[]): [T[], RngState] {
  const out = items.slice();
  let state = s;
  for (let i = out.length - 1; i > 0; i--) {
    const [j, ns] = nextInt(state, i + 1);
    state = ns;
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return [out, state];
}

/** Mutable convenience wrapper used by agents and tests (never by the engine core). */
export class Rng {
  constructor(public state: RngState) {}
  static from(seed: string | number): Rng {
    return new Rng(seedRng(seed));
  }
  u32(): number {
    const [v, s] = nextU32(this.state);
    this.state = s;
    return v;
  }
  int(n: number): number {
    const [v, s] = nextInt(this.state, n);
    this.state = s;
    return v;
  }
  float(): number {
    return this.u32() / 0x100000000;
  }
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from empty array');
    return items[this.int(items.length)]!;
  }
  bool(p = 0.5): boolean {
    return this.float() < p;
  }
  shuffle<T>(items: readonly T[]): T[] {
    const [out, s] = shuffle(this.state, items);
    this.state = s;
    return out;
  }
  fork(): Rng {
    return new Rng(seedRng(this.u32()));
  }
}
