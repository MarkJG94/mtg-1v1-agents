import { describe, expect, it } from 'vitest';
import { parseTypeLine, sentencesOf } from './oracle-text.js';
import type { CardProjection } from './scryfall.js';
import { validateScript } from './validate.js';

/**
 * The validator (docs/03 "Validation").
 *
 * The cards are invented, and their "printed" side is a projection written here rather
 * than fetched: the point of every test is the *disagreement* between a script and a
 * card, which needs both halves under the test's control.
 */

const printed = (over: Partial<CardProjection> = {}): CardProjection => ({
  id: 'printing-1',
  oracleId: 'oracle-jolt',
  name: 'Jolt',
  manaCost: '{R}',
  manaValue: 1,
  colors: ['R'],
  colorIdentity: ['R'],
  typeLine: 'Instant',
  oracleText: 'Jolt deals 3 damage to any target.',
  power: null,
  toughness: null,
  loyalty: null,
  keywords: [],
  layout: 'normal',
  legalities: { modern: 'legal' },
  setCode: 'tst',
  rarity: 'common',
  reserved: false,
  digital: false,
  ...over,
});

const script = (over: Record<string, unknown> = {}) => ({
  oracleId: 'oracle-jolt',
  name: 'Jolt',
  manaCost: '{R}',
  types: ['instant'],
  colours: ['R'],
  abilities: [
    {
      kind: 'spell',
      covers: [0],
      targets: [{ id: 't', filter: 'any' }],
      effects: [{ op: 'damage', to: '$t', amount: 3 }],
    },
  ],
  ...over,
});

describe('reading a printed card', () => {
  it('splits a type line into supertypes, types and subtypes', () => {
    expect(parseTypeLine('Legendary Creature — Human Wizard')).toEqual({
      supertypes: ['legendary'],
      types: ['creature'],
      subtypes: ['human', 'wizard'],
      unknown: [],
    });
  });

  it('reports a type line word the engine has no type for', () => {
    expect(parseTypeLine('Kindred Enchantment — Elf').unknown).toEqual(['Kindred']);
  });

  it('drops reminder text and splits sentences the way abilities are written', () => {
    expect(
      sentencesOf(
        'Flying (This creature can only be blocked by fliers.)\nDraw a card. Then discard a card.',
      ),
    ).toEqual(['Flying', 'Draw a card.', 'Then discard a card.']);
  });
});

describe('validating a script against its card', () => {
  it('passes a script that agrees, claims every sentence and survives being played', () => {
    const result = validateScript(script(), printed());

    expect(result.reasons).toEqual([]);
    expect(result.status).toBe('supported');
    expect(result.definition?.name).toBe('Jolt');
  });

  it('refuses a script that makes the card cheaper than it is printed', () => {
    const result = validateScript(script({ manaCost: '{0}' }), printed());

    expect(result.status).toBe('unsupported');
    expect(result.reasons.map((reason) => reason.message).join()).toMatch(/mana cost/);
  });

  it('refuses a script that disagrees about power', () => {
    const bear = printed({
      name: 'Cub',
      oracleId: 'oracle-cub',
      manaCost: '{1}{G}',
      colors: ['G'],
      typeLine: 'Creature — Bear',
      oracleText: '',
      power: '2',
      toughness: '2',
    });
    const result = validateScript(
      {
        oracleId: 'oracle-cub',
        name: 'Cub',
        manaCost: '{1}{G}',
        types: ['creature'],
        subtypes: ['bear'],
        colours: ['G'],
        power: 3,
        toughness: 2,
      },
      bear,
    );

    expect(result.status).toBe('unsupported');
    expect(result.reasons.map((reason) => reason.message).join()).toMatch(
      /power 3 is printed as 2/,
    );
  });

  it('calls a script partial when a sentence is left unclaimed', () => {
    const result = validateScript(
      script(),
      printed({ oracleText: 'Jolt deals 3 damage to any target.\nDraw a card.' }),
    );

    expect(result.status).toBe('partial');
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]?.message).toMatch(/sentence 1 is not claimed/);
  });

  it('refuses a script where two abilities claim the same sentence', () => {
    const result = validateScript(
      script({
        abilities: [
          { kind: 'spell', covers: [0], effects: [{ op: 'draw', player: 'you', count: 1 }] },
          {
            kind: 'triggered',
            id: 'x',
            covers: [0],
            when: { kind: 'selfEntersBattlefield' },
            effects: [],
          },
        ],
      }),
      printed(),
    );

    expect(result.status).toBe('unsupported');
    expect(result.reasons.map((reason) => reason.message).join()).toMatch(/claimed by 2 abilities/);
  });

  it('refuses a script that does not load at all', () => {
    const result = validateScript(
      script({ abilities: [{ kind: 'spell', effects: [{ op: 'nope' }] }] }),
      printed(),
    );

    expect(result.status).toBe('unsupported');
    expect(result.reasons[0]?.check).toBe('schema');
  });

  it('carries the version, so a cached verdict can be re-earned later', () => {
    expect(validateScript(script(), printed()).validatorVersion).toBeGreaterThan(0);
  });
});

