import { fileURLToPath } from 'node:url';
import { type CardDefinition, parseManaCost } from '@mtg/engine';
import { asOracleId } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { differentialTest } from './differential.js';
import { readScripts } from './files.js';
import { loadCardScript } from './load.js';
import { cardScriptSchema, type ScenarioTest } from './schema.js';
import { smokeScenarios } from './smoke.js';

/**
 * The differential harness has nothing real to compare yet: the auto-scripter is phase 3,
 * so no card has both a hand script and an auto one. What can be checked now is that the
 * harness itself would notice — so the "auto script" here is the hand script with one
 * thing changed, and each case names the change it has to catch.
 */

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

const bolt: CardDefinition = {
  oracleId: asOracleId('diff-bolt'),
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

const tests: readonly ScenarioTest[] = [
  { name: 'burns the opponent', targets: ['opponent'], expect: { life: { opponent: 17 } } },
];

/** The same card with its spell ability rewritten: one script, one thing changed. */
const variant = (
  ability: Partial<Extract<CardDefinition['abilities'][number], { kind: 'spell' }>>,
) =>
  ({
    ...bolt,
    abilities: [{ ...(bolt.abilities[0] as { kind: 'spell' }), ...ability }],
  }) as CardDefinition;

describe('differentialTest', () => {
  it('finds no disagreement between a script and itself', () => {
    const result = differentialTest(bolt, bolt, tests);
    expect(result.disagreements).toEqual([]);
    expect(result.compared).toBeGreaterThan(0);
  });

  it('catches an effect that does the wrong amount', () => {
    const weaker = variant({
      effects: [{ op: 'damage', to: { kind: 'chosen', id: 't' }, amount: 2 }],
    });
    const result = differentialTest(bolt, weaker, tests);
    expect(result.disagreements.some((each) => each.detail.includes('life'))).toBe(true);
  });

  /**
   * The point of a differential test over a scenario test: nobody declared an expectation
   * about hand size, and it is caught anyway.
   */
  it('catches an effect that does something extra nobody asserted about', () => {
    const greedy = variant({
      effects: [
        { op: 'damage', to: { kind: 'chosen', id: 't' }, amount: 3 },
        { op: 'draw', player: { kind: 'you' }, count: 1 },
      ],
    });
    const result = differentialTest(bolt, greedy, tests);
    expect(result.disagreements.some((each) => each.detail.includes('hand'))).toBe(true);
  });

  /** The declared test aims at a player, which a creature-only version cannot be cast at. */
  it('reports one script throwing where the other does not', () => {
    const broken = variant({ targets: [{ id: 't', filter: { kind: 'creature' } }] });
    const result = differentialTest(bolt, broken, tests);
    expect(result.disagreements.some((each) => each.detail.includes('threw'))).toBe(true);
  });

  it('does not count a scenario neither script could be played in as compared', () => {
    const creatureOnly = variant({
      targets: [{ id: 't', filter: { kind: 'creature' } }],
    });
    const result = differentialTest(creatureOnly, creatureOnly);
    expect(result.skipped.length).toBeGreaterThan(0);
    expect(result.compared).toBe(smokeScenarios.length - result.skipped.length);
  });
});

/**
 * The harness over the real bootstrap set, with the hand script standing in for both
 * sides. It proves nothing about the auto-scripter — that comparison waits on phase 3 —
 * but it does prove that every script in the set can be played twice and fingerprinted
 * without the two runs drifting apart, which is the half of the harness that exists
 * today. A card that disagreed with itself would mean the fingerprint reads something
 * that is not a fact about the game, and every comparison after it would be noise.
 */
describe('every bootstrap script agrees with itself', () => {
  const cases = readScripts(here('../scripts')).map((file) => {
    const definition = loadCardScript(file.content);
    return [definition.name, definition, cardScriptSchema.parse(file.content).tests] as const;
  });

  it.each(cases)('%s', (_name, definition, own) => {
    const result = differentialTest(definition, definition, own);
    expect(result.disagreements).toEqual([]);
  });
});
