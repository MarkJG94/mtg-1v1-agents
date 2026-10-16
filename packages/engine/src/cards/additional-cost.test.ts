import { asOracleId, playerZone } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { createEventEmitter } from '../events/emitter.js';
import type { LegalAction } from '../legal-actions.js';
import { parseManaCost } from '../mana/cost.js';
import { objectsIn } from '../state/update.js';
import { game } from '../testing/scenario.js';
import { castSpell, IllegalCastError } from './cast.js';
import type { AdditionalCost, CardDefinition } from './definition.js';

/**
 * "As an additional cost to cast this spell, sacrifice a creature / discard a card / pay
 * 3 life" (CR 601.2b, 601.2h, 118.8). The choice is part of the cast action, the way the
 * targets are, so what `legalActions` offers is every way of paying — and nothing that
 * cannot be paid.
 */

const spell = (name: string, cost: AdditionalCost, targeted = false): CardDefinition => ({
  oracleId: asOracleId(`ac-${name}`),
  name,
  manaCost: parseManaCost(''),
  types: ['sorcery'],
  colours: [],
  additionalCost: cost,
  abilities: [
    targeted
      ? {
          kind: 'spell',
          targets: [{ id: 't', filter: { kind: 'creature' } }],
          effects: [{ op: 'destroy', object: { kind: 'target', id: 't' } }],
        }
      : { kind: 'spell', effects: [{ op: 'draw', player: { kind: 'you' }, count: 2 }] },
  ],
});

const bargain = spell('Bargain', { sacrifice: { filter: { kind: 'creature' }, count: 1 } });
const rummage = spell('Rummage', { discard: 1 });
const covenant = spell('Covenant', { life: 5 });
const execution = spell(
  'Execution',
  { sacrifice: { filter: { kind: 'creature' }, count: 1 } },
  true,
);

const table = (
  card: CardDefinition,
  options: { creatures?: number; hand?: number; life?: number } = {},
) => {
  const scenario = game({ definitions: [card], seed: 'additional-cost' })
    .player('A')
    .hand(
      { name: 'card', definitionId: card.oracleId },
      ...Array.from({ length: options.hand ?? 0 }, (_, i) => ({
        name: `h${i}`,
        power: 1,
        toughness: 1,
      })),
    )
    .battlefield(
      ...Array.from({ length: options.creatures ?? 0 }, (_, i) => ({
        name: `c${i}`,
        power: 1,
        toughness: 1,
      })),
    )
    .library(10);
  if (options.life !== undefined) scenario.life(options.life);
  return scenario
    .player('B')
    .battlefield({ name: 'theirs', power: 3, toughness: 3 })
    .library(10)
    .player('A')
    .start()
    .to('precombatMain');
};

const castsOf = (scenario: ReturnType<typeof table>) => {
  const decision = scenario.get().pendingDecision;
  const options: readonly LegalAction[] = decision?.kind === 'priority' ? decision.options : [];
  return options.filter(
    (action): action is Extract<LegalAction, { kind: 'cast' }> =>
      action.kind === 'cast' && action.object === scenario.ref('card'),
  );
};

const castWith = (scenario: ReturnType<typeof table>, action: LegalAction) =>
  scenario.decide({ kind: 'priority', action }).resolve();

describe('a sacrifice as an additional cost (CR 701.21a)', () => {
  it('is offered once for each permanent of yours it could be, and never the opponent’s', () => {
    const scenario = table(bargain, { creatures: 2 });
    const casts = castsOf(scenario);
    expect(casts.map((cast) => cast.sacrifice)).toEqual([
      [scenario.ref('c0')],
      [scenario.ref('c1')],
    ]);
  });

  it('is paid as the spell is cast: the creature is in the graveyard before it resolves', () => {
    const scenario = table(bargain, { creatures: 2 });
    const [first] = castsOf(scenario);
    scenario.decide({ kind: 'priority', action: first as LegalAction });
    expect(scenario.zoneOf('c0')).toBe(playerZone('A', 'graveyard'));
    expect(scenario.zoneOf('card')).toBe('stack');
    scenario.resolve();
    expect(scenario.zoneOf('c1')).toBe('battlefield');
  });

  it('takes as many as it says, in every combination: two of three creatures is three ways', () => {
    const pact = spell('Pact', { sacrifice: { filter: { kind: 'creature' }, count: 2 } });
    const scenario = table(pact, { creatures: 3 });
    const [c0, c1, c2] = ['c0', 'c1', 'c2'].map((name) => scenario.ref(name));
    expect(castsOf(scenario).map((cast) => cast.sacrifice)).toEqual([
      [c0, c1],
      [c0, c2],
      [c1, c2],
    ]);
    expect(castsOf(table(pact, { creatures: 1 }))).toEqual([]);
  });

  it('makes the spell uncastable with nothing to sacrifice', () => {
    expect(castsOf(table(bargain, { creatures: 0 }))).toEqual([]);
  });

  it('does not offer the spell’s own target as what it sacrifices', () => {
    const scenario = table(execution, { creatures: 1 });
    const casts = castsOf(scenario);
    // Aimed at A's own creature, the only one A could sacrifice is that one: not offered.
    expect(
      casts.every(
        (cast) =>
          !cast.sacrifice?.some((id) =>
            cast.targets.some((t) => t.kind === 'object' && t.object === id),
          ),
      ),
    ).toBe(true);
    expect(casts.map((cast) => cast.targets)).toEqual([[scenario.target('theirs')]]);
  });
});