describe('the executability smoke test', () => {
  it('plays a creature and a land without the engine complaining', () => {
    const cub = validateScript(
      {
        oracleId: 'oracle-cub',
        name: 'Cub',
        manaCost: '{1}{G}',
        types: ['creature'],
        subtypes: ['bear'],
        colours: ['G'],
        power: 2,
        toughness: 2,
      },
      printed({
        oracleId: 'oracle-cub',
        name: 'Cub',
        manaCost: '{1}{G}',
        colors: ['G'],
        typeLine: 'Creature — Bear',
        oracleText: '',
        power: '2',
        toughness: '2',
      }),
    );

    expect(cub.status).toBe('supported');
  });

  /**
   * The board is built big enough that the card's own cost is never what stops it, which
   * is a fine rule until a card costs {1000000}. Gleemax does. Running the coverage report
   * over every card Scryfall has found the smoke test trying to build a million lands.
   */
  it('skips a card that costs more than a board can pay, rather than building it', () => {
    const started = Date.now();
    const verdict = validateScript(
      script({
        oracleId: 'oracle-silly',
        name: 'Silly',
        manaCost: '{1000000}',
        types: ['artifact'],
        colours: [],
        abilities: [],
      }),
      printed({
        oracleId: 'oracle-silly',
        name: 'Silly',
        manaCost: '{1000000}',
        colors: [],
        typeLine: 'Artifact',
        oracleText: '',
      }),
    );

    expect(Date.now() - started).toBeLessThan(5000);
    expect(verdict.skipped.join(' ')).toContain('more than a board this size can pay');
  });

  it('catches a card that breaks the game when it is played', () => {
    // A spell that counters itself is shaped correctly and agrees with the printed card.
    // It only falls over when it resolves, which is exactly the class of problem the
    // other three checks cannot see.
    const result = validateScript(
      script({
        abilities: [{ kind: 'spell', covers: [0], effects: [{ op: 'counter', object: '~' }] }],
      }),
      printed(),
    );

    expect(result.status).toBe('unsupported');
    expect(result.reasons.some((reason) => reason.check === 'executability')).toBe(true);
  });

  it('skips a scenario it cannot cast the card in rather than failing it', () => {
    const result = validateScript(
      script({
        abilities: [
          {
            kind: 'spell',
            covers: [0],
            targets: [{ id: 't', filter: 'creature' }],
            effects: [{ op: 'destroy', object: '$t' }],
          },
        ],
      }),
      printed({ oracleText: 'Destroy target creature.' }),
    );

    expect(result.status).toBe('supported');
    expect(result.skipped.join()).toMatch(/nothing legal to target/);
  });
});
