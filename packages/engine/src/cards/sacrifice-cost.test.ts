import { asOracleId } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { parseManaCost } from '../mana/cost.js';
import { game } from '../testing/scenario.js';
import type { CardDefinition } from './definition.js';

const fanatic: CardDefinition = {
  oracleId: asOracleId('t-fanatic'),
  name: 'Fanatic',
  manaCost: parseManaCost('{R}'),
  types: ['creature'],
  colours: ['R'],
  power: 1,
  toughness: 1,
  abilities: [
    {
      kind: 'activated',
      id: 'fling',
      cost: { sacrificeSelf: true },
      targets: [{ id: 't', filter: { kind: 'any' } }],
      effects: [{ op: 'damage', to: { kind: 'chosen', id: 't' }, amount: 1 }],
    },
  ],
};

describe('sacrifice as an activation cost (CR 118.3)', () => {
  it('puts the source in the graveyard before the ability resolves', () => {
    const scenario = game({ definitions: [fanatic] })
      .player('A')
      .battlefield({ name: 'fanatic', definitionId: fanatic.oracleId })
      .player('B')
      .start()
      .to('precombatMain')
      .player('A')
      .activate('fanatic', 'fling', { targets: [{ kind: 'player', player: 'B' }] })
      .resolve();

    expect(scenario.zoneOf('fanatic')).toBe('A:graveyard');
    expect(scenario.lifeOf('B')).toBe(19);
  });
});
