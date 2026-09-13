import type { ManaCost, ManaSymbol, PayOption } from './cost.js';
import { type ManaPool, type ManaUnit, removeMana } from './pool.js';

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

const matchesOption = (unit: ManaUnit, option: PayOption): boolean => {
  switch (option.kind) {
    case 'colour':
      return unit.type === option.colour;
    case 'colourless':
      return unit.type === 'C';
    case 'snow':
      return unit.snow;
    default:
      return false;
  }
};

/**
 * Spend colourless first, then restricted mana, then colours — it keeps the mana most
 * likely to be needed for a coloured symbol later. Purely a preference; see the note
 * above.
 */
const spendPreference = (unit: ManaUnit): number => {
  if (unit.type === 'C') return 0;
  if (unit.restriction !== undefined) return 1;
  return 2;
};

/** A unit's identity for pruning: two units alike in every way are interchangeable. */
const signatureOf = (unit: ManaUnit): string =>
  `${unit.type}|${unit.snow ? 1 : 0}|${unit.restriction ?? ''}`;

interface Attempt {
  readonly spent: readonly ManaUnit[];
  readonly life: number;
}

const solve = (
  symbols: readonly ManaSymbol[],
  index: number,
  available: readonly ManaUnit[],
  genericNeeded: number,
  lifeLeft: number,
  spent: readonly ManaUnit[],
): Attempt | null => {
  if (index === symbols.length) {
    // Generic can be paid by any remaining unit, so only the count matters.
    if (available.length < genericNeeded) return null;
    const forGeneric = [...available]
      .sort((a, b) => spendPreference(a) - spendPreference(b))
      .slice(0, genericNeeded);
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
      const unit = available[i];
      if (!unit || !matchesOption(unit, option)) continue;

      const signature = signatureOf(unit);
      if (tried.has(signature)) continue;
      tried.add(signature);

      const rest = [...available.slice(0, i), ...available.slice(i + 1)];
      const attempt = solve(symbols, index + 1, rest, genericNeeded, lifeLeft, [...spent, unit]);
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
  const available = pool.filter((unit) => canSpend(unit));

  const countMatching = (symbol: ManaSymbol): number =>
    symbol.options.reduce(
      (total, option) => total + available.filter((unit) => matchesOption(unit, option)).length,
      0,
    );

  const ordered = [...cost.symbols].sort((a, b) => countMatching(a) - countMatching(b));

  const attempt = solve(ordered, 0, available, genericDemand(cost, xValue), life, []);
  if (!attempt) return null;

  return {
    spent: attempt.spent,
    life: life - attempt.life,
    remaining: removeMana(pool, attempt.spent),
  };
};

export const canPayCost = (pool: ManaPool, cost: ManaCost, options: PayCostOptions = {}): boolean =>
  payCost(pool, cost, options) !== null;
