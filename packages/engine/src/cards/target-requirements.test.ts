import { asOracleId } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { parseManaCost } from '../mana/cost.js';
import { game } from '../testing/scenario.js';
import { IllegalCastError } from './cast.js';
import type { CardDefinition } from './definition.js';

/**
 * A target has to be something the spell actually asks for (CR 601.2c).
 *
 * Counting the targets and checking they are targetable at all (CR 115) is not the same
 * rule: without this one, "destroy target artifact" can be aimed at a creature and
 * "counter target noncreature spell" at a creature spell. Both are strictly better cards
 * than the ones that are printed, and nothing else in the engine would object — the
 * effect happily destroys whatever it was handed.
 */

const shatter: CardDefinition = {
  oracleId: asOracleId('tr-shatter'),
  name: 'Test Shatter',
  manaCost: parseManaCost(''),
  types: ['instant'],
  colours: [],
  abilities: [
    {
      kind: 'spell',
      targets: [{ id: 't', filter: { kind: 'type', type: 'artifact' } }],
      effects: [{ op: 'destroy', object: { kind: 'target', id: 't' } }],
    },
  ],
};

const relic: CardDefinition = {
  oracleId: asOracleId('tr-relic'),
  name: 'Test Relic',
  manaCost: parseManaCost(''),
  types: ['artifact'],
  colours: [],
  abilities: [],
};

const board = () =>
  game({ definitions: [shatter, relic], seed: 'targets' })
    .player('A')
    .hand({ name: 'shatter', definitionId: shatter.oracleId })
    .battlefield({ name: 'relic', definitionId: relic.oracleId })
    .library(10)
    .player('B')
    .battlefield({ name: 'bear', power: 2, toughness: 2 })
    .library(10)
    .player('A')
    .start()
    .to('precombatMain');

describe('a target must be what the spell asks for', () => {
  it('refuses a creature where the spell says artifact', () => {
    const table = board();
    expect(() => table.cast('shatter', { targets: [table.target('bear')] })).toThrow(
      IllegalCastError,
    );
  });

  it('refuses a player where the spell says artifact', () => {
    expect(() => board().cast('shatter', { targets: [{ kind: 'player', player: 'B' }] })).toThrow(
      IllegalCastError,
    );
  });

  it('allows the artifact it does ask for', () => {
    const table = board();
    expect(() => table.cast('shatter', { targets: [table.target('relic')] })).not.toThrow();
  });
});
