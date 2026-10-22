import { asOracleId, playerZone } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { parseManaCost } from '../mana/cost.js';
import { game } from '../testing/scenario.js';
import type { TriggerWhen } from '../triggers.js';
import type { CardDefinition } from './definition.js';
import { evaluateQuantity, resolveObjects } from './evaluate.js';
import type { Filter } from './vocabulary.js';

/**
 * Triggers on a permanent entering (CR 603.6a) or dying (CR 700.4, 603.10a) that say what
 * kind of permanent: "whenever a land you control enters" (Landfall), "whenever another
 * artifact you control enters", "whenever a creature you control dies". The noun is the
 * trigger's filter. Before it was kept, "another artifact you control enters" fired for
 * every permanent and "another creature you control dies" for a sacrificed land.
 */

let made = 0;
/** A 1/1 that gains its controller 1 life whenever its trigger fires. */
const watcher = (when: TriggerWhen): CardDefinition => {
  made += 1;
  return {
    oracleId: asOracleId(`ed-watcher-${made}`),
    name: `Watcher ${made}`,
    manaCost: parseManaCost(''),
    types: ['creature'],
    colours: [],
    power: 1,
    toughness: 1,
    abilities: [
      {
        kind: 'triggered',
        id: 'watch',
        when,
        effects: [{ op: 'gainLife', player: { kind: 'you' }, amount: 1 }],
      },
    ],
  };
};

const land: CardDefinition = {
  oracleId: asOracleId('ed-land'),
  name: 'Grey Land',
  manaCost: parseManaCost(''),
  types: ['land'],
  colours: [],
  abilities: [{ kind: 'mana', id: 'c', modes: [[{ type: 'C', amount: 1 }]] }],
};

const relic: CardDefinition = {
  oracleId: asOracleId('ed-relic'),
  name: 'Relic',
  manaCost: parseManaCost(''),
  types: ['artifact'],
  colours: [],
  abilities: [],
};

const bear: CardDefinition = {
  oracleId: asOracleId('ed-bear'),
  name: 'Bear',
  manaCost: parseManaCost(''),
  types: ['creature'],
  colours: [],
  power: 2,
  toughness: 2,
  abilities: [],
};

const yours = (filter: Filter): Filter => ({
  kind: 'and',
  filters: [filter, { kind: 'controlledBy', player: 'you' }],
});
const landYouControl = yours({ kind: 'type', type: 'land' });
const creatureYouControl = yours({ kind: 'creature' });

/** A with the watcher out and cards in hand to put onto the battlefield; B with the same. */
const table = (card: CardDefinition, active: 'A' | 'B' = 'A') =>
  game({ definitions: [card, land, relic, bear], seed: 'enters-dies', onPlay: active })
    .player('A')
    .battlefield(
      { name: 'watcher', definitionId: card.oracleId },
      { name: 'myLand', definitionId: land.oracleId },
      { name: 'myBear', definitionId: bear.oracleId },
    )
    .hand(
      { name: 'land', definitionId: land.oracleId },
      { name: 'relic', definitionId: relic.oracleId },
      { name: 'bear', definitionId: bear.oracleId },
    )
    .library(10)
    .player('B')
    .battlefield(
      { name: 'theirLand', definitionId: land.oracleId },
      { name: 'theirBear', definitionId: bear.oracleId },
    )
    .hand({ name: 'theirNewLand', definitionId: land.oracleId })
    .library(10)
    .player(active)
    .start()
    .to('precombatMain');

describe('Landfall: "whenever a land you control enters" (CR 603.6a)', () => {
  const landfall = watcher({ kind: 'entersBattlefield', filter: landYouControl });

  it('fires for a land of its controller’s entering', () => {
    expect(table(landfall).playLand('land').resolve().lifeOf('A')).toBe(21);
  });

  it('not for a creature or an artifact entering', () => {
    expect(table(landfall).cast('bear').resolve().lifeOf('A')).toBe(20);
    expect(table(landfall).cast('relic').resolve().lifeOf('A')).toBe(20);
  });

  it('not for the opponent’s land', () => {
    const scenario = table(landfall, 'B');
    expect(scenario.get().activePlayer).toBe('B');
    expect(scenario.playLand('theirNewLand').resolve().lifeOf('A')).toBe(20);
    expect(scenario.zoneOf('theirNewLand')).toBe('battlefield');
  });
});

