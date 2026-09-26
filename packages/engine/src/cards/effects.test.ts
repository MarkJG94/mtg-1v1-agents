import { asOracleId, playerZone } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { parseManaCost } from '../mana/cost.js';
import { game } from '../testing/scenario.js';
import type { CardDefinition } from './definition.js';

/**
 * The card pipeline end to end: a script's ops actually happening in a game (docs/03).
 *
 * The cards here are invented rather than real. The working agreement forbids a real card
 * name anywhere in the engine, and these exist to exercise one op each — a real card's
 * name would add nothing and would be a rule the engine is not allowed to know.
 */

const id = (slug: string) => asOracleId(`test-${slug}`);

const spark: CardDefinition = {
  oracleId: id('spark'),
  name: 'Spark',
  manaCost: parseManaCost('{R}'),
  types: ['instant'],
  colours: ['R'],
  abilities: [
    {
      kind: 'spell',
      targets: [{ id: 't', filter: { kind: 'any' } }],
      effects: [{ op: 'damage', to: { kind: 'chosen', id: 't' }, amount: 3 }],
    },
  ],
};

/** A dual land, so the payment solver has a mode to choose between. */
const grove: CardDefinition = {
  oracleId: id('grove'),
  name: 'Grove',
  manaCost: parseManaCost(''),
  types: ['land'],
  colours: [],
  abilities: [
    {
      kind: 'mana',
      id: 'tap-for-rg',
      modes: [[{ type: 'R', amount: 1 }], [{ type: 'G', amount: 1 }]],
    },
  ],
};

const bear: CardDefinition = {
  oracleId: id('bear'),
  name: 'Bear',
  manaCost: parseManaCost('{1}{G}'),
  types: ['creature'],
  subtypes: ['bear'],
  colours: ['G'],
  power: 2,
  toughness: 2,
  abilities: [],
};

const anthem: CardDefinition = {
  oracleId: id('anthem'),
  name: 'Anthem',
  manaCost: parseManaCost('{1}{W}'),
  types: ['enchantment'],
  colours: ['W'],
  abilities: [
    {
      kind: 'static',
      affects: { kind: 'creaturesControlledBy', player: 'sourceController' },
      change: { kind: 'modifyPowerToughness', power: 1, toughness: 1 },
    },
  ],
};

const welcomer: CardDefinition = {
  oracleId: id('welcomer'),
  name: 'Welcomer',
  manaCost: parseManaCost('{2}{G}'),
  types: ['creature'],
  colours: ['G'],
  power: 1,
  toughness: 3,
  abilities: [
    {
      kind: 'triggered',
      id: 'etb-draw',
      when: { kind: 'selfEntersBattlefield' },
      effects: [{ op: 'draw', player: { kind: 'you' }, count: 1 }],
    },
  ],
};

const pinger: CardDefinition = {
  oracleId: id('pinger'),
  name: 'Pinger',
  manaCost: parseManaCost('{2}{R}'),
  types: ['creature'],
  colours: ['R'],
  power: 1,
  toughness: 1,
  abilities: [
    {
      kind: 'activated',
      id: 'ping',
      cost: { tap: true },
      targets: [{ id: 't', filter: { kind: 'any' } }],
      effects: [{ op: 'damage', to: { kind: 'chosen', id: 't' }, amount: 1 }],
    },
  ],
};

/** A basic-like land that makes one colour only. */
const crag: CardDefinition = {
  oracleId: id('crag'),
  name: 'Crag',
  manaCost: parseManaCost(''),
  types: ['land'],
  colours: [],
  abilities: [{ kind: 'mana', id: 'tap-for-r', modes: [[{ type: 'R', amount: 1 }]] }],
};

/** Two colours to pay, so a dual land has to make the one the other land cannot. */
const hybrid: CardDefinition = {
  oracleId: id('hybrid'),
  name: 'Hybrid',
  manaCost: parseManaCost('{R}{G}'),
  types: ['creature'],
  colours: ['R', 'G'],
  power: 2,
  toughness: 2,
  abilities: [],
};

