import { type CardDefinition, parseManaCost } from '@mtg/engine';
import { asOracleId } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { runScenarioTest } from './scenario-tests.js';
import { scenarioTestSchema } from './schema.js';

/**
 * The runner that plays a card's declared tests (docs/09 "Card tests").
 *
 * `card-tests.test.ts` runs every bootstrap card's tests and expects them all to pass,
 * which says nothing about whether a *failing* card would be caught. That is what this
 * checks: the same card, with each expectation turned wrong in turn, and the runner has
 * to say so. A harness that reports "" whatever the game did would make all sixty of
 * those cards look correct.
 */

const bolt: CardDefinition = {
  oracleId: asOracleId('scenario-bolt'),
  name: 'Test Bolt',
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

const test = (input: unknown) => scenarioTestSchema.parse(input);

describe('runScenarioTest', () => {
  it('reports nothing when the card does what the test says', () => {
    const outcome = runScenarioTest(
      bolt,
      test({ name: 'burns', targets: ['opponent'], expect: { life: { opponent: 17 } } }),
    );
    expect(outcome).toEqual([]);
  });

  it('reports a life total that is not what was expected', () => {
    const outcome = runScenarioTest(
      bolt,
      test({ name: 'burns', targets: ['opponent'], expect: { life: { opponent: 18 } } }),
    );
    expect(outcome.join('; ')).toContain("opponent's life: expected 18, got 17");
  });

  it('reports a card that ended up in the wrong zone', () => {
    const outcome = runScenarioTest(
      bolt,
      test({ name: 'burns', targets: ['opponent'], expect: { zone: { this: 'exile' } } }),
    );
    expect(outcome.join('; ')).toContain('where this is: expected exile');
  });

  it('reports the wrong number of permanents', () => {
    const outcome = runScenarioTest(
      bolt,
      test({ name: 'burns', targets: ['opponent'], expect: { permanents: { you: 99 } } }),
    );
    expect(outcome.join('; ')).toContain('permanents you controls: expected 99');
  });

  it('reports a creature that was expected to have died', () => {
    const outcome = runScenarioTest(
      bolt,
      test({
        name: 'kills a bear',
        setup: { opponent: { creatures: [{ name: 'bear', power: 2, toughness: 2 }] } },
        targets: ['bear'],
        expect: { zone: { bear: 'battlefield' } },
      }),
    );
    expect(outcome.join('; ')).toContain('where bear is: expected battlefield, got B:graveyard');
  });

  it('turns a throw into a reported failure rather than an exception', () => {
    const outcome = runScenarioTest(
      bolt,
      test({ name: 'aims at nothing', targets: ['nobody'], expect: {} }),
    );
    expect(outcome.join('; ')).toContain('threw:');
  });
});
