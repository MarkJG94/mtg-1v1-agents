import { type Colour, isColour } from '@mtg/shared';

/**
 * Mana costs (CR 107.4, 202).
 *
 * Every non-generic symbol is modelled as a list of *alternative ways to pay it*, which
 * collapses four apparently different symbols into one shape:
 *
 * - `{W}`   → one option: a white mana
 * - `{W/U}` → two options: white or blue
 * - `{2/W}` → two options: two generic, or white
 * - `{W/P}` → two options: white, or 2 life
 *
 * Phyrexian mana is just hybrid mana where one alternative is life, so the solver needs
 * no special case for it — and `{B/G/P}`, which is all three, falls out for free.
 */

export type PayOption =
  | { readonly kind: 'colour'; readonly colour: Colour }
  /** `{C}`: specifically colourless mana, not "any mana". */
  | { readonly kind: 'colourless' }
  /** `{S}`: one mana produced by a snow source, of any type. */
  | { readonly kind: 'snow' }
  | { readonly kind: 'generic'; readonly amount: number }
  | { readonly kind: 'life'; readonly amount: number };

export interface ManaSymbol {
  /** Any one of these pays the symbol. */
  readonly options: readonly PayOption[];
}

export interface ManaCost {
  /** Fixed generic mana, all `{N}` symbols added together. */
  readonly generic: number;
  /** How many `{X}` symbols the cost has. */
  readonly variable: number;
  /** Every symbol that is not plain generic, in printed order. */
  readonly symbols: readonly ManaSymbol[];
}

export const emptyManaCost: ManaCost = Object.freeze({ generic: 0, variable: 0, symbols: [] });

export class ManaCostParseError extends Error {
  constructor(
    message: string,
    readonly cost: string,
  ) {
    super(`${message} (in "${cost}")`);
    this.name = 'ManaCostParseError';
  }
}

const PHYREXIAN_LIFE = 2;

const parseOption = (part: string, raw: string): PayOption => {
  if (/^\d+$/.test(part)) return { kind: 'generic', amount: Number(part) };
  if (isColour(part)) return { kind: 'colour', colour: part };
  if (part === 'C') return { kind: 'colourless' };
  if (part === 'S') return { kind: 'snow' };
  throw new ManaCostParseError(`unknown mana symbol part "${part}"`, raw);
};

const parseSymbol = (body: string, raw: string): ManaSymbol => {
  const parts = body.split('/');

  // A trailing /P makes every other alternative payable with life instead (CR 107.4f).
  const phyrexian = parts.at(-1) === 'P';
  const manaParts = phyrexian ? parts.slice(0, -1) : parts;
  if (manaParts.length === 0) {
    throw new ManaCostParseError('a phyrexian symbol needs a colour', raw);
  }

  const options: PayOption[] = manaParts.map((part) => parseOption(part, raw));
  if (phyrexian) options.push({ kind: 'life', amount: PHYREXIAN_LIFE });
  return { options };
};

/**
 * Parse a Scryfall-style mana cost such as `"{2}{W/U}{B/P}{X}"`. An empty string is a
 * cost of nothing, which is what lands and other costless cards have.
 */
export const parseManaCost = (cost: string): ManaCost => {
  const text = cost.trim();
  if (text === '') return emptyManaCost;

  let generic = 0;
  let variable = 0;
  const symbols: ManaSymbol[] = [];

  const pattern = /\{([^}]*)\}/g;
  let consumed = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    if (match.index !== consumed) {
      throw new ManaCostParseError(`unexpected "${text.slice(consumed, match.index)}"`, cost);
    }
    consumed = match.index + match[0].length;

    const body = (match[1] ?? '').toUpperCase();
    if (body === '') throw new ManaCostParseError('empty symbol "{}"', cost);

    if (/^\d+$/.test(body)) generic += Number(body);
    else if (body === 'X' || body === 'Y' || body === 'Z') variable += 1;
    else symbols.push(parseSymbol(body, cost));

    match = pattern.exec(text);
  }

  if (consumed !== text.length) {
    throw new ManaCostParseError(`unexpected trailing "${text.slice(consumed)}"`, cost);
  }
  return { generic, variable, symbols };
};

const optionValue = (option: PayOption): number => {
  switch (option.kind) {
    case 'generic':
      return option.amount;
    case 'life':
      // Life is not mana, so it contributes nothing to mana value: {W/P} is worth 1.
      return 0;
    default:
      return 1;
  }
};

/** A symbol's mana value is the highest of its alternatives (CR 202.3b). */
export const symbolValue = (symbol: ManaSymbol): number =>
  symbol.options.reduce((best, option) => Math.max(best, optionValue(option)), 0);

/**
 * Mana value (CR 202.3). `{X}` counts as 0 everywhere except on the stack, where it is
 * whatever was chosen (CR 202.3b), so the caller passes the chosen value.
 */
export const manaValue = (cost: ManaCost, x = 0): number =>
  cost.generic + cost.variable * x + cost.symbols.reduce((total, s) => total + symbolValue(s), 0);

/** The colours a cost contains (CR 202.2), used for colour identity and castability. */
export const costColours = (cost: ManaCost): readonly Colour[] => {
  const found = new Set<Colour>();
  for (const symbol of cost.symbols) {
    for (const option of symbol.options) {
      if (option.kind === 'colour') found.add(option.colour);
    }
  }
  return [...found];
};

export const isFreeCost = (cost: ManaCost): boolean =>
  cost.generic === 0 && cost.variable === 0 && cost.symbols.length === 0;

/**
 * Apply a generic cost reduction (CR 601.2f). Reductions only ever reduce the generic
 * part, never coloured symbols, and never below zero.
 */
export const reduceGeneric = (cost: ManaCost, amount: number): ManaCost => {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new RangeError(`reduction must be a non-negative integer, got ${amount}`);
  }
  return amount === 0 ? cost : { ...cost, generic: Math.max(0, cost.generic - amount) };
};

/** Add generic mana to a cost, as taxes such as Thalia do. */
export const increaseGeneric = (cost: ManaCost, amount: number): ManaCost => {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new RangeError(`increase must be a non-negative integer, got ${amount}`);
  }
  return amount === 0 ? cost : { ...cost, generic: cost.generic + amount };
};
