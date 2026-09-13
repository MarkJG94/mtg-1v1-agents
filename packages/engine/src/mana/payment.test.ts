import { describe, expect, it } from 'vitest';
import { parseManaCost } from './cost.js';
import { canPayCost, genericDemand, payCost } from './payment.js';
import { addMana, emptyManaPool, type ManaPool, type ManaType, manaPoolCounts } from './pool.js';

/** Build a pool from a shorthand like 'WWU' or 'WUC'. */
const pool = (mana: string, options: { snow?: boolean } = {}): ManaPool => {
  let built = emptyManaPool;
  for (const symbol of mana) {
    built = addMana(built, symbol as ManaType, 1, options);
  }
  return built;
};

const pay = (mana: string, cost: string, options = {}) =>
  payCost(pool(mana), parseManaCost(cost), options);

const spentCounts = (mana: string, cost: string, options = {}) => {
  const payment = pay(mana, cost, options);
  expect(payment).not.toBeNull();
  return manaPoolCounts(payment?.spent ?? []);
};

describe('paying simple costs', () => {
  it('pays a coloured cost from matching mana', () => {
    expect(canPayCost(pool('U'), parseManaCost('{U}'))).toBe(true);
  });

  it('refuses a coloured cost from the wrong colour', () => {
    expect(canPayCost(pool('R'), parseManaCost('{U}'))).toBe(false);
  });

  it('pays generic with any mana', () => {
    expect(canPayCost(pool('RG'), parseManaCost('{2}'))).toBe(true);
  });

  it('refuses when there is simply not enough mana', () => {
    expect(canPayCost(pool('R'), parseManaCost('{2}'))).toBe(false);
  });

  it('pays a mixed cost', () => {
    expect(canPayCost(pool('UUR'), parseManaCost('{2}{U}'))).toBe(true);
  });

  it('pays a free cost from an empty pool', () => {
    expect(canPayCost(emptyManaPool, parseManaCost(''))).toBe(true);
  });

  it('leaves the unspent mana in the pool', () => {
    const payment = pay('UUR', '{U}');
    expect(payment?.spent).toHaveLength(1);
    expect(payment?.remaining).toHaveLength(2);
  });

  it('does not mutate the pool it was given', () => {
    const before = pool('UUR');
    payCost(before, parseManaCost('{U}'));
    expect(before).toHaveLength(3);
  });
});

describe('colourless {C} is not the same as generic', () => {
  it('pays {C} from colourless mana', () => {
    expect(canPayCost(pool('C'), parseManaCost('{C}'))).toBe(true);
  });

  it('refuses to pay {C} with coloured mana', () => {
    expect(canPayCost(pool('RG'), parseManaCost('{C}'))).toBe(false);
  });

  it('happily pays generic with colourless mana', () => {
    expect(canPayCost(pool('CC'), parseManaCost('{2}'))).toBe(true);
  });
});

describe('hybrid symbols', () => {
  it('pays a hybrid from either half', () => {
    expect(canPayCost(pool('W'), parseManaCost('{W/U}'))).toBe(true);
    expect(canPayCost(pool('U'), parseManaCost('{W/U}'))).toBe(true);
  });

  it('pays two hybrids from two of the same colour', () => {
    expect(canPayCost(pool('WW'), parseManaCost('{W/U}{W/U}'))).toBe(true);
  });

  it('refuses a hybrid from an unrelated colour', () => {
    expect(canPayCost(pool('R'), parseManaCost('{W/U}'))).toBe(false);
  });

  it('pays a monocolour hybrid with its colour when that is all there is', () => {
    expect(canPayCost(pool('W'), parseManaCost('{2/W}'))).toBe(true);
  });

  it('pays a monocolour hybrid with two generic when the colour is missing', () => {
    expect(canPayCost(pool('RG'), parseManaCost('{2/W}'))).toBe(true);
  });

  it('refuses a monocolour hybrid with only one off-colour mana', () => {
    expect(canPayCost(pool('R'), parseManaCost('{2/W}'))).toBe(false);
  });
});

describe('the solver is exact, not greedy', () => {
  it('does not waste the only mana that can pay a strict symbol', () => {
    // A left-to-right pass spends U on {U/R}, then has only R for {U} and fails.
    expect(canPayCost(pool('UR'), parseManaCost('{U/R}{U}'))).toBe(true);
  });

  it('handles the same trap with the symbols the other way round', () => {
    expect(canPayCost(pool('UR'), parseManaCost('{U}{U/R}'))).toBe(true);
  });

  it('backtracks out of a wrong first choice on a monocolour hybrid', () => {
    // Paying {2/W} as two generic leaves only one W for two {W}; it must take the W.
    expect(canPayCost(pool('WWW'), parseManaCost('{2/W}{W}{W}'))).toBe(true);
  });

  it('still refuses when no assignment works', () => {
    expect(canPayCost(pool('UR'), parseManaCost('{U}{U}'))).toBe(false);
    expect(canPayCost(pool('WWU'), parseManaCost('{W}{W}{W}'))).toBe(false);
  });

  it('does not double-spend one unit on two symbols', () => {
    expect(canPayCost(pool('U'), parseManaCost('{U}{U}'))).toBe(false);
    expect(canPayCost(pool('W'), parseManaCost('{W/U}{W/U}'))).toBe(false);
  });

  it('counts generic against the mana left after the coloured symbols', () => {
    expect(canPayCost(pool('UU'), parseManaCost('{1}{U}'))).toBe(true);
    expect(canPayCost(pool('UU'), parseManaCost('{2}{U}'))).toBe(false);
  });
});

