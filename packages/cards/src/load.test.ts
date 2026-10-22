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

describe('trigger conditions', () => {
  const watcher = (when: unknown) =>
    loadCardScript({
      ...bolt,
      types: ['enchantment'],
      abilities: [
        {
          kind: 'triggered',
          id: 'watch',
          when,
          effects: [{ op: 'draw', player: 'you', count: 1 }],
        },
      ],
    }).abilities[0];

  it('converts a filter in a trigger condition as it would any other', () => {
    expect(
      watcher({
        kind: 'spellCast',
        caster: 'you',
        filter: { or: [{ type: 'instant' }, { type: 'sorcery' }] },
      }),
    ).toMatchObject({
      when: {
        kind: 'spellCast',
        filter: {
          kind: 'or',
          filters: [
            { kind: 'type', type: 'instant' },
            { kind: 'type', type: 'sorcery' },
          ],
        },
      },
    });
  });

  it('refuses a filter in a trigger condition that is not one', () => {
    expect(() => watcher({ kind: 'spellCast', caster: 'you', filter: {} })).toThrow(ScriptError);
  });

  it('takes an opponent’s step, and the beginning of combat', () => {
    expect(watcher({ kind: 'beginningOfUpkeep', whose: 'opponent' })).toMatchObject({
      when: { whose: 'opponent' },
    });
    expect(() => watcher({ kind: 'beginningOfCombat' })).toThrow(/whose/);
  });
});

describe('an ability used from the hand', () => {
  it('loads where it works from and its discard-self cost', () => {
    const definition = loadCardScript({
      ...bolt,
      abilities: [
        {
          kind: 'activated',
          id: 'cycling',
          from: 'hand',
          cost: { mana: '{2}', discardSelf: true },
          effects: [{ op: 'draw', player: 'you', count: 1 }],
        },
      ],
    });
    expect(definition.abilities[0]).toMatchObject({
      kind: 'activated',
      from: 'hand',
      cost: { discardSelf: true, mana: { generic: 2 } },
    });
  });
});

describe('a payment in a "may"', () => {
  const paying = (pay: unknown) =>
    loadCardScript({
      ...bolt,
      abilities: [
        {
          kind: 'spell',
          effects: [
            { op: 'may', player: 'you', pay, effects: [{ op: 'draw', player: 'you', count: 1 }] },
          ],
        },
      ],
    });

  it('loads its mana cost into the engine’s form', () => {
    const effect = (paying('{2}{R}').abilities[0] as { effects: readonly unknown[] }).effects[0];
    expect(effect).toMatchObject({ op: 'may', pay: { generic: 2, symbols: [{}] } });
  });

  it('refuses one that is not a mana cost', () => {
    expect(() => paying('{E}{E}')).toThrow(ScriptError);
    expect(() => paying(2)).toThrow(ScriptError);
  });
});

describe('the permanent that made a trigger trigger (`$that`)', () => {
  const triggered = (when: Record<string, unknown>) =>
    loadCardScript({
      ...bolt,
      abilities: [
        {
          kind: 'triggered',
          id: 'grow',
          when,
          effects: [{ op: 'addCounters', object: '$that', counter: '+1/+1', amount: 1 }],
        },
      ],
    });

  it('loads in a trigger on a permanent entering or dying', () => {
    expect(
      triggered({ kind: 'anotherEntersBattlefield', filter: { is: 'creature' } }).abilities[0],
    ).toMatchObject({ effects: [{ object: { kind: 'triggering' } }] });
  });

  it('is refused anywhere it would name nothing', () => {
    expect(() => triggered({ kind: 'lifeGained', player: 'you' })).toThrow(/\$that/);
    expect(() =>
      loadCardScript({
        ...bolt,
        abilities: [{ kind: 'spell', effects: [{ op: 'destroy', object: '$that' }] }],
      }),
    ).toThrow(/\$that/);
  });
});

