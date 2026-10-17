import { asOracleId, type ObjectId, playerZone } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import type { DecisionResponse } from '../decision.js';
import { hashState } from '../loop.js';
import { parseManaCost } from '../mana/cost.js';
import { objectsIn } from '../state/update.js';
import { game, type Scenario } from '../testing/scenario.js';
import { viewFor } from '../view/project.js';
import type { CardDefinition } from './definition.js';
import type { EffectOp } from './ops.js';

/**
 * Looking at the top of a library (ADR 0021's program, stopping twice): scry
 * (CR 701.22a), surveil (CR 701.25a), and "look at the top N cards of your library" with
 * what is done with them — which to take, and the order the rest go back in (CR 401.4).
 */

const spell = (name: string, effects: readonly EffectOp[]): CardDefinition => ({
  oracleId: asOracleId(`look-${name}`),
  name,
  manaCost: parseManaCost(''),
  types: ['sorcery'],
  colours: [],
  abilities: [{ kind: 'spell', effects }],
});

const land: CardDefinition = {
  oracleId: asOracleId('look-land'),
  name: 'Grey Land',
  manaCost: parseManaCost(''),
  types: ['land'],
  colours: [],
  abilities: [{ kind: 'mana', id: 'c', modes: [[{ type: 'C', amount: 1 }]] }],
};

const you = { kind: 'you' } as const;

const scry = (count: number): EffectOp => ({ op: 'scry', player: you, count });
const surveil = (count: number): EffectOp => ({ op: 'surveil', player: you, count });

/**
 * A's library, top first: `top` names the cards ("l" a land, anything else a creature
 * card), then filler under them.
 */
const table = (card: CardDefinition, top: readonly string[] = ['c1', 'c2', 'c3', 'c4']) =>
  game({ definitions: [card, land], seed: 'looking', recordEvents: true })
    .player('A')
    .hand({ name: 'card', definitionId: card.oracleId })
    .library(
      0,
      ...top.map((name) =>
        name.startsWith('l')
          ? { name, definitionId: land.oracleId }
          : { name, power: 2, toughness: 2 },
      ),
      ...Array.from({ length: 4 }, (_, i) => ({ name: `under${i}`, power: 1, toughness: 1 })),
    )
    .player('B')
    .library(10)
    .player('A')
    .start()
    .to('precombatMain');

const castAndResolve = (scenario: Scenario) => scenario.cast('card').pass(2);

const libraryOf = (scenario: Scenario): readonly ObjectId[] =>
  objectsIn(scenario.get(), playerZone('A', 'library'));

const refs = (scenario: Scenario, ...names: string[]) => names.map((name) => scenario.ref(name));

const asked = (scenario: Scenario) => scenario.get().pendingDecision;

