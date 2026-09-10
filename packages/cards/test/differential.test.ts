import type { CardDefinition } from '@mtg/engine';
import { describe, expect, it } from 'vitest';
import { differentialTest } from '../src/differential.js';

const bolt: CardDefinition = {
  id: 'a',
  name: 'Bolt A',
  manaCost: '{R}',
  types: ['instant'],
  abilities: [
    {
      kind: 'spell',
      targets: [{ id: 't', filter: { any: true } }],
      effects: [{ op: 'damage', amount: 3, to: '$t' }],
    },
  ],
};

describe('differential harness', () => {
  it('two equivalent definitions behave identically', () => {
    const same: CardDefinition = { ...bolt, id: 'b', name: 'Bolt B' };
    expect(differentialTest(bolt, same).identical).toBe(true);
  });

  it('a behavioural difference is reported', () => {
    const weaker: CardDefinition = {
      ...bolt,
      id: 'c',
      name: 'Bolt C',
      abilities: [
        {
          kind: 'spell',
          targets: [{ id: 't', filter: { any: true } }],
          effects: [{ op: 'damage', amount: 2, to: '$t' }],
        },
      ],
    };
    const r = differentialTest(bolt, weaker);
    expect(r.identical).toBe(false);
    expect(r.differences.length).toBeGreaterThan(0);
  });
});
