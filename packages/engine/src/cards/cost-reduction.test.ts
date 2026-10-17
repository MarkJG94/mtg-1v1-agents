import { asOracleId, type ObjectId } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { createEventEmitter } from '../events/emitter.js';
import type { LegalAction } from '../legal-actions.js';
import { parseManaCost } from '../mana/cost.js';
import type { GameState } from '../state/game-state.js';
import { game } from '../testing/scenario.js';
import { castSpell } from './cast.js';
import type { CardDefinition, CostReduction } from './definition.js';

/**
 * "This spell costs {1} less to cast for each creature you control" (CR 601.2f): the
 * generic part comes down by what is counted as the spell is cast, never below nothing,
 * and never the coloured part. `legalActions` prices it the same way casting pays it.
 */

let made = 0;
const golem = (reduction: CostReduction): CardDefinition => {
  made += 1;
  return {
    oracleId: asOracleId(`cr-golem-${made}`),
    name: 'Golem',
    manaCost: parseManaCost('{4}{R}'),
    types: ['sorcery'],
    colours: ['R'],
    costReduction: reduction,
    abilities: [
      { kind: 'spell', effects: [{ op: 'gainLife', player: { kind: 'you' }, amount: 1 }] },
    ],
  };
};

const mountain: CardDefinition = {
  oracleId: asOracleId('cr-mountain'),
  name: 'Red Land',
  manaCost: parseManaCost(''),
  types: ['land'],
  colours: [],
  abilities: [{ kind: 'mana', id: 'r', modes: [[{ type: 'R', amount: 1 }]] }],
};

const yours = (filter: object) =>
  ({ kind: 'and', filters: [filter, { kind: 'controlledBy', player: 'you' }] }) as never;

/** "… for each creature you control." */
const perCreature: CostReduction = { generic: { kind: 'count', of: yours({ kind: 'creature' }) } };

/** "… for each creature card in your graveyard." */
const perDeadCreature: CostReduction = {
  generic: {
    kind: 'count',
    of: {
      kind: 'and',
      filters: [
        { kind: 'type', type: 'creature' },
        { kind: 'inGraveyard', player: 'you' },
      ],
    },
  },
};

/** "This spell costs {2} less to cast if you control a creature with flying." */
const ifFlier: CostReduction = {
  generic: 2,
  if: {
    kind: 'exists',
    filter: yours({
      kind: 'and',
      filters: [{ kind: 'creature' }, { kind: 'hasKeyword', keyword: 'flying' }],
    }),
  },
};

interface Board {
  readonly lands: number;
  readonly mine?: number;
  readonly theirs?: number;
  readonly dead?: number;
  readonly theirDead?: number;
  readonly flier?: boolean;
}

const table = (card: CardDefinition, board: Board) => {
  const creatures = (prefix: string, count: number, flying = false) =>
    Array.from({ length: count }, (_, i) => ({
      name: `${prefix}${i}`,
      power: 1,
      toughness: 1,
      ...(flying ? { keywords: { flying: true } } : {}),
    }));
  return game({ definitions: [card, mountain], seed: 'cost-reduction' })
    .player('A')
    .hand({ name: 'card', definitionId: card.oracleId })
    .battlefield(
      ...Array.from({ length: board.lands }, (_, i) => ({
        name: `land${i}`,
        definitionId: mountain.oracleId,
      })),
      ...creatures('mine', board.mine ?? 0, board.flier === true),
    )
    .graveyard(...creatures('dead', board.dead ?? 0))
    .library(10)
    .player('B')
    .battlefield(...creatures('theirs', board.theirs ?? 0))
    .graveyard(...creatures('theirDead', board.theirDead ?? 0))
    .library(10)
    .player('A')
    .start()
    .to('precombatMain');
};

const castOf = (scenario: ReturnType<typeof table>) => {
  const decision = scenario.get().pendingDecision;
  const options: readonly LegalAction[] = decision?.kind === 'priority' ? decision.options : [];
  return options.find(
    (action): action is Extract<LegalAction, { kind: 'cast' }> =>
      action.kind === 'cast' && action.object === scenario.ref('card'),
  );
};

const tapped = (state: GameState, scenario: ReturnType<typeof table>, lands: number) =>
  Array.from({ length: lands }, (_, i) => scenario.ref(`land${i}`)).filter(
    (id: ObjectId) => state.objects.get(id)?.tapped === true,
  ).length;

describe('a spell that costs less for each thing counted', () => {
  it('takes one generic off for each, counting only what the caster controls', () => {
    const scenario = table(golem(perCreature), { lands: 5, mine: 3, theirs: 2 });
    expect(castOf(scenario)?.cost.generic).toBe(1);
    expect(castOf(scenario)?.cost.symbols).toHaveLength(1);
  });

  it('never below nothing, and never the coloured part', () => {
    const cost = castOf(table(golem(perCreature), { lands: 5, mine: 7 }))?.cost;
    expect(cost?.generic).toBe(0);
    expect(cost?.symbols).toHaveLength(1);
  });

  it('counts cards in the caster’s own graveyard, not the opponent’s', () => {
    const scenario = table(golem(perDeadCreature), { lands: 5, dead: 3, theirDead: 4 });
    expect(castOf(scenario)?.cost.generic).toBe(1);
  });

  it('is paid at the reduced cost: only that many lands are tapped', () => {
    const scenario = table(golem(perCreature), { lands: 5, mine: 3 });
    const after = castSpell(scenario.get(), createEventEmitter(), 'A', scenario.ref('card'));
    // {4}{R} less three is {1}{R}.
    expect(tapped(after, scenario, 5)).toBe(2);
    expect(after.objects.get(scenario.ref('card'))?.zone).toBe('stack');
  });

  it('is offered with the reduction, and only with it, when the lands are few', () => {
    // {4}{R} less three is {1}{R}: two lands pay it, and nothing else would.
    expect(castOf(table(golem(perCreature), { lands: 2, mine: 3 }))).toBeDefined();
    expect(castOf(table(golem(perCreature), { lands: 2, mine: 2 }))).toBeUndefined();
  });
});

describe('a spell that costs less if something holds', () => {
  it('takes the amount off when it holds, and nothing when it does not', () => {
    const board = { lands: 5, mine: 1 };
    expect(castOf(table(golem(ifFlier), { ...board, flier: true }))?.cost.generic).toBe(2);
    expect(castOf(table(golem(ifFlier), board))?.cost.generic).toBe(4);
  });
});

describe('what a reduction does not change', () => {
  it('leaves the spell’s mana value as printed (CR 202.3)', () => {
    const card = golem(perCreature);
    const scenario = table(card, { lands: 5, mine: 3 });
    expect(castOf(scenario)?.cost.generic).toBe(1);
    expect(scenario.get().definitions.get(card.oracleId)?.manaCost.generic).toBe(4);
  });
});