describe('scry (CR 701.22a)', () => {
  it('stops with the top cards, any number of which may go to the bottom', () => {
    const scenario = castAndResolve(table(spell('Scry', [scry(2)])));
    expect(asked(scenario)).toEqual({
      kind: 'chooseCardsFromLibrary',
      player: 'A',
      looking: refs(scenario, 'c1', 'c2'),
      from: refs(scenario, 'c1', 'c2'),
      min: 0,
      max: 2,
      to: 'libraryBottom',
      rest: 'top',
    });
    expect(scenario.zoneOf('card')).toBe('stack');
  });

  it('puts the chosen card on the bottom and leaves the other on top, with nothing to order', () => {
    const scenario = castAndResolve(table(spell('Scry', [scry(2)])));
    scenario.decide({ kind: 'chooseCardsFromLibrary', cards: refs(scenario, 'c1') });
    expect(libraryOf(scenario)[0]).toBe(scenario.ref('c2'));
    expect(libraryOf(scenario).at(-1)).toBe(scenario.ref('c1'));
    expect(scenario.zoneOf('card')).toBe(playerZone('A', 'graveyard'));
    expect(scenario.get().resolution).toBeNull();
  });

  it('asks the order of what stays on top, and puts them back in that order', () => {
    const scenario = castAndResolve(table(spell('Scry', [scry(3)])));
    scenario.decide({ kind: 'chooseCardsFromLibrary', cards: [] });
    expect(asked(scenario)).toEqual({
      kind: 'orderCards',
      player: 'A',
      cards: refs(scenario, 'c1', 'c2', 'c3'),
      to: 'libraryTop',
    });
    scenario.decide({ kind: 'orderCards', order: refs(scenario, 'c3', 'c1', 'c2') });
    expect(libraryOf(scenario).slice(0, 4)).toEqual(refs(scenario, 'c3', 'c1', 'c2', 'c4'));
    expect(scenario.zoneOf('card')).toBe(playerZone('A', 'graveyard'));
  });

  it('puts several on the bottom in the order given, the first nearest the top', () => {
    const scenario = castAndResolve(table(spell('Scry', [scry(2)])));
    scenario.decide({ kind: 'chooseCardsFromLibrary', cards: refs(scenario, 'c2', 'c1') });
    expect(libraryOf(scenario).slice(-2)).toEqual(refs(scenario, 'c2', 'c1'));
    expect(libraryOf(scenario)[0]).toBe(scenario.ref('c3'));
  });

  it('looks at only what there is, and asks nothing of an empty library', () => {
    const one = castAndResolve(table(spell('Scry', [scry(3)]), []));
    expect(asked(one)).toMatchObject({ kind: 'chooseCardsFromLibrary', max: 3 });

    const empty = game({ definitions: [spell('Scry', [scry(2)])], seed: 'looking' })
      .player('A')
      .hand({ name: 'card', definitionId: asOracleId('look-Scry') })
      .player('B')
      .library(10)
      .player('A')
      .start()
      .to('precombatMain');
    castAndResolve(empty);
    expect(asked(empty)?.kind).toBe('priority');
    expect(empty.zoneOf('card')).toBe(playerZone('A', 'graveyard'));
  });

  it('then the rest of the ability: "scry 1, then draw a card" draws what scry left on top', () => {
    const scenario = castAndResolve(
      table(spell('Peek', [scry(1), { op: 'draw', player: you, count: 1 }])),
    );
    scenario.decide({ kind: 'chooseCardsFromLibrary', cards: refs(scenario, 'c1') });
    expect(scenario.zoneOf('c2')).toBe(playerZone('A', 'hand'));
    expect(libraryOf(scenario).at(-1)).toBe(scenario.ref('c1'));
  });
});

describe('surveil (CR 701.25a)', () => {
  it('puts the chosen cards into the graveyard, a zone change the log records', () => {
    const scenario = castAndResolve(table(spell('Surveil', [surveil(2)])));
    expect(asked(scenario)).toMatchObject({ to: 'graveyard', rest: 'top', min: 0, max: 2 });
    scenario.decide({ kind: 'chooseCardsFromLibrary', cards: refs(scenario, 'c2') });
    expect(scenario.zoneOf('c2')).toBe(playerZone('A', 'graveyard'));
    expect(libraryOf(scenario)[0]).toBe(scenario.ref('c1'));
    expect(scenario.events()).toContain('moveZone');
  });
});

