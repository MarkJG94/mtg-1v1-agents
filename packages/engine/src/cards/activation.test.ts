import { asOracleId, playerZone } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { createEventEmitter } from '../events/emitter.js';
import { noKeywords } from '../keywords.js';
import type { LegalAction } from '../legal-actions.js';
import { canActivateManaAbility } from '../mana/ability.js';
import { parseManaCost } from '../mana/cost.js';
import { potentialManaFor } from '../mana/potential.js';
import { objectsIn } from '../state/update.js';
import { game, type Scenario } from '../testing/scenario.js';
import { activateAbility, IllegalCastError } from './cast.js';
import type { CardDefinition } from './definition.js';
import { manaAbilitiesOf } from './registry.js';

/**
 * Activated abilities reach the agents (CR 602): `legalActions` offers each one a player
 * could activate now, and nothing it could not — the timing, {T} only from a permanent
 * that can pay it (CR 302.6), mana the player could make, and legal targets. Cycling is
 * one too, from the hand (CR 702.29a).
 */

const you = { kind: 'you' } as const;

const grey: CardDefinition = {
  oracleId: asOracleId('act-land'),
  name: 'Grey Land',
  manaCost: parseManaCost(''),
  types: ['land'],
  colours: [],
  abilities: [{ kind: 'mana', id: 'c', modes: [[{ type: 'C', amount: 1 }]] }],
};

/** "{1}: ~ gets +1/+1 until end of turn." and "{T}: You gain 1 life." */
const bear: CardDefinition = {
  oracleId: asOracleId('act-bear'),
  name: 'Bear',
  manaCost: parseManaCost('{1}'),
  types: ['creature'],
  colours: [],
  power: 2,
  toughness: 2,
  abilities: [
    {
      kind: 'activated',
      id: 'pump',
      cost: { mana: parseManaCost('{1}') },
      effects: [
        {
          op: 'pump',
          object: { kind: 'source' },
          power: 1,
          toughness: 1,
          duration: 'untilEndOfTurn',
        },
      ],
    },
    {
      kind: 'activated',
      id: 'tap',
      cost: { tap: true },
      effects: [{ op: 'gainLife', player: you, amount: 1 }],
    },
    {
      kind: 'activated',
      id: 'slow',
      cost: { mana: parseManaCost('{1}') },
      sorceryOnly: true,
      effects: [{ op: 'gainLife', player: you, amount: 1 }],
    },
  ],
};

const hastyBear: CardDefinition = {
  ...bear,
  oracleId: asOracleId('act-hasty-bear'),
  name: 'Hasty Bear',
  keywords: { ...noKeywords, haste: true },
};

/** "{T}: Add {G}." and "{1}, {T}: You gain 1 life." */
const elf: CardDefinition = {
  oracleId: asOracleId('act-elf'),
  name: 'Elf',
  manaCost: parseManaCost('{1}'),
  types: ['creature'],
  colours: ['G'],
  power: 1,
  toughness: 1,
  abilities: [
    { kind: 'mana', id: 'g', modes: [[{ type: 'G', amount: 1 }]] },
    {
      kind: 'activated',
      id: 'heal',
      cost: { mana: parseManaCost('{1}'), tap: true },
      effects: [{ op: 'gainLife', player: you, amount: 1 }],
    },
  ],
};

/** "Cycling {1}" */
const cycler: CardDefinition = {
  oracleId: asOracleId('act-cycler'),
  name: 'Cycler',
  manaCost: parseManaCost('{5}'),
  types: ['sorcery'],
  colours: [],
  abilities: [
    { kind: 'spell', effects: [{ op: 'gainLife', player: you, amount: 5 }] },
    {
      kind: 'activated',
      id: 'cycling',
      from: 'hand',
      cost: { mana: parseManaCost('{1}'), discardSelf: true },
      effects: [{ op: 'draw', player: you, count: 1 }],
    },
  ],
};

const table = (
  options: {
    lands?: number;
    sick?: boolean;
    haste?: boolean;
    elf?: boolean;
    tapped?: boolean;
  } = {},
) =>
  game({ definitions: [grey, bear, hastyBear, elf, cycler], seed: 'activation' })
    .player('A')
    .hand({ name: 'cycler', definitionId: cycler.oracleId })
    .battlefield(
      {
        name: 'bear',
        definitionId: bear.oracleId,
        summoningSick: options.sick === true,
        tapped: options.tapped === true,
        ...(options.haste === true ? { keywords: { haste: true } } : {}),
      },
      ...Array.from({ length: options.lands ?? 0 }, (_, i) => ({
        name: `land${i}`,
        definitionId: grey.oracleId,
      })),
      ...(options.elf === true
        ? [{ name: 'elf', definitionId: elf.oracleId, summoningSick: options.sick === true }]
        : []),
    )
    .library(10)
    .player('B')
    .library(10)
    .player('A')
    .start()
    .to('precombatMain');

