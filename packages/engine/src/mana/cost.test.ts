import { describe, expect, it } from 'vitest';
import {
  costColours,
  emptyManaCost,
  increaseGeneric,
  isFreeCost,
  ManaCostParseError,
  manaValue,
  parseManaCost,
  reduceGeneric,
  symbolValue,
} from './cost.js';

describe('parseManaCost', () => {
  it('reads a plain generic cost', () => {
    expect(parseManaCost('{3}')).toEqual({ generic: 3, variable: 0, symbols: [] });
  });

  it('adds several generic symbols together', () => {
    expect(parseManaCost('{2}{1}').generic).toBe(3);
  });

  it('reads coloured symbols in order', () => {
    const cost = parseManaCost('{1}{U}{U}');
    expect(cost.generic).toBe(1);
    expect(cost.symbols).toEqual([
      { options: [{ kind: 'colour', colour: 'U' }] },
      { options: [{ kind: 'colour', colour: 'U' }] },
    ]);
  });

  it('reads colourless {C} as its own thing, not as generic', () => {
    const cost = parseManaCost('{C}');
    expect(cost.generic).toBe(0);
    expect(cost.symbols).toEqual([{ options: [{ kind: 'colourless' }] }]);
  });

  it('reads snow', () => {
    expect(parseManaCost('{S}').symbols).toEqual([{ options: [{ kind: 'snow' }] }]);
  });

  it('reads a colour/colour hybrid', () => {
    expect(parseManaCost('{W/U}').symbols).toEqual([
      {
        options: [
          { kind: 'colour', colour: 'W' },
          { kind: 'colour', colour: 'U' },
        ],
      },
    ]);
  });

  it('reads a monocolour hybrid as "generic or colour"', () => {
    expect(parseManaCost('{2/W}').symbols).toEqual([
      {
        options: [
          { kind: 'generic', amount: 2 },
          { kind: 'colour', colour: 'W' },
        ],
      },
    ]);
  });

  it('reads phyrexian mana as "colour or 2 life" (CR 107.4f)', () => {
    expect(parseManaCost('{W/P}').symbols).toEqual([
      {
        options: [
          { kind: 'colour', colour: 'W' },
          { kind: 'life', amount: 2 },
        ],
      },
    ]);
  });

  it('reads hybrid phyrexian, which is all three at once', () => {
    expect(parseManaCost('{B/G/P}').symbols).toEqual([
      {
        options: [
          { kind: 'colour', colour: 'B' },
          { kind: 'colour', colour: 'G' },
          { kind: 'life', amount: 2 },
        ],
      },
    ]);
  });

  it('counts {X} symbols', () => {
    expect(parseManaCost('{X}{R}').variable).toBe(1);
    expect(parseManaCost('{X}{X}{R}').variable).toBe(2);
  });

  it('treats an empty cost as free, which is what lands have', () => {
    expect(parseManaCost('')).toEqual(emptyManaCost);
    expect(parseManaCost('   ')).toEqual(emptyManaCost);
    expect(isFreeCost(parseManaCost(''))).toBe(true);
  });

  it('accepts lowercase', () => {
    expect(parseManaCost('{2}{u}')).toEqual(parseManaCost('{2}{U}'));
  });

  it('parses a genuinely complicated cost', () => {
    const cost = parseManaCost('{X}{2}{W/U}{B/P}{C}{S}');
    expect(cost.generic).toBe(2);
    expect(cost.variable).toBe(1);
    expect(cost.symbols).toHaveLength(4);
  });

  it.each([
    ['a stray character', '{2}x'],
    ['text before a symbol', 'x{2}'],
    ['an unclosed brace', '{2'],
    ['an empty symbol', '{}'],
    ['an unknown symbol', '{Q}'],
    ['an unknown hybrid part', '{W/Q}'],
    ['a lone phyrexian marker', '{P}'],
  ])('rejects %s', (_label, text) => {
    expect(() => parseManaCost(text)).toThrow(ManaCostParseError);
  });

  it('names the offending cost in the error', () => {
    expect(() => parseManaCost('{Q}')).toThrow(/in "\{Q\}"/);
  });
});

describe('manaValue (CR 202.3)', () => {
  it.each([
    ['{0}', 0],
    ['', 0],
    ['{3}', 3],
    ['{1}{U}{U}', 3],
    ['{C}', 1],
    ['{S}', 1],
    ['{W/U}', 1],
    ['{2/W}', 2],
    ['{W/P}', 1],
    ['{B/G/P}', 1],
    ['{2/W}{2/W}', 4],
  ])('values %s at %i', (text, expected) => {
    expect(manaValue(parseManaCost(text))).toBe(expected);
  });

  it('counts {X} as zero unless a value is given (CR 202.3b)', () => {
    expect(manaValue(parseManaCost('{X}{R}'))).toBe(1);
    expect(manaValue(parseManaCost('{X}{R}'), 4)).toBe(5);
    expect(manaValue(parseManaCost('{X}{X}{R}'), 3)).toBe(7);
  });

  it('takes the highest alternative for a hybrid symbol', () => {
    const firstSymbolOf = (text: string) => {
      const symbol = parseManaCost(text).symbols[0];
      if (!symbol) throw new Error(`"${text}" parsed to no symbols`);
      return symbol;
    };
    expect(symbolValue(firstSymbolOf('{2/W}'))).toBe(2);
    expect(symbolValue(firstSymbolOf('{W/U}'))).toBe(1);
  });
});

describe('costColours (CR 202.2)', () => {
  it('finds the colours a cost names', () => {
    expect(costColours(parseManaCost('{1}{W}{U}'))).toEqual(['W', 'U']);
  });

  it('counts both halves of a hybrid', () => {
    expect(costColours(parseManaCost('{W/U}'))).toEqual(['W', 'U']);
  });

  it('counts the colour of a phyrexian symbol', () => {
    expect(costColours(parseManaCost('{U/P}'))).toEqual(['U']);
  });

  it('reports no colours for generic or colourless costs', () => {
    expect(costColours(parseManaCost('{3}{C}'))).toEqual([]);
  });

  it('lists each colour once', () => {
    expect(costColours(parseManaCost('{U}{U}{U}'))).toEqual(['U']);
  });
});

describe('cost adjustment (CR 601.2f)', () => {
  it('reduces only the generic part', () => {
    const reduced = reduceGeneric(parseManaCost('{3}{U}{U}'), 2);
    expect(reduced.generic).toBe(1);
    expect(reduced.symbols).toHaveLength(2);
  });

  it('never reduces below zero', () => {
    expect(reduceGeneric(parseManaCost('{1}{U}'), 5).generic).toBe(0);
  });

  it('leaves coloured symbols alone even when the reduction is huge', () => {
    expect(manaValue(reduceGeneric(parseManaCost('{9}{U}{U}'), 99))).toBe(2);
  });

  it('increases generic, as a tax does', () => {
    expect(increaseGeneric(parseManaCost('{U}'), 2).generic).toBe(2);
  });

  it('returns the same cost for a zero adjustment', () => {
    const cost = parseManaCost('{2}{U}');
    expect(reduceGeneric(cost, 0)).toBe(cost);
    expect(increaseGeneric(cost, 0)).toBe(cost);
  });

  it('rejects negative adjustments', () => {
    expect(() => reduceGeneric(parseManaCost('{2}'), -1)).toThrow(RangeError);
    expect(() => increaseGeneric(parseManaCost('{2}'), -1)).toThrow(RangeError);
  });
});
