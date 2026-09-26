import { asOracleId } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { parseManaCost } from '../mana/cost.js';
import { setZone } from '../state/update.js';
import { game } from '../testing/scenario.js';
import type { CardDefinition } from './definition.js';
import { staticReplacements } from './statics.js';

/**
 * The replacements permanents in play make, which are derived from the battlefield
 * rather than registered — and, since 4.8, remembered for a board until it changes.
 */

const gate: CardDefinition = {
  oracleId: asOracleId('t-gate'),
  name: 'Test Gate',
  manaCost: parseManaCost(''),
  types: ['land'],
  colours: [],
  abilities: [
    {
      kind: 'replacement',
      id: 'enters-tapped',
      applies: { kind: 'entersBattlefield', object: 'source' },
      change: { kind: 'entersTapped' },
      selfReplacement: true,
    },
  ],
};

describe('the replacements in play', () => {
  const board = () =>
    game({ definitions: [gate] })
      .player('A')
      .battlefield(
        { name: 'first', definitionId: gate.oracleId },
        { name: 'second', definitionId: gate.oracleId },
      )
      .library(5)
      .player('B')
      .library(5);

  it('lists each permanent’s replacements, in battlefield order', () => {
    const scenario = board();
    expect(staticReplacements(scenario.get()).map((effect) => effect.source)).toEqual([
      scenario.ref('first'),
      scenario.ref('second'),
    ]);
  });

  /**
   * Reordering the battlefield changes nothing about any object, so the object table is
   * the same one — the remembered list has to notice the battlefield itself.
   */
  it('follows the battlefield when only its order changes', () => {
    const scenario = board();
    const state = scenario.get();
    expect(staticReplacements(state)).toHaveLength(2);
    const reordered = setZone(state, 'battlefield', [...state.zones.battlefield].reverse());
    expect(reordered.objects).toBe(state.objects);
    expect(staticReplacements(reordered).map((effect) => effect.source)).toEqual([
      scenario.ref('second'),
      scenario.ref('first'),
    ]);
  });
});