/** One land, two abilities that each tap it: it makes one mana, never two. */
const painland: CardDefinition = {
  oracleId: id('painland'),
  name: 'Painland',
  manaCost: parseManaCost(''),
  types: ['land'],
  colours: [],
  abilities: [
    { kind: 'mana', id: 'tap-for-c', modes: [[{ type: 'C', amount: 1 }]] },
    { kind: 'mana', id: 'tap-for-g', modes: [[{ type: 'G', amount: 1 }]] },
  ],
};

/** A phyrexian symbol and a generic one: green or 2 life, and one more of anything. */
const mutant: CardDefinition = {
  oracleId: id('mutant'),
  name: 'Mutant',
  manaCost: parseManaCost('{1}{G/P}'),
  types: ['creature'],
  colours: ['G'],
  power: 2,
  toughness: 2,
  abilities: [],
};

const definitions = [spark, grove, bear, anthem, welcomer, pinger, crag, hybrid, painland, mutant];

const table = (options: { readonly seed?: string } = {}) =>
  game({ definitions, ...(options.seed !== undefined ? { seed: options.seed } : {}) });

describe('casting a spell from a card script', () => {
  it('pays for it by tapping a land, then does what the card says', () => {
    const scenario = table()
      .player('A')
      .battlefield({ name: 'land', definitionId: grove.oracleId })
      .hand({ name: 'bolt', definitionId: spark.oracleId })
      .player('B')
      .life(20)
      .start()
      .to('precombatMain')
      .player('A')
      .cast('bolt', { targets: [{ kind: 'player', player: 'B' }] })
      .resolve();

    expect(scenario.lifeOf('B')).toBe(17);
    expect(scenario.object('land').tapped).toBe(true);
    expect(scenario.zoneOf('bolt')).toBe(playerZone('A', 'graveyard'));
  });

  it('taps a dual land for the colour the other lands cannot make, whatever order they are in', () => {
    // CR 601.2g–h: the player activates mana abilities and then pays. Tapping the dual
    // first for red — its first mode — would leave green unpaid; legality said the spell
    // could be paid, so the tapper must find the way it can (docs/09: an offered action is
    // never refused).
    const scenario = table()
      .player('A')
      .battlefield({ name: 'dual', definitionId: grove.oracleId })
      .battlefield({ name: 'mountain', definitionId: crag.oracleId })
      .hand({ name: 'hybrid', definitionId: hybrid.oracleId })
      .start()
      .to('precombatMain')
      .player('A')
      .cast('hybrid')
      .resolve();

    expect(scenario.zoneOf('hybrid')).toBe('battlefield');
    expect([scenario.object('dual').tapped, scenario.object('mountain').tapped]).toEqual([
      true,
      true,
    ]);
  });

  it('taps a land with two mana abilities once, and pays with the lands after it', () => {
    // CR 605.3a / 602.5a: an ability with {T} in its cost cannot be activated once the
    // permanent is tapped, whichever of its abilities tapped it.
    const scenario = table()
      .player('A')
      .battlefield({ name: 'painland', definitionId: painland.oracleId })
      .battlefield({ name: 'mountain', definitionId: crag.oracleId })
      .hand({ name: 'bear', definitionId: bear.oracleId })
      .start()
      .to('precombatMain')
      .player('A')
      .cast('bear')
      .resolve();

    expect(scenario.zoneOf('bear')).toBe('battlefield');
  });

  it('does not offer a two-mana spell to one land with two mana abilities', () => {
    const scenario = table()
      .player('A')
      .battlefield({ name: 'painland', definitionId: painland.oracleId })
      .hand({ name: 'bear', definitionId: bear.oracleId })
      .start()
      .to('precombatMain')
      .player('A');

    const decision = scenario.get().pendingDecision;
    expect(decision?.kind).toBe('priority');
    const options = decision?.kind === 'priority' ? decision.options : [];
    expect(options.some((action) => action.kind === 'cast')).toBe(false);
  });

  it('pays a phyrexian symbol with life when no land can make its colour', () => {
    // CR 107.4f: {G/P} is paid with {G} or 2 life; CR 119.4: paying life is losing it.
    const scenario = table()
      .player('A')
      .life(20)
      .battlefield({ name: 'mountain', definitionId: crag.oracleId })
      .hand({ name: 'mutant', definitionId: mutant.oracleId })
      .start()
      .to('precombatMain')
      .player('A')
      .cast('mutant')
      .resolve();

    expect(scenario.zoneOf('mutant')).toBe('battlefield');
    expect(scenario.object('mountain').tapped).toBe(true);
    expect(scenario.lifeOf('A')).toBe(18);
  });

  it('pays a phyrexian symbol with mana, not life, when the lands can make it', () => {
    const scenario = table()
      .player('A')
      .life(20)
      .battlefield({ name: 'dual', definitionId: grove.oracleId })
      .battlefield({ name: 'mountain', definitionId: crag.oracleId })
      .hand({ name: 'mutant', definitionId: mutant.oracleId })
      .start()
      .to('precombatMain')
      .player('A')
      .cast('mutant')
      .resolve();

    expect(scenario.zoneOf('mutant')).toBe('battlefield');
    expect(scenario.lifeOf('A')).toBe(20);
  });

  it('refuses a spell there is no mana for', () => {
    const scenario = table()
      .player('A')
      .hand({ name: 'bolt', definitionId: spark.oracleId })
      .start()
      .to('precombatMain');

    expect(() => scenario.cast('bolt', { targets: [{ kind: 'player', player: 'B' }] })).toThrow(
      /cannot pay/,
    );
  });

  it('refuses an illegal target as the spell is cast (CR 601.2c)', () => {
    const scenario = table()
      .player('A')
      .battlefield({ name: 'land', definitionId: grove.oracleId })
      .hand({ name: 'bolt', definitionId: spark.oracleId })
      .player('B')
      .battlefield({ name: 'safe', power: 2, toughness: 2, keywords: { hexproof: true } })
      .start()
      .to('precombatMain')
      .player('A');

    expect(() => scenario.cast('bolt', { targets: [scenario.target('safe')] })).toThrow(
      /illegal target/,
    );
  });

  it('puts a creature spell onto the battlefield with its printed characteristics', () => {
    const scenario = table()
      .player('A')
      .battlefield(
        { name: 'l1', definitionId: grove.oracleId },
        { name: 'l2', definitionId: grove.oracleId },
      )
      .hand({ name: 'cub', definitionId: bear.oracleId })
      .start()
      .to('precombatMain')
      .cast('cub')
      .resolve();

    expect(scenario.zoneOf('cub')).toBe('battlefield');
    expect(scenario.object('cub').power).toBe(2);
    expect(scenario.object('cub').name).toBe('Bear');
  });
});

