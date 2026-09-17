import { game } from '@mtg/engine/testing';
import { playerZone } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { loadCardScript, ScriptError } from './load.js';

/**
 * The loader, and the card pipeline end to end (docs/03).
 *
 * The scripts here are what a YAML file parses to, written in the friendly forms a person
 * would type. The cards are invented: a real card's name would tell us nothing extra and
 * the working agreement keeps them out of everything but the script files themselves.
 */

const bolt = {
  oracleId: 'test-bolt',
  name: 'Jolt',
  manaCost: '{R}',
  types: ['instant'],
  colours: ['R'],
  abilities: [
    {
      kind: 'spell',
      targets: [{ id: 't', filter: 'any' }],
      effects: [{ op: 'damage', to: '$t', amount: 3 }],
    },
  ],
};

const land = {
  oracleId: 'test-land',
  name: 'Ember Field',
  types: ['land'],
  abilities: [{ kind: 'mana', id: 'tap-for-r', modes: [[{ type: 'R' }]] }],
};

describe('loading a card script', () => {
  it('parses the mana cost, the types and the abilities', () => {
    const definition = loadCardScript(bolt);

    expect(definition.name).toBe('Jolt');
    expect(definition.types).toEqual(['instant']);
    expect(definition.manaCost.symbols).toHaveLength(1);
    expect(definition.abilities[0]).toMatchObject({
      kind: 'spell',
      targets: [{ id: 't', filter: { kind: 'any' } }],
      effects: [{ op: 'damage', to: { kind: 'chosen', id: 't' }, amount: 3 }],
    });
  });

  it('expands the keyword line into the engine keywords', () => {
    const definition = loadCardScript({
      oracleId: 'test-flier',
      name: 'Kite',
      manaCost: '{1}{W}',
      types: ['creature'],
      colours: ['W'],
      power: 2,
      toughness: 2,
      keywords: ['flying', 'vigilance'],
    });

    expect(definition.keywords?.flying).toBe(true);
    expect(definition.keywords?.vigilance).toBe(true);
    expect(definition.keywords?.trample).toBe(false);
  });

  it('turns the short filter forms into the engine vocabulary', () => {
    const definition = loadCardScript({
      oracleId: 'test-wrath',
      name: 'Sweep',
      manaCost: '{2}{W}{W}',
      types: ['sorcery'],
      colours: ['W'],
      abilities: [
        {
          kind: 'spell',
          effects: [
            {
              op: 'forEach',
              of: { type: 'creature', controller: 'opponent' },
              effects: [{ op: 'destroy', object: '$each' }],
            },
          ],
        },
      ],
    });

    expect(definition.abilities[0]).toMatchObject({
      effects: [
        {
          op: 'forEach',
          of: {
            kind: 'and',
            filters: [
              { kind: 'type', type: 'creature' },
              { kind: 'controlledBy', player: 'opponent' },
            ],
          },
        },
      ],
    });
  });

  it('keeps `then:` readable in the script and off the object the engine gets', () => {
    // An object with a `then` property is a thenable, so the engine's op calls it
    // `thenDo`. A script author still writes `then:`.
    const definition = loadCardScript({
      oracleId: 'test-gate',
      name: 'Toll',
      manaCost: '{B}',
      types: ['sorcery'],
      colours: ['B'],
      abilities: [
        {
          kind: 'spell',
          effects: [
            {
              op: 'if',
              condition: { atLeast: { amount: { lifeTotal: 'opponent' }, than: 10 } },
              // biome-ignore lint/suspicious/noThenProperty: the script spelling is the point
              then: [{ op: 'loseLife', player: 'opponent', amount: 2 }],
              otherwise: [{ op: 'gainLife', player: 'you', amount: 2 }],
            },
          ],
        },
      ],
    });

    const effect = definition.abilities[0];
    expect(effect).toMatchObject({
      effects: [{ op: 'if', thenDo: [{ op: 'loseLife' }], otherwise: [{ op: 'gainLife' }] }],
    });
    expect(Object.hasOwn(effect as object, 'then')).toBe(false);
  });
});