describe('"you control" is the watcher’s controller, whichever player that is', () => {
  it('fires for the opponent’s land on the opponent’s watcher, and not for its own', () => {
    const landfall = watcher({ kind: 'entersBattlefield', filter: landYouControl });
    const scenario = game({ definitions: [landfall, land], seed: 'enters-dies', onPlay: 'B' })
      .player('A')
      .hand({ name: 'mine', definitionId: land.oracleId })
      .library(10)
      .player('B')
      .battlefield({ name: 'watcher', definitionId: landfall.oracleId })
      .hand({ name: 'theirs', definitionId: land.oracleId })
      .library(10)
      .start()
      .to('precombatMain');
    expect(scenario.playLand('theirs').resolve().lifeOf('B')).toBe(21);
  });
});

describe('"whenever a creature you control enters" sees the card itself enter', () => {
  it('fires for itself, as one of the creatures it names', () => {
    const card = watcher({ kind: 'entersBattlefield', filter: creatureYouControl });
    const scenario = game({ definitions: [card], seed: 'enters-dies' })
      .player('A')
      .hand({ name: 'watcher', definitionId: card.oracleId })
      .library(10)
      .player('B')
      .library(10)
      .player('A')
      .start()
      .to('precombatMain');
    expect(scenario.cast('watcher').resolve().lifeOf('A')).toBe(21);
  });

  it('while "another" does not', () => {
    const card = watcher({ kind: 'anotherEntersBattlefield', filter: creatureYouControl });
    const scenario = game({ definitions: [card], seed: 'enters-dies' })
      .player('A')
      .hand({ name: 'watcher', definitionId: card.oracleId })
      .library(10)
      .player('B')
      .library(10)
      .player('A')
      .start()
      .to('precombatMain');
    expect(scenario.cast('watcher').resolve().lifeOf('A')).toBe(20);
  });
});

describe('"whenever another artifact you control enters" keeps its noun', () => {
  const card = watcher({
    kind: 'anotherEntersBattlefield',
    filter: yours({ kind: 'type', type: 'artifact' }),
  });

  it('fires for an artifact, and not for a creature or a land', () => {
    expect(table(card).cast('relic').resolve().lifeOf('A')).toBe(21);
    expect(table(card).cast('bear').resolve().lifeOf('A')).toBe(20);
    expect(table(card).playLand('land').resolve().lifeOf('A')).toBe(20);
  });
});

describe('dying (CR 700.4), seen as the permanent last was (CR 603.10a)', () => {
  it('"another creature you control dies" fires for a creature, not for a land', () => {
    const card = watcher({ kind: 'anotherDies', filter: creatureYouControl });
    expect(table(card).kill('myBear').resolve().lifeOf('A')).toBe(21);
    expect(table(card).kill('myLand').resolve().lifeOf('A')).toBe(20);
    expect(table(card).kill('theirBear').resolve().lifeOf('A')).toBe(20);
  });

  it('"a creature you control dies" fires for the card itself dying too', () => {
    const card = watcher({ kind: 'dies', filter: creatureYouControl });
    expect(table(card).kill('watcher').resolve().lifeOf('A')).toBe(21);
    expect(table(card).kill('myBear').resolve().lifeOf('A')).toBe(21);
    expect(table(card).kill('myLand').resolve().lifeOf('A')).toBe(20);
  });

  it('"a creature an opponent controls dies" is relative to the card’s controller', () => {
    const card = watcher({
      kind: 'dies',
      filter: {
        kind: 'and',
        filters: [{ kind: 'creature' }, { kind: 'controlledBy', player: 'opponent' }],
      },
    });
    expect(table(card).kill('theirBear').resolve().lifeOf('A')).toBe(21);
    expect(table(card).kill('myBear').resolve().lifeOf('A')).toBe(20);
  });

  it('with no filter, any permanent: the old behaviour for a script that names none', () => {
    const card = watcher({ kind: 'anotherDies' });
    expect(table(card).kill('myLand').resolve().lifeOf('A')).toBe(21);
  });
});