describe('abilities from a card script', () => {
  it('runs an enters-the-battlefield trigger', () => {
    const scenario = table()
      .player('A')
      .battlefield({ name: 'walker', definitionId: welcomer.oracleId })
      .library(5)
      .start();
    const before = scenario.get().zones[playerZone('A', 'hand')].length;

    const after = table()
      .player('A')
      .battlefield(
        { name: 'l1', definitionId: grove.oracleId },
        { name: 'l2', definitionId: grove.oracleId },
        { name: 'l3', definitionId: grove.oracleId },
      )
      .hand({ name: 'guest', definitionId: welcomer.oracleId })
      .library(5)
      .start()
      .to('precombatMain')
      .cast('guest')
      .resolve();

    expect(after.zoneOf('guest')).toBe('battlefield');
    expect(after.get().zones[playerZone('A', 'hand')]).toHaveLength(before + 1);
  });

  it('activates an ability, paying the tap cost', () => {
    const scenario = table()
      .player('A')
      .battlefield({ name: 'ping', definitionId: pinger.oracleId })
      .player('B')
      .start()
      .to('precombatMain')
      .player('A')
      .activate('ping', 'ping', { targets: [{ kind: 'player', player: 'B' }] })
      .resolve();

    expect(scenario.object('ping').tapped).toBe(true);
    expect(scenario.lifeOf('B')).toBe(19);
  });

  it('makes a static ability apply while its source is out, and stop when it goes', () => {
    const scenario = table()
      .player('A')
      .battlefield(
        { name: 'cub', definitionId: bear.oracleId },
        { name: 'banner', definitionId: anthem.oracleId },
      )
      .start();

    expect(scenario.power('cub')).toBe(3);

    const gone = scenario.exile('banner');
    expect(gone.power('cub')).toBe(2);
  });
});