describe('a look at the top of a library', () => {
  const looking = (look: Record<string, unknown>) =>
    loadCardScript({
      ...bolt,
      abilities: [
        { kind: 'spell', effects: [{ op: 'lookAtTop', player: 'you', count: 3, ...look }] },
      ],
    });

  it('loads a look, its filter in the short form every filter is written in', () => {
    const definition = looking({
      take: 1,
      upTo: true,
      filter: { type: 'creature' },
      to: { kind: 'hand' },
      rest: 'bottomRandom',
    });
    expect(definition.abilities[0]).toMatchObject({
      effects: [
        { op: 'lookAtTop', filter: { kind: 'type', type: 'creature' }, rest: 'bottomRandom' },
      ],
    });
  });

  it('refuses a rest it has no case for, a take with nowhere to go, and tapped in a hand', () => {
    expect(() => looking({ rest: 'sideways' })).toThrow(/rest/);
    expect(() => looking({ take: 1, rest: 'top' })).toThrow(/"to"/);
    expect(() => looking({ to: { kind: 'hand' }, rest: 'top' })).toThrow(/"to"/);
    expect(() => looking({ take: 1, to: { kind: 'exile' }, rest: 'top' })).toThrow(/to/);
    expect(() => looking({ take: 1, to: { kind: 'hand', tapped: true }, rest: 'top' })).toThrow(
      /tapped/,
    );
    expect(() => looking({ take: 1, upTo: 'yes', to: { kind: 'hand' }, rest: 'top' })).toThrow(
      /upTo/,
    );
  });

  it('checks a search’s destination as a look’s, and reads a supertype in its filter', () => {
    const searching = (fields: Record<string, unknown>) =>
      loadCardScript({
        ...bolt,
        abilities: [{ kind: 'spell', effects: [{ op: 'search', player: 'you', ...fields }] }],
      });
    expect(() => searching({ to: { kind: 'exile' } })).toThrow(/to/);
    expect(() => searching({ to: { kind: 'hand', tapped: true } })).toThrow(/tapped/);
    expect(
      searching({ count: 1, filter: { supertype: 'basic', type: 'land' }, to: { kind: 'hand' } })
        .abilities[0],
    ).toMatchObject({
      effects: [
        {
          op: 'search',
          filter: {
            kind: 'and',
            filters: [
              { kind: 'type', type: 'land' },
              { kind: 'supertype', supertype: 'basic' },
            ],
          },
        },
      ],
    });
  });

  it('loads a mana value as a quantity', () => {
    expect(
      loadCardScript({
        ...bolt,
        abilities: [
          {
            kind: 'spell',
            effects: [{ op: 'gainLife', player: 'you', amount: { manaValueOf: '~' } }],
          },
        ],
      }).abilities[0],
    ).toMatchObject({
      effects: [{ amount: { kind: 'manaValueOf', object: { kind: 'source' } } }],
    });
  });

  it('loads scry and surveil', () => {
    for (const op of ['scry', 'surveil']) {
      expect(() =>
        loadCardScript({
          ...bolt,
          abilities: [{ kind: 'spell', effects: [{ op, player: 'you', count: 2 }] }],
        }),
      ).not.toThrow();
    }
  });
});

describe('a cost reduction', () => {
  it('loads its quantity and condition, and a graveyard filter, into the engine’s forms', () => {
    const definition = loadCardScript({
      ...bolt,
      costReduction: {
        generic: { count: { type: 'creature', graveyard: 'you' } },
        if: { exists: { is: 'creature', controller: 'you' } },
      },
    });
    expect(definition.costReduction).toEqual({
      generic: {
        kind: 'count',
        of: {
          kind: 'and',
          filters: [
            { kind: 'type', type: 'creature' },
            { kind: 'inGraveyard', player: 'you' },
          ],
        },
      },
      if: {
        kind: 'exists',
        filter: {
          kind: 'and',
          filters: [{ kind: 'creature' }, { kind: 'controlledBy', player: 'you' }],
        },
      },
    });
  });
});

describe('an additional cost', () => {
  it('loads with its filter converted, and only the parts the script set', () => {
    const definition = loadCardScript({
      ...bolt,
      additionalCost: {
        sacrifice: { filter: { or: [{ type: 'artifact' }, 'creature'] }, count: 1 },
      },
    });
    expect(definition.additionalCost).toEqual({
      sacrifice: {
        filter: {
          kind: 'or',
          filters: [{ kind: 'type', type: 'artifact' }, { kind: 'creature' }],
        },
        count: 1,
      },
    });
  });

  it('refuses one that costs nothing', () => {
    expect(() => loadCardScript({ ...bolt, additionalCost: {} })).toThrow();
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

  /**
   * The engine decides whether a step trigger fires from `whose` — the controller's step,
   * the opponent's, or any — so a script that leaves `whose` out gets "your upkeep"
   * by accident and the type that says it is required never sees the object. An
   * auto-scripter meaning "each player's upkeep" would silently produce a trigger that
   * fires on one of them.
   */
  it('rejects a step trigger that does not say whose step it is', () => {
    expect(
      broken([
        {
          kind: 'triggered',
          id: 'upkeep',
          when: { kind: 'beginningOfUpkeep' },
          effects: [{ op: 'draw', player: 'you', count: 1 }],
        },
      ]),
    ).toThrow(/whose/);

    expect(
      broken([
        {
          kind: 'triggered',
          id: 'end',
          when: { kind: 'beginningOfEndStep', whose: 'either' },
          effects: [{ op: 'draw', player: 'you', count: 1 }],
        },
      ]),
    ).toThrow(/whose/);
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