const offered = (scenario: Scenario) => {
  const decision = scenario.get().pendingDecision;
  const options: readonly LegalAction[] = decision?.kind === 'priority' ? decision.options : [];
  return options.flatMap((action) => (action.kind === 'activate' ? [action] : []));
};
const abilities = (scenario: Scenario, name: string) =>
  offered(scenario)
    .filter((action) => action.object === scenario.ref(name))
    .map((action) => action.ability);

describe('activated abilities offered to the player (CR 602)', () => {
  it('offers what can be paid, and not what cannot', () => {
    expect(abilities(table({ lands: 1 }), 'bear')).toEqual(['pump', 'tap', 'slow']);
    expect(abilities(table({ lands: 0 }), 'bear')).toEqual(['tap']);
  });

  it('is taken at priority: the ability goes on the stack and resolves', () => {
    const scenario = table({ lands: 1 });
    const pump = offered(scenario).find((action) => action.ability === 'pump');
    scenario.decide({ kind: 'priority', action: pump as LegalAction }).resolve();
    expect(scenario.power('bear')).toBe(3);
    expect(scenario.object('land0').tapped).toBe(true);
  });

  it('keeps a sorcery-speed ability to the player’s own main phase with an empty stack', () => {
    const scenario = table({ lands: 1 });
    scenario.to('beginCombat');
    expect(abilities(scenario, 'bear')).not.toContain('slow');
  });

  it('does not offer {T} from a tapped permanent', () => {
    const scenario = table();
    const tap = offered(scenario).find((action) => action.ability === 'tap');
    scenario.decide({ kind: 'priority', action: tap as LegalAction }).resolve();
    expect(scenario.object('bear').tapped).toBe(true);
    expect(abilities(scenario, 'bear')).not.toContain('tap');
  });
});

/** A creature cast this turn, which is the only way one is summoning sick in its own turn. */
const castThisTurn = (card: CardDefinition, lands: number) => {
  const scenario = game({ definitions: [grey, card], seed: 'activation' })
    .player('A')
    .hand({ name: 'new', definitionId: card.oracleId })
    .battlefield(
      ...Array.from({ length: lands }, (_, i) => ({
        name: `land${i}`,
        definitionId: grey.oracleId,
      })),
    )
    .library(10)
    .player('B')
    .library(10)
    .player('A')
    .start()
    .to('precombatMain');
  return scenario.cast('new').resolve();
};

describe('{T} and summoning sickness (CR 302.6)', () => {
  it('a creature that came under its controller’s control this turn cannot pay {T}', () => {
    const scenario = castThisTurn(bear, 1);
    expect(scenario.object('new').summoningSick).toBe(true);
    expect(abilities(scenario, 'new')).not.toContain('tap');
    expect(() =>
      activateAbility(scenario.get(), createEventEmitter(), 'A', scenario.ref('new'), 'tap'),
    ).toThrow(IllegalCastError);
  });

  it('unless it has haste (CR 702.10)', () => {
    expect(abilities(castThisTurn(hastyBear, 1), 'new')).toContain('tap');
  });

  it('nor tap for mana the turn it arrives', () => {
    const scenario = castThisTurn(elf, 1);
    const [mana] = manaAbilitiesOf(scenario.get(), 'A').filter(
      (each) => each.source === scenario.ref('new'),
    );
    expect(mana).toBeDefined();
    expect(canActivateManaAbility(scenario.get(), 'A', mana as never)).toBe(false);
    expect(
      potentialManaFor(scenario.get(), 'A', manaAbilitiesOf(scenario.get(), 'A')),
    ).toHaveLength(0);
  });
});