describe('what the loader refuses', () => {
  const broken = (abilities: unknown) => () => loadCardScript({ ...bolt, abilities });

  /**
   * A card has one spell ability however many sentences its text runs to (CR 112.3a), and
   * the engine resolves the first one it finds. Two of them means everything in the
   * second silently never happens — a card that does less than it says.
   */
  it('rejects a second spell ability, which would never resolve', () => {
    expect(
      broken([
        { kind: 'spell', effects: [{ op: 'draw', player: 'you', count: 1 }] },
        { kind: 'spell', effects: [{ op: 'draw', player: 'you', count: 1 }] },
      ]),
    ).toThrow(/spell abilities/);
  });

  /** A filter object with nothing in it used to mean "any permanent", quietly. */
  it('rejects a filter that says nothing', () => {
    expect(
      broken([
        {
          kind: 'spell',
          targets: [{ id: 't', filter: {} }],
          effects: [{ op: 'destroy', object: '$t' }],
        },
      ]),
    ).toThrow(ScriptError);
  });

  /**
   * `forEach` walks the battlefield. A filter about players matches nothing, so every
   * effect inside it does nothing — and the sentence that produced it still counts as
   * read, which makes the card supported and blank. The auto-scripter wrote one of these
   * for "deals 2 damage to each player" until the coverage report showed it.
   */
  it('rejects a forEach over players, whose effects could never happen', () => {
    expect(
      broken([
        {
          kind: 'spell',
          effects: [
            { op: 'forEach', of: 'player', effects: [{ op: 'damage', to: '$each', amount: 2 }] },
          ],
        },
      ]),
    ).toThrow(/about players/);
  });

  it('rejects an op the engine does not implement', () => {
    expect(broken([{ kind: 'spell', effects: [{ op: 'transmogrify', object: '~' }] }])).toThrow(
      ScriptError,
    );
  });

  it('rejects a target the ability never declared, which would silently do nothing', () => {
    expect(
      broken([
        {
          kind: 'spell',
          targets: [{ id: 't', filter: 'creature' }],
          effects: [{ op: 'damage', to: '$other', amount: 1 }],
        },
      ]),
    ).toThrow(/not a target this ability declares/);
  });

  it('rejects an op missing an argument it needs', () => {
    expect(broken([{ kind: 'spell', effects: [{ op: 'damage', amount: 3 }] }])).toThrow(
      /needs "to"/,
    );
  });

  it('rejects an argument the op does not take', () => {
    expect(
      broken([{ kind: 'spell', effects: [{ op: 'draw', player: 'you', count: 1, upTo: 2 }] }]),
    ).toThrow(/takes no argument "upTo"/);
  });

  it('rejects a trigger condition the engine has no rule for', () => {
    expect(
      broken([{ kind: 'triggered', id: 't', when: { kind: 'whenTheMoonIsFull' }, effects: [] }]),
    ).toThrow(/the engine has no "whenTheMoonIsFull"/);
  });

  it('names the card and the path, because a person reads these', () => {
    try {
      broken([{ kind: 'spell', effects: [{ op: 'damage', amount: 3 }] }])();
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ScriptError).message).toContain('Jolt');
      expect((error as ScriptError).message).toContain('abilities[0].effects[0]');
    }
  });
});

describe('a loaded script in a real game', () => {
  it('is cast, paid for and resolved, and does what the script says', () => {
    const jolt = loadCardScript(bolt);
    const field = loadCardScript(land);
    const definitions = [jolt, field];

    const scenario = game({ definitions })
      .player('A')
      .battlefield({ name: 'field', definitionId: field.oracleId })
      .hand({ name: 'jolt', definitionId: jolt.oracleId })
      .player('B')
      .start()
      .to('precombatMain')
      .player('A')
      .cast('jolt', { targets: [{ kind: 'player', player: 'B' }] })
      .resolve();

    expect(scenario.lifeOf('B')).toBe(17);
    expect(scenario.object('field').tapped).toBe(true);
    expect(scenario.zoneOf('jolt')).toBe(playerZone('A', 'graveyard'));
  });
});