describe('looking at the top N cards', () => {
  /** "Look at the top three cards of your library. Put one of them into your hand and the rest into your graveyard." */
  const strategy = spell('Strategy', [
    {
      op: 'lookAtTop',
      player: you,
      count: 3,
      take: 1,
      to: { kind: 'hand' },
      rest: 'graveyard',
    },
  ]);

  it('takes exactly as many as it says, and the rest go where it says without asking', () => {
    const scenario = castAndResolve(table(strategy));
    expect(asked(scenario)).toMatchObject({ min: 1, max: 1, to: 'hand', rest: 'graveyard' });
    scenario.decide({ kind: 'chooseCardsFromLibrary', cards: refs(scenario, 'c2') });
    expect(scenario.zoneOf('c2')).toBe(playerZone('A', 'hand'));
    expect(scenario.zoneOf('c1')).toBe(playerZone('A', 'graveyard'));
    expect(scenario.zoneOf('c3')).toBe(playerZone('A', 'graveyard'));
    expect(scenario.zoneOf('c4')).toBe(playerZone('A', 'library'));
    expect(scenario.zoneOf('card')).toBe(playerZone('A', 'graveyard'));
  });

  it('"then put them back in any order" asks only the order', () => {
    const scenario = castAndResolve(
      table(spell('Back', [{ op: 'lookAtTop', player: you, count: 3, rest: 'top' }])),
    );
    expect(asked(scenario)).toMatchObject({ kind: 'orderCards', to: 'libraryTop' });
    scenario.decide({ kind: 'orderCards', order: refs(scenario, 'c2', 'c3', 'c1') });
    expect(libraryOf(scenario).slice(0, 3)).toEqual(refs(scenario, 'c2', 'c3', 'c1'));
  });

  /** "You may reveal a land card from among them and put it into your hand. Put the rest on the bottom in a random order." */
  const seek = spell('Seek', [
    {
      op: 'lookAtTop',
      player: you,
      count: 4,
      take: 1,
      upTo: true,
      filter: { kind: 'type', type: 'land' },
      to: { kind: 'hand' },
      rest: 'bottomRandom',
    },
  ]);

  it('offers only the cards the filter allows, and none is a legal answer', () => {
    const scenario = castAndResolve(table(seek, ['c1', 'l1', 'c2', 'l2']));
    expect(asked(scenario)).toMatchObject({
      looking: refs(scenario, 'c1', 'l1', 'c2', 'l2'),
      from: refs(scenario, 'l1', 'l2'),
      min: 0,
      max: 1,
    });
    scenario.decide({ kind: 'chooseCardsFromLibrary', cards: refs(scenario, 'l2') });
    expect(scenario.zoneOf('l2')).toBe(playerZone('A', 'hand'));
    // The rest at the bottom, under what was below them, in an order nobody chose.
    expect(new Set(libraryOf(scenario).slice(-3))).toEqual(
      new Set(refs(scenario, 'c1', 'l1', 'c2')),
    );
    expect(libraryOf(scenario)[0]).toBe(scenario.ref('under0'));
    expect(asked(scenario)?.kind).toBe('priority');
  });

  it('with nothing the filter allows, asks nothing and still puts the rest away', () => {
    const scenario = castAndResolve(table(seek, ['c1', 'c2', 'c3', 'c4']));
    expect(asked(scenario)?.kind).toBe('priority');
    expect(libraryOf(scenario)[0]).toBe(scenario.ref('under0'));
    expect(scenario.zoneOf('card')).toBe(playerZone('A', 'graveyard'));
  });

  it('puts the rest on the bottom in an order of the player’s choosing when it says any order', () => {
    const scenario = castAndResolve(
      table(spell('Under', [{ op: 'lookAtTop', player: you, count: 3, rest: 'bottom' }])),
    );
    expect(asked(scenario)).toMatchObject({ kind: 'orderCards', to: 'libraryBottom' });
    scenario.decide({ kind: 'orderCards', order: refs(scenario, 'c3', 'c1', 'c2') });
    expect(libraryOf(scenario).slice(-3)).toEqual(refs(scenario, 'c3', 'c1', 'c2'));
    expect(libraryOf(scenario)[0]).toBe(scenario.ref('c4'));
  });

  it('a random order is random: across seeds, not always the order they were in', () => {
    const orders = new Set<string>();
    for (const seed of ['1', '2', '3', '4', '5', '6']) {
      const scenario = game({ definitions: [seek, land], seed })
        .player('A')
        .hand({ name: 'card', definitionId: seek.oracleId })
        .library(0, ...['c1', 'c2', 'c3', 'c4'].map((name) => ({ name, power: 1, toughness: 1 })))
        .player('B')
        .library(10)
        .player('A')
        .start()
        .to('precombatMain');
      castAndResolve(scenario);
      orders.add(JSON.stringify(libraryOf(scenario)));
    }
    expect(orders.size).toBeGreaterThan(1);
  });

  it('a random order is drawn from the game’s generator: the same seed, the same order', () => {
    const run = () => {
      const scenario = castAndResolve(table(seek, ['c1', 'c2', 'c3', 'c4']));
      return libraryOf(scenario).slice(-4);
    };
    expect(run()).toEqual(run());
  });

  it('takes without asking when every card it could take must be taken', () => {
    const both = spell('Both', [
      { op: 'lookAtTop', player: you, count: 2, take: 2, to: { kind: 'hand' }, rest: 'bottom' },
    ]);
    const scenario = castAndResolve(table(both));
    expect(asked(scenario)?.kind).toBe('priority');
    expect(scenario.zoneOf('c1')).toBe(playerZone('A', 'hand'));
    expect(scenario.zoneOf('c2')).toBe(playerZone('A', 'hand'));
  });

  it('puts a land taken onto the battlefield, tapped when it says so', () => {
    const ramp = spell('Ramp', [
      {
        op: 'lookAtTop',
        player: you,
        count: 2,
        take: 1,
        upTo: true,
        filter: { kind: 'type', type: 'land' },
        to: { kind: 'battlefield', tapped: true },
        rest: 'bottomRandom',
      },
    ]);
    const scenario = castAndResolve(table(ramp, ['l1', 'c1']));
    scenario.decide({ kind: 'chooseCardsFromLibrary', cards: refs(scenario, 'l1') });
    expect(scenario.zoneOf('l1')).toBe('battlefield');
    expect(scenario.get().objects.get(scenario.ref('l1'))?.tapped).toBe(true);
  });
});

