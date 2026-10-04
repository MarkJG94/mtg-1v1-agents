import { asOracleId, playerZone } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { characteristicsOf } from '../characteristics.js';
import { createEventEmitter } from '../events/emitter.js';
import { parseManaCost } from '../mana/cost.js';
import { checkStateBasedActions } from '../sba.js';
import { getObject, moveObject } from '../state/update.js';
import { game } from '../testing/scenario.js';
import { IllegalCastError } from './cast.js';
import type { CardDefinition } from './definition.js';

/**
 * Auras and Equipment: what they may be attached to, how they come to be attached, and
 * what happens when that stops being true (CR 301.5, 303.4, 701.3, 702.5, 702.6, 704.5m-n).
 */

const holyStrength: CardDefinition = {
  oracleId: asOracleId('at-holy-strength'),
  name: 'Test Holy Strength',
  manaCost: parseManaCost(''),
  types: ['enchantment'],
  subtypes: ['aura'],
  colours: ['W'],
  enchant: { kind: 'creature' },
  abilities: [
    {
      kind: 'static',
      affects: { kind: 'attachedTo' },
      change: { kind: 'modifyPowerToughness', power: 1, toughness: 2 },
    },
  ],
};

/** "Enchant creature you control": "you" is the Aura's controller. */
const guardianship: CardDefinition = {
  oracleId: asOracleId('at-guardianship'),
  name: 'Test Guardianship',
  manaCost: parseManaCost(''),
  types: ['enchantment'],
  subtypes: ['aura'],
  colours: ['W'],
  enchant: {
    kind: 'and',
    filters: [{ kind: 'creature' }, { kind: 'controlledBy', player: 'you' }],
  },
  abilities: [],
};

const ownCreature = {
  kind: 'and' as const,
  filters: [
    { kind: 'creature' as const },
    { kind: 'controlledBy' as const, player: 'you' as const },
  ],
};

/** Equip {0}, as CR 702.6a spells it out; and one that tries to attach to anything at all. */
const splitter: CardDefinition = {
  oracleId: asOracleId('at-splitter'),
  name: 'Test Bonesplitter',
  manaCost: parseManaCost(''),
  types: ['artifact'],
  subtypes: ['equipment'],
  colours: [],
  abilities: [
    {
      kind: 'static',
      affects: { kind: 'attachedTo' },
      change: { kind: 'modifyPowerToughness', power: 2, toughness: 0 },
    },
    {
      kind: 'activated',
      id: 'equip',
      cost: {},
      sorceryOnly: true,
      targets: [{ id: 't', filter: ownCreature }],
      effects: [{ op: 'attach', attachment: { kind: 'source' }, to: { kind: 'target', id: 't' } }],
    },
    {
      kind: 'activated',
      id: 'anywhere',
      cost: {},
      targets: [{ id: 't', filter: { kind: 'permanent' } }],
      effects: [{ op: 'attach', attachment: { kind: 'source' }, to: { kind: 'target', id: 't' } }],
    },
  ],
};

const plains: CardDefinition = {
  oracleId: asOracleId('at-plains'),
  name: 'Test Plains',
  manaCost: parseManaCost(''),
  types: ['land'],
  colours: [],
  abilities: [],
};

const board = () =>
  game({
    definitions: [holyStrength, guardianship, splitter, plains],
    seed: 'attach',
    recordEvents: true,
  })
    .player('A')
    .hand(
      { name: 'strength', definitionId: holyStrength.oracleId },
      { name: 'guardianship', definitionId: guardianship.oracleId },
    )
    .battlefield(
      { name: 'bear', power: 2, toughness: 2 },
      { name: 'elk', power: 3, toughness: 3 },
      { name: 'splitter', definitionId: splitter.oracleId },
      { name: 'plains', definitionId: plains.oracleId },
    )
    .library(10)
    .player('B')
    .battlefield({ name: 'ogre', power: 3, toughness: 3 })
    .library(10)
    .player('A')
    .start()
    .to('precombatMain');

const sba = (state: Parameters<typeof checkStateBasedActions>[0]) =>
  checkStateBasedActions(state, createEventEmitter());

describe('an Aura spell targets what it will enchant (CR 303.4a)', () => {
  it('cannot be cast without a target', () => {
    expect(() => board().cast('strength')).toThrow(IllegalCastError);
  });

  it('cannot be cast at something its enchant ability does not allow', () => {
    const table = board();
    expect(() => table.cast('strength', { targets: [table.target('plains')] })).toThrow(
      IllegalCastError,
    );
  });

  it('reads "you" in its enchant ability as its own controller', () => {
    const table = board();
    expect(() => table.cast('guardianship', { targets: [table.target('ogre')] })).toThrow(
      IllegalCastError,
    );
    expect(() => table.cast('guardianship', { targets: [table.target('bear')] })).not.toThrow();
  });
});

describe('an Aura enters attached to its target (CR 303.4f)', () => {
  it('is attached on both sides, and what it gives applies to that creature', () => {
    const table = board();
    table.cast('strength', { targets: [table.target('bear')] }).resolve();
    expect(table.zoneOf('strength')).toBe('battlefield');
    expect(table.object('strength').attachedTo).toBe(table.ref('bear'));
    expect(table.object('bear').attachments).toEqual([table.ref('strength')]);
    expect([table.power('bear'), table.toughness('bear')]).toEqual([3, 4]);
    expect([table.power('elk'), table.toughness('elk')]).toEqual([3, 3]);
  });

  it('does not resolve at all when its target is gone (CR 608.2b)', () => {
    const table = board();
    table
      .cast('strength', { targets: [table.target('bear')] })
      .kill('bear')
      .resolve();
    expect(table.zoneOf('strength')).toBe(playerZone('A', 'graveyard'));
    expect(table.events().some((line) => line.includes('fizzle'))).toBe(true);
  });
});

