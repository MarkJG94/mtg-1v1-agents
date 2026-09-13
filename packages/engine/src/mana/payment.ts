import type { ManaCost, ManaSymbol, PayOption } from './cost.js';
import { type ManaPool, type ManaType, type ManaUnit, removeMana } from './pool.js';

/**
 * Paying a mana cost (CR 601.2g-h).
 *
 * Deciding whether a cost *can* be paid is a small constraint-satisfaction problem, not a
 * greedy walk: hybrid symbols offer choices, `{2/W}` turns a symbol into generic, a
 * phyrexian symbol can take life instead of mana, `{S}` needs a unit from a snow source,
 * and every unit spent on one symbol is unavailable to the next. Paying `{W/U}{W/U}` from
 * one white and one blue works; paying it from two whites also works; paying `{W/U}{W}`
 * from one white and one blue requires spending the blue on the hybrid, which a
 * left-to-right greedy pass would get wrong.
 *
 * So this searches. It is exact — if it returns null, the cost genuinely cannot be paid
 * from that pool — and it is fast because the search is over *distinct kinds* of unit
 * rather than units, so a pool of ten identical Forest mana branches once, not ten times.
 *
 * Which legal payment it picks is a heuristic: prefer spending colourless and restricted
 * mana first, keeping flexible mana for later costs. Legality never depends on it.
 */

export interface PayCostOptions {
  /** Chosen value of X; the cost's `{X}` symbols each demand this much generic. */
  readonly xValue?: number;
  /** Life the player can spend on phyrexian symbols. */
  readonly life?: number;
  /**
   * Whether a unit carrying a "spend only on ..." rider may pay this cost. Defaults to
   * allowing it, because deciding needs to know what is being cast (roadmap 1.4).
   */
  readonly canSpend?: (unit: ManaUnit) => boolean;
}

export interface ManaPayment {
  /** The units spent, in the order the solver chose them. */
  readonly spent: readonly ManaUnit[];
  /** Life paid for phyrexian symbols. */
  readonly life: number;
  /** The pool with the spent units removed. */
  readonly remaining: ManaPool;
}

/** How much generic mana the cost demands once X is chosen. */
export const genericDemand = (cost: ManaCost, xValue = 0): number =>
  cost.generic + cost.variable * xValue;

/**
 * One mana that is available, which may not have a settled type yet: mana already in the
 * pool has exactly one, while an untapped dual land offers a choice. Modelling both the
 * same way lets one search answer "can I pay this from my pool?" and "could I pay it if I
 * tapped my lands?" without a second, subtly different implementation.
 */
export interface PotentialMana {
  readonly types: readonly ManaType[];
  readonly snow: boolean;
  readonly restriction?: string;
}

const potentialFromUnit = (unit: ManaUnit): PotentialMana =>
  unit.restriction === undefined
    ? { types: [unit.type], snow: unit.snow }
    : { types: [unit.type], snow: unit.snow, restriction: unit.restriction };

const matchesOption = (mana: PotentialMana, option: PayOption): boolean => {
  switch (option.kind) {
    case 'colour':
      return mana.types.includes(option.colour);
    case 'colourless':
      return mana.types.includes('C');
    case 'snow':
      return mana.snow;
    default:
      return false;
  }
};

/**
 * Spend colourless first, then restricted mana, then colours — it keeps the mana most
 * likely to be needed for a coloured symbol later. Purely a preference; see the note
 * above.
 */
const spendPreference = (mana: PotentialMana): number => {
  if (mana.types.length === 1 && mana.types[0] === 'C') return 0;
  if (mana.restriction !== undefined) return 1;
  // A source that could make several colours is the most useful to keep back.
  return 2 + mana.types.length;
};

/** Identity for pruning: two manas alike in every way are interchangeable. */
const signatureOf = (mana: PotentialMana): string =>
  `${[...mana.types].sort().join('')}|${mana.snow ? 1 : 0}|${mana.restriction ?? ''}`;

interface Attempt {
  /** Indices into the caller's `available` array. */
  readonly spent: readonly number[];
  readonly life: number;
}

interface Candidate {
  readonly mana: PotentialMana;
  readonly index: number;
}