describe('what an answer may not be', () => {
  const tableAsked = () => castAndResolve(table(spell('Scry', [scry(2)])));
  const refuses = (response: (scenario: Scenario) => DecisionResponse) => {
    const scenario = tableAsked();
    expect(() => scenario.decide(response(scenario))).toThrow();
  };

  it('more cards than it may take, a card not offered, or one twice', () => {
    refuses((s) => ({ kind: 'chooseCardsFromLibrary', cards: refs(s, 'c1', 'c2', 'c3') }));
    refuses((s) => ({ kind: 'chooseCardsFromLibrary', cards: refs(s, 'c3') }));
    refuses((s) => ({ kind: 'chooseCardsFromLibrary', cards: refs(s, 'c1', 'c1') }));
  });

  it('fewer than it must take', () => {
    const scenario = castAndResolve(
      table(
        spell('One', [
          { op: 'lookAtTop', player: you, count: 3, take: 1, to: { kind: 'hand' }, rest: 'top' },
        ]),
      ),
    );
    expect(() => scenario.decide({ kind: 'chooseCardsFromLibrary', cards: [] })).toThrow();
  });

  it('an order that leaves a card out or names one that is not being put back', () => {
    const ordering = () => {
      const scenario = tableAsked();
      return scenario.decide({ kind: 'chooseCardsFromLibrary', cards: [] });
    };
    const first = ordering();
    expect(() => first.decide({ kind: 'orderCards', order: refs(first, 'c1') })).toThrow();
    const second = ordering();
    expect(() => second.decide({ kind: 'orderCards', order: refs(second, 'c1', 'c3') })).toThrow();
  });
});

describe('who sees the cards (CR 401.2)', () => {
  it('the player looking, while they are asked, and not the opponent', () => {
    const scenario = castAndResolve(table(spell('Scry', [scry(2)])));
    const [c1, c2, c3] = refs(scenario, 'c1', 'c2', 'c3');
    const mine = viewFor(scenario.get(), 'A');
    expect(mine.objects.has(c1 as ObjectId)).toBe(true);
    expect(mine.objects.has(c2 as ObjectId)).toBe(true);
    expect(mine.objects.has(c3 as ObjectId)).toBe(false);
    expect(viewFor(scenario.get(), 'B').objects.has(c1 as ObjectId)).toBe(false);
  });

  it('nobody, once they are back on the library', () => {
    const scenario = castAndResolve(table(spell('Scry', [scry(1)])));
    scenario.decide({ kind: 'chooseCardsFromLibrary', cards: [] });
    expect(viewFor(scenario.get(), 'A').objects.has(scenario.ref('c1'))).toBe(false);
  });
});

describe('a look part-way is a position of its own', () => {
  // The two questions are different decisions, which the hash already tells apart, and a
  // look in another frame is further through the program: the look needs no term of its own.
  it('choosing and ordering hash differently, though the board is the same', () => {
    const scenario = castAndResolve(table(spell('Scry', [scry(2)])));
    const choosing = hashState(scenario.get());
    scenario.decide({ kind: 'chooseCardsFromLibrary', cards: [] });
    expect(hashState(scenario.get())).not.toBe(choosing);
  });
});

describe('each player (CR 101.4)', () => {
  it('asks each in turn, the active player first', () => {
    const scenario = castAndResolve(
      table(spell('All', [{ op: 'scry', player: { kind: 'each' }, count: 1 }])),
    );
    expect(asked(scenario)).toMatchObject({ kind: 'chooseCardsFromLibrary', player: 'A' });
    scenario.decide({ kind: 'chooseCardsFromLibrary', cards: [] });
    expect(asked(scenario)).toMatchObject({ kind: 'chooseCardsFromLibrary', player: 'B' });
    scenario.decide({ kind: 'chooseCardsFromLibrary', cards: [] });
    expect(scenario.zoneOf('card')).toBe(playerZone('A', 'graveyard'));
  });
});