describe('phyrexian mana (CR 107.4f)', () => {
  it('pays with the colour when it is available', () => {
    const payment = pay('W', '{W/P}', { life: 20 });
    expect(payment?.life).toBe(0);
    expect(payment?.spent).toHaveLength(1);
  });

  it('pays 2 life when the colour is not available', () => {
    const payment = pay('R', '{W/P}', { life: 20 });
    expect(payment?.life).toBe(2);
    expect(payment?.spent).toHaveLength(0);
  });

  it('refuses when there is neither the colour nor the life', () => {
    expect(canPayCost(pool('R'), parseManaCost('{W/P}'), { life: 1 })).toBe(false);
  });

  it('defaults to no life available, so it will not pay life unasked', () => {
    expect(canPayCost(pool('R'), parseManaCost('{W/P}'))).toBe(false);
  });

  it('pays several phyrexian symbols with life', () => {
    const payment = pay('', '{W/P}{W/P}', { life: 20 });
    expect(payment?.life).toBe(4);
  });

  it('stops when the life runs out', () => {
    expect(canPayCost(emptyManaPool, parseManaCost('{W/P}{W/P}'), { life: 3 })).toBe(false);
  });

  it('mixes mana and life across symbols', () => {
    const payment = pay('W', '{W/P}{W/P}', { life: 20 });
    expect(payment?.life).toBe(2);
    expect(payment?.spent).toHaveLength(1);
  });
});

describe('snow mana', () => {
  it('pays {S} from a snow source', () => {
    expect(canPayCost(pool('R', { snow: true }), parseManaCost('{S}'))).toBe(true);
  });

  it('refuses {S} from ordinary mana', () => {
    expect(canPayCost(pool('R'), parseManaCost('{S}'))).toBe(false);
  });

  it('accepts snow mana of any type', () => {
    for (const type of ['W', 'U', 'B', 'R', 'G', 'C']) {
      expect(canPayCost(pool(type, { snow: true }), parseManaCost('{S}'))).toBe(true);
    }
  });

  it('lets snow mana pay ordinary costs too', () => {
    expect(canPayCost(pool('U', { snow: true }), parseManaCost('{U}'))).toBe(true);
  });

  it('keeps the snow mana for {S} when it is the only snow source', () => {
    // {U} must take the non-snow blue so the snow blue is left for {S}.
    let mixed = addMana(emptyManaPool, 'U', 1, { snow: true });
    mixed = addMana(mixed, 'U', 1);
    expect(canPayCost(mixed, parseManaCost('{S}{U}'))).toBe(true);
  });
});

describe('X costs', () => {
  it('adds X to the generic demand', () => {
    expect(genericDemand(parseManaCost('{X}{R}'), 3)).toBe(3);
    expect(genericDemand(parseManaCost('{X}{X}{R}'), 3)).toBe(6);
    expect(genericDemand(parseManaCost('{2}{X}'), 1)).toBe(3);
  });

  it('pays an X spell for the chosen value', () => {
    expect(canPayCost(pool('RRRR'), parseManaCost('{X}{R}'), { xValue: 3 })).toBe(true);
  });

  it('refuses when X is larger than the mana available', () => {
    expect(canPayCost(pool('RRRR'), parseManaCost('{X}{R}'), { xValue: 4 })).toBe(false);
  });

  it('treats X as zero by default', () => {
    expect(canPayCost(pool('R'), parseManaCost('{X}{R}'))).toBe(true);
  });

  it('rejects a negative X', () => {
    expect(() => payCost(pool('R'), parseManaCost('{X}{R}'), { xValue: -1 })).toThrow(RangeError);
  });
});

describe('spend restrictions (CR 106.6)', () => {
  const restricted = addMana(emptyManaPool, 'R', 2, { restriction: 'creature-spells-only' });

  it('allows restricted mana by default, since the spell is not known yet', () => {
    expect(canPayCost(restricted, parseManaCost('{2}'))).toBe(true);
  });

  it('honours a caller-supplied predicate', () => {
    const canSpend = (unit: { restriction?: string }) => unit.restriction === undefined;
    expect(canPayCost(restricted, parseManaCost('{2}'), { canSpend })).toBe(false);
  });

  it('lets unrestricted mana in the same pool still pay', () => {
    const mixed = addMana(restricted, 'G', 2);
    const canSpend = (unit: { restriction?: string }) => unit.restriction === undefined;
    expect(canPayCost(mixed, parseManaCost('{2}'), { canSpend })).toBe(true);
  });
});

describe('which mana it chooses to spend', () => {
  it('prefers colourless mana for generic, keeping colours for coloured symbols', () => {
    expect(spentCounts('CUU', '{1}{U}')).toMatchObject({ C: 1, U: 1 });
  });

  it('spends restricted mana before unrestricted when both would do', () => {
    let mixed = addMana(emptyManaPool, 'G', 1, { restriction: 'creature-spells-only' });
    mixed = addMana(mixed, 'G', 1);
    const payment = payCost(mixed, parseManaCost('{1}'));
    expect(payment?.spent[0]?.restriction).toBe('creature-spells-only');
  });
});

describe('payCost bookkeeping', () => {
  it('returns a remaining pool that is the original minus what was spent', () => {
    const payment = pay('UUCC', '{1}{U}');
    expect(payment?.spent).toHaveLength(2);
    expect(payment?.remaining).toHaveLength(2);
    expect(manaPoolCounts(payment?.remaining ?? [])).toMatchObject({ U: 1, C: 1 });
  });

  it('returns null rather than a partial payment', () => {
    expect(payCost(pool('U'), parseManaCost('{U}{U}'))).toBeNull();
  });
});