describe('a discard as an additional cost', () => {
  it('is offered for each other card in hand, never the spell itself', () => {
    const scenario = table(rummage, { hand: 2 });
    expect(castsOf(scenario).map((cast) => cast.discard)).toEqual([
      [scenario.ref('h0')],
      [scenario.ref('h1')],
    ]);
  });

  it('discards the card chosen, and the spell still resolves', () => {
    const scenario = table(rummage, { hand: 2 });
    const [first] = castsOf(scenario);
    castWith(scenario, first as LegalAction);
    expect(scenario.zoneOf('h0')).toBe(playerZone('A', 'graveyard'));
    expect(scenario.zoneOf('card')).toBe(playerZone('A', 'graveyard'));
    // h1 stays, and the spell drew two.
    expect(objectsIn(scenario.get(), playerZone('A', 'hand'))).toHaveLength(3);
  });

  it('makes the spell uncastable with no other card in hand', () => {
    expect(castsOf(table(rummage, { hand: 0 }))).toEqual([]);
  });
});

describe('life as an additional cost (CR 119.4)', () => {
  it('is paid, as a loss of life', () => {
    const scenario = table(covenant, { life: 20 });
    const [cast] = castsOf(scenario);
    expect(cast?.life).toBe(5);
    castWith(scenario, cast as LegalAction);
    expect(scenario.lifeOf('A')).toBe(15);
  });

  it('can be paid with exactly that much life, and not with less', () => {
    expect(castsOf(table(covenant, { life: 5 }))).toHaveLength(1);
    expect(castsOf(table(covenant, { life: 4 }))).toEqual([]);
  });
});

describe('what casting refuses', () => {
  const emitter = () => createEventEmitter();

  it('the wrong number of things to sacrifice', () => {
    const scenario = table(bargain, { creatures: 2 });
    expect(() =>
      castSpell(scenario.get(), emitter(), 'A', scenario.ref('card'), {
        sacrifice: [scenario.ref('c0'), scenario.ref('c1')],
      }),
    ).toThrow(IllegalCastError);
    expect(() => castSpell(scenario.get(), emitter(), 'A', scenario.ref('card'))).toThrow(
      IllegalCastError,
    );
  });

  it('a permanent that is not the caster’s', () => {
    const scenario = table(bargain, { creatures: 1 });
    expect(() =>
      castSpell(scenario.get(), emitter(), 'A', scenario.ref('card'), {
        sacrifice: [scenario.ref('theirs')],
      }),
    ).toThrow(IllegalCastError);
  });

  it('a life payment the caster cannot make (CR 119.4)', () => {
    const scenario = table(covenant, { life: 4 });
    expect(() => castSpell(scenario.get(), emitter(), 'A', scenario.ref('card'))).toThrow(/life/);
  });

  it('the spell itself as its own discard', () => {
    const scenario = table(rummage, { hand: 1 });
    expect(() =>
      castSpell(scenario.get(), emitter(), 'A', scenario.ref('card'), {
        discard: [scenario.ref('card')],
      }),
    ).toThrow(IllegalCastError);
  });

  it('a payment for a spell that has no additional cost', () => {
    const plain: CardDefinition = {
      ...bargain,
      oracleId: asOracleId('ac-plain'),
      additionalCost: undefined as never,
    };
    const { additionalCost: _, ...free } = plain;
    const scenario = table(free as CardDefinition, { creatures: 1 });
    expect(() =>
      castSpell(scenario.get(), emitter(), 'A', scenario.ref('card'), {
        sacrifice: [scenario.ref('c0')],
      }),
    ).toThrow(IllegalCastError);
  });
});