const solve = (
  symbols: readonly ManaSymbol[],
  index: number,
  available: readonly Candidate[],
  genericNeeded: number,
  lifeLeft: number,
  spent: readonly number[],
): Attempt | null => {
  if (index === symbols.length) {
    // Generic can be paid by any remaining unit, so only the count matters.
    if (available.length < genericNeeded) return null;
    const forGeneric = [...available]
      .sort((a, b) => spendPreference(a.mana) - spendPreference(b.mana))
      .slice(0, genericNeeded)
      .map((candidate) => candidate.index);
    return { spent: [...spent, ...forGeneric], life: lifeLeft };
  }

  const symbol = symbols[index];
  if (!symbol) return null;

  for (const option of symbol.options) {
    if (option.kind === 'life') {
      if (lifeLeft < option.amount) continue;
      const attempt = solve(
        symbols,
        index + 1,
        available,
        genericNeeded,
        lifeLeft - option.amount,
        spent,
      );
      if (attempt) return attempt;
      continue;
    }

    if (option.kind === 'generic') {
      const attempt = solve(
        symbols,
        index + 1,
        available,
        genericNeeded + option.amount,
        lifeLeft,
        spent,
      );
      if (attempt) return attempt;
      continue;
    }

    // A mana option: try one unit of each distinct kind that matches.
    const tried = new Set<string>();
    for (let i = 0; i < available.length; i += 1) {
      const candidate = available[i];
      if (!candidate || !matchesOption(candidate.mana, option)) continue;

      const signature = signatureOf(candidate.mana);
      if (tried.has(signature)) continue;
      tried.add(signature);

      const rest = [...available.slice(0, i), ...available.slice(i + 1)];
      const attempt = solve(symbols, index + 1, rest, genericNeeded, lifeLeft, [
        ...spent,
        candidate.index,
      ]);
      if (attempt) return attempt;
    }
  }

  return null;
};

/**
 * Find a way to pay `cost` from `pool`, or `null` if there is none.
 *
 * Symbols are tried most-constrained-first, which prunes hard: a `{W}` that only one unit
 * can pay is settled before a `{2/W}` that almost anything can.
 */
export const payCost = (
  pool: ManaPool,
  cost: ManaCost,
  options: PayCostOptions = {},
): ManaPayment | null => {
  const xValue = options.xValue ?? 0;
  if (!Number.isInteger(xValue) || xValue < 0) {
    throw new RangeError(`X must be a non-negative integer, got ${xValue}`);
  }

  const life = options.life ?? 0;
  const canSpend = options.canSpend ?? (() => true);
  const spendable = pool.filter((unit) => canSpend(unit));
  const candidates = spendable.map((unit, index) => ({ mana: potentialFromUnit(unit), index }));

  const attempt = search(cost, candidates, xValue, life);
  if (!attempt) return null;

  const spent = attempt.spent.map((index) => spendable[index] as ManaUnit);
  return { spent, life: life - attempt.life, remaining: removeMana(pool, spent) };
};

/** Order symbols most-constrained-first, then search. */
const search = (
  cost: ManaCost,
  candidates: readonly Candidate[],
  xValue: number,
  life: number,
): Attempt | null => {
  const countMatching = (symbol: ManaSymbol): number =>
    symbol.options.reduce(
      (total, option) =>
        total + candidates.filter((candidate) => matchesOption(candidate.mana, option)).length,
      0,
    );

  const ordered = [...cost.symbols].sort((a, b) => countMatching(a) - countMatching(b));
  return solve(ordered, 0, candidates, genericDemand(cost, xValue), life, []);
};

/**
 * Whether a cost could be paid from mana already in the pool *plus* mana that untapped
 * sources could still make. This is what `legalActions` asks before offering a spell as
 * castable, so it must not over-report: the same exact search decides it.
 *
 * A source that makes several mana at once is expanded into that many entries, which is
 * exact for real cards (Sol Ring always makes two colourless) but would over-report a
 * hypothetical source offering "{G}{G} or {U}".
 */
export const canPayFromSources = (
  pool: ManaPool,
  potential: readonly PotentialMana[],
  cost: ManaCost,
  options: PayCostOptions = {},
): boolean => {
  const xValue = options.xValue ?? 0;
  if (!Number.isInteger(xValue) || xValue < 0) {
    throw new RangeError(`X must be a non-negative integer, got ${xValue}`);
  }
  const canSpend = options.canSpend ?? (() => true);
  const fromPool = pool.filter((unit) => canSpend(unit)).map(potentialFromUnit);
  const candidates = [...fromPool, ...potential].map((mana, index) => ({ mana, index }));
  return search(cost, candidates, xValue, options.life ?? 0) !== null;
};

export const canPayCost = (pool: ManaPool, cost: ManaCost, options: PayCostOptions = {}): boolean =>
  payCost(pool, cost, options) !== null;