describe('the permanent that made it trigger: `$that` ("it", "that creature")', () => {
  const counterOnIt = (when: TriggerWhen): CardDefinition => ({
    ...watcher(when),
    abilities: [
      {
        kind: 'triggered',
        id: 'watch',
        when,
        effects: [
          { op: 'addCounters', object: { kind: 'triggering' }, counter: '+1/+1', amount: 1 },
        ],
      },
    ],
  });

  it('is the creature that entered, not the card whose trigger it is', () => {
    const card = counterOnIt({ kind: 'anotherEntersBattlefield', filter: creatureYouControl });
    const scenario = table(card).cast('bear').resolve();
    expect(scenario.object('bear').counters['+1/+1']).toBe(1);
    expect(scenario.object('watcher').counters['+1/+1']).toBeUndefined();
  });

  it('is the creature that died, wherever it went (ADR 0020)', () => {
    const card: CardDefinition = {
      ...watcher({ kind: 'anotherDies', filter: creatureYouControl }),
      abilities: [
        {
          kind: 'triggered',
          id: 'watch',
          when: { kind: 'anotherDies', filter: creatureYouControl },
          effects: [{ op: 'bounce', object: { kind: 'triggering' } }],
        },
      ],
    };
    const scenario = table(card).kill('myBear').resolve();
    expect(scenario.zoneOf('myBear')).toBe(playerZone('A', 'hand'));
  });

  it('names nothing where no permanent made anything trigger', () => {
    const scenario = table(watcher({ kind: 'selfDies' }));
    const context = {
      source: scenario.ref('watcher'),
      controller: 'A' as const,
      targets: {},
      x: 0,
    };
    expect(resolveObjects(scenario.get(), context, { kind: 'triggering' })).toEqual([]);
    expect(
      resolveObjects(
        scenario.get(),
        { ...context, triggering: scenario.ref('myBear') },
        { kind: 'triggering' },
      ),
    ).toEqual([scenario.ref('myBear')]);
  });
});

describe('"equal to its toughness" of a creature that died: as it last was (CR 608.2h)', () => {
  const gainItsToughness = (when: TriggerWhen): CardDefinition => ({
    ...watcher(when),
    abilities: [
      {
        kind: 'triggered',
        id: 'watch',
        when,
        effects: [
          {
            op: 'gainLife',
            player: { kind: 'you' },
            amount: { kind: 'toughnessOf', object: { kind: 'triggering' } },
          },
        ],
      },
    ],
  });

  it('counts the counters it had on the battlefield, which the card in the graveyard has not', () => {
    const card = gainItsToughness({ kind: 'anotherDies', filter: creatureYouControl });
    const scenario = game({ definitions: [card, bear], seed: 'enters-dies' })
      .player('A')
      .battlefield(
        { name: 'watcher', definitionId: card.oracleId },
        // A 2/2 grown to 5/5 by counters, which it loses on leaving (CR 400.7).
        { name: 'grown', definitionId: bear.oracleId, counters: { '+1/+1': 3 } },
      )
      .library(10)
      .player('B')
      .library(10)
      .player('A')
      .start()
      .to('precombatMain');
    scenario.kill('grown').resolve();
    expect(scenario.object('grown').counters['+1/+1']).toBeUndefined();
    expect(scenario.lifeOf('A')).toBe(25);
  });

  it('reads one still on the battlefield as it is now, not as it was when it triggered', () => {
    const card = gainItsToughness({ kind: 'anotherEntersBattlefield', filter: creatureYouControl });
    const scenario = table(card).cast('bear').pass(2);
    // The trigger is on the stack; the Bear grows before it resolves.
    expect(scenario.get().zones.stack).toHaveLength(1);
    scenario
      .effect({
        source: scenario.ref('bear'),
        affects: { kind: 'object', object: scenario.ref('bear') },
        change: { kind: 'modifyPowerToughness', power: 3, toughness: 3 },
        duration: { kind: 'untilEndOfTurn' },
      })
      .resolve();
    expect(scenario.lifeOf('A')).toBe(25);
  });

  it('reads the card as it is when it is still on the battlefield', () => {
    const card = gainItsToughness({ kind: 'anotherEntersBattlefield', filter: creatureYouControl });
    expect(table(card).cast('bear').resolve().lifeOf('A')).toBe(22);
  });

  it('a mana value is the card’s printed cost, and a token’s is 0 (CR 202.3)', () => {
    const dear = {
      ...bear,
      oracleId: asOracleId('ed-dear-bear'),
      manaCost: parseManaCost('{3}{G}'),
    };
    const scenario = game({ definitions: [dear], seed: 'enters-dies' })
      .player('A')
      .battlefield(
        { name: 'dear', definitionId: dear.oracleId },
        { name: 'token', definitionId: dear.oracleId, token: true },
      )
      .player('B')
      .start();
    const context = { source: scenario.ref('dear'), controller: 'A' as const, targets: {}, x: 0 };
    const manaValueOf = (name: string) =>
      evaluateQuantity(scenario.get(), context, {
        kind: 'manaValueOf',
        object: { kind: 'object', object: scenario.ref(name) },
      });
    expect(manaValueOf('dear')).toBe(4);
    expect(manaValueOf('token')).toBe(0);
  });
});
