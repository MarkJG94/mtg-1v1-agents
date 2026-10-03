import { asOracleId } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { parseManaCost } from '../mana/cost.js';
import { game } from '../testing/scenario.js';
import type { CardDefinition } from './definition.js';

/**
 * "Whenever another creature **you control** dies" is most of the printed wording, and
 * the difference matters: a trigger that also fired on the opponent's dying creatures
 * would be a different card.
 */

const shambler: CardDefinition = {
  oracleId: asOracleId('t-shambler'),
  name: 'Shambler',
  manaCost: parseManaCost('{1}{G}'),
  types: ['creature'],
  colours: ['G'],
  power: 1,
  toughness: 1,
  abilities: [
    {
      kind: 'triggered',
      id: 'grows',
      when: { kind: 'anotherDies', controlledBy: 'you' },
      effects: [{ op: 'addCounters', object: { kind: 'source' }, counter: '+1/+1', amount: 1 }],
    },
  ],
};

const board = () =>
  game({ definitions: [shambler] })
    .player('A')
    .battlefield(
      { name: 'shambler', definitionId: shambler.oracleId },
      { name: 'mine', power: 1, toughness: 1 },
    )
    .player('B')
    .battlefield({ name: 'theirs', power: 1, toughness: 1 })
    .start()
    .to('precombatMain');

describe('a death trigger that only watches its own side', () => {
  it('grows when a creature its controller owns dies', () => {
    const scenario = board();
    const killed = scenario.kill('mine').resolve();

    expect(killed.object('shambler').counters['+1/+1']).toBe(1);
  });

  it('does not grow when the opponent loses one', () => {
    const scenario = board();
    const killed = scenario.kill('theirs').resolve();

    expect(killed.object('shambler').counters['+1/+1']).toBeUndefined();
  });
});