describe('an ability that taps its own source (CR 602.5a)', () => {
  it('cannot pay its mana by tapping that same source', () => {
    // The elf is the only mana there is, and "{1}, {T}" would need it twice.
    expect(abilities(table({ elf: true }), 'elf')).toEqual([]);
    expect(abilities(table({ elf: true, lands: 1 }), 'elf')).toEqual(['heal']);
  });

  it('pays with another source when there is one', () => {
    const scenario = table({ elf: true, lands: 1 });
    const heal = offered(scenario).find((action) => action.ability === 'heal');
    scenario.decide({ kind: 'priority', action: heal as LegalAction }).resolve();
    expect(scenario.object('land0').tapped).toBe(true);
    expect(scenario.lifeOf('A')).toBe(21);
  });
});

describe('what is never offered', () => {
  /** "~ gets +1/+0" with no cost at all, and "Cycling {1}" on a permanent card. */
  const odd: CardDefinition = {
    oracleId: asOracleId('act-odd'),
    name: 'Odd',
    manaCost: parseManaCost('{1}'),
    types: ['creature'],
    colours: [],
    power: 1,
    toughness: 1,
    abilities: [
      {
        kind: 'activated',
        id: 'free',
        cost: {},
        effects: [
          {
            op: 'pump',
            object: { kind: 'source' },
            power: 1,
            toughness: 0,
            duration: 'untilEndOfTurn',
          },
        ],
      },
      {
        kind: 'activated',
        id: 'pump',
        cost: { mana: parseManaCost('{1}') },
        effects: [
          {
            op: 'pump',
            object: { kind: 'source' },
            power: 1,
            toughness: 1,
            duration: 'untilEndOfTurn',
          },
        ],
      },
      {
        kind: 'activated',
        id: 'cycling',
        from: 'hand',
        cost: { mana: parseManaCost('{1}'), discardSelf: true },
        effects: [{ op: 'draw', player: you, count: 1 }],
      },
    ],
  };
  const board = () =>
    game({ definitions: [grey, odd], seed: 'activation' })
      .player('A')
      .hand({ name: 'held', definitionId: odd.oracleId })
      .battlefield(
        { name: 'out', definitionId: odd.oracleId },
        { name: 'land0', definitionId: grey.oracleId },
      )
      .library(10)
      .player('B')
      .battlefield({ name: 'theirs', definitionId: odd.oracleId })
      .library(10)
      .player('A')
      .start()
      .to('precombatMain');

  it('an ability that costs nothing, which could be taken without end', () => {
    expect(abilities(board(), 'out')).not.toContain('free');
  });

  it('an ability anywhere but where it works: cycling on the battlefield, a pump in hand', () => {
    const scenario = board();
    expect(abilities(scenario, 'out')).toEqual(['pump']);
    expect(abilities(scenario, 'held')).toEqual(['cycling']);
  });

  it('an ability of a permanent the player does not control', () => {
    expect(abilities(board(), 'theirs')).toEqual([]);
  });
});

describe('paying an ability that taps its own mana source', () => {
  it('taps another source for the mana, even when the source comes first', () => {
    // The elf is created before the land, so tapping in object order would reach it first.
    const scenario = game({ definitions: [grey, elf], seed: 'activation' })
      .player('A')
      .battlefield(
        { name: 'elf', definitionId: elf.oracleId },
        { name: 'land0', definitionId: grey.oracleId },
      )
      .library(10)
      .player('B')
      .library(10)
      .player('A')
      .start()
      .to('precombatMain');
    const after = activateAbility(
      scenario.get(),
      createEventEmitter(),
      'A',
      scenario.ref('elf'),
      'heal',
    );
    expect(after.objects.get(scenario.ref('land0'))?.tapped).toBe(true);
    expect(after.objects.get(scenario.ref('elf'))?.tapped).toBe(true);
  });
});

describe('cycling (CR 702.29a)', () => {
  it('is offered from the hand, and discards the card to draw one', () => {
    const scenario = table({ lands: 1 });
    expect(abilities(scenario, 'cycler')).toEqual(['cycling']);
    const before = objectsIn(scenario.get(), playerZone('A', 'hand')).length;
    const cycle = offered(scenario).find((action) => action.ability === 'cycling');
    expect(cycle?.discardSelf).toBe(true);
    scenario.decide({ kind: 'priority', action: cycle as LegalAction });
    expect(scenario.zoneOf('cycler')).toBe(playerZone('A', 'graveyard'));
    scenario.resolve();
    // One card out, one drawn.
    expect(objectsIn(scenario.get(), playerZone('A', 'hand'))).toHaveLength(before);
  });

  it('is not offered from anywhere but the hand, nor without its mana', () => {
    expect(abilities(table({ lands: 0 }), 'cycler')).toEqual([]);
  });
});