describe('an Aura on something it may not enchant is put into the graveyard (CR 704.5m)', () => {
  it('when the creature it enchants dies', () => {
    const table = board();
    table
      .cast('strength', { targets: [table.target('bear')] })
      .resolve()
      .kill('bear');
    const after = sba(table.get());
    expect(getObject(after, table.ref('strength')).zone).toBe(playerZone('A', 'graveyard'));
  });

  it('when the creature leaves and comes back as a new object (CR 400.7)', () => {
    const table = board();
    table.cast('strength', { targets: [table.target('bear')] }).resolve();
    const bear = table.ref('bear');
    const back = moveObject(moveObject(table.get(), bear, 'exile'), bear, 'battlefield');
    expect(getObject(back, bear).attachments).toEqual([]);
    // Even before the state-based actions notice, the new creature has no bonus.
    expect(characteristicsOf(back, bear).power).toBe(2);
    const after = sba(back);
    expect(getObject(after, table.ref('strength')).zone).toBe(playerZone('A', 'graveyard'));
    expect(getObject(after, bear).zone).toBe('battlefield');
  });

  it('when what it is on is not what its enchant ability allows (CR 303.4d)', () => {
    const table = game({ definitions: [holyStrength, plains], seed: 'attach' })
      .player('A')
      .battlefield(
        { name: 'plains', definitionId: plains.oracleId },
        { name: 'strength', definitionId: holyStrength.oracleId, attachedTo: 'plains' },
      )
      .library(5)
      .player('B')
      .library(5);
    const after = sba(table.get());
    expect(getObject(after, table.ref('strength')).zone).toBe(playerZone('A', 'graveyard'));
  });

  it('when "a creature you control" passes to an opponent', () => {
    const table = game({ definitions: [guardianship], seed: 'attach' })
      .player('A')
      .battlefield(
        { name: 'bear', power: 2, toughness: 2 },
        { name: 'guardianship', definitionId: guardianship.oracleId, attachedTo: 'bear' },
      )
      .library(5)
      .player('B')
      .library(5);
    expect(getObject(sba(table.get()), table.ref('guardianship')).zone).toBe('battlefield');
    const stolen = table.effect({
      source: table.ref('bear'),
      affects: { kind: 'object', object: table.ref('bear') },
      change: { kind: 'changeControl', controller: 'B' },
      duration: { kind: 'permanent' },
    });
    const after = sba(stolen.get());
    expect(getObject(after, table.ref('guardianship')).zone).toBe(playerZone('A', 'graveyard'));
  });
});

describe('equip (CR 702.6a)', () => {
  it('attaches to a creature you control, and the bonus goes where the Equipment goes', () => {
    const table = board();
    table.activate('splitter', 'equip', { targets: [table.target('bear')] }).resolve();
    expect(table.object('splitter').attachedTo).toBe(table.ref('bear'));
    expect([table.power('bear'), table.power('elk')]).toEqual([4, 3]);

    table.activate('splitter', 'equip', { targets: [table.target('elk')] }).resolve();
    expect(table.object('splitter').attachedTo).toBe(table.ref('elk'));
    expect(table.object('bear').attachments).toEqual([]);
    expect(table.object('elk').attachments).toEqual([table.ref('splitter')]);
    expect([table.power('bear'), table.power('elk')]).toEqual([2, 5]);
  });

  it('cannot be aimed at an opponent’s creature', () => {
    const table = board();
    expect(() =>
      table.activate('splitter', 'equip', { targets: [table.target('ogre')] }),
    ).toThrow();
  });

  it('only as a sorcery', () => {
    const table = board();
    table.cast('strength', { targets: [table.target('bear')] });
    expect(() => table.activate('splitter', 'equip', { targets: [table.target('elk')] })).toThrow();
  });

  it('stays where it was when told to attach to something it cannot (CR 701.3b)', () => {
    const table = board();
    table.activate('splitter', 'equip', { targets: [table.target('bear')] }).resolve();
    table.activate('splitter', 'anywhere', { targets: [table.target('plains')] }).resolve();
    expect(table.object('splitter').attachedTo).toBe(table.ref('bear'));
    expect(table.object('plains').attachments).toEqual([]);
    expect(table.power('bear')).toBe(4);
  });
});

describe('an Equipment on something that is not a creature comes off (CR 301.5c, 704.5n)', () => {
  it('and stays on the battlefield', () => {
    const table = game({ definitions: [splitter, plains], seed: 'attach' })
      .player('A')
      .battlefield(
        { name: 'plains', definitionId: plains.oracleId },
        { name: 'splitter', definitionId: splitter.oracleId, attachedTo: 'plains' },
      )
      .library(5)
      .player('B')
      .library(5);
    const after = sba(table.get());
    expect(getObject(after, table.ref('splitter')).zone).toBe('battlefield');
    expect(getObject(after, table.ref('splitter')).attachedTo).toBeNull();
  });
});
