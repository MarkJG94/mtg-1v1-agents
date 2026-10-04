import { asOracleId, playerZone } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { parseManaCost } from '../mana/cost.js';
import { objectsIn } from '../state/update.js';
import { game } from '../testing/scenario.js';
import type { CardDefinition } from './definition.js';
import type { EffectOp } from './ops.js';

/**
 * Resolution as a program the game can stop in (ADR 0021): "you may" (CR 608.2d), a
 * discard the player chooses (CR 701.9b), and a replacement choice part-way through an
 * ability (CR 616.1) — each waits on a player, and the rest of the ability runs after.
 */

const spell = (
  name: string,
  effects: readonly EffectOp[],
  targets: CardDefinition['abilities'][number] extends never ? never : unknown = undefined,
): CardDefinition => ({
  oracleId: asOracleId(`pr-${name}`),
  name,
  manaCost: parseManaCost(''),
  types: ['sorcery'],
  colours: [],
  abilities: [
    {
      kind: 'spell',
      ...(targets === undefined ? {} : { targets: targets as never }),
      effects,
    },
  ],
});

const you = { kind: 'you' } as const;
const opponent = { kind: 'opponent' } as const;

/** "You may draw a card. You gain 1 life." — the second sentence happens either way. */
const ponder = spell('Maybe', [
  { op: 'may', player: you, effects: [{ op: 'draw', player: you, count: 1 }] },
  { op: 'gainLife', player: you, amount: 1 },
]);

/** "Target player discards two cards." */
const mindRot = spell(
  'Rot',
  [{ op: 'discard', player: { kind: 'target', id: 'p' }, count: 2 }],
  [{ id: 'p', filter: { kind: 'player' } }],
);

/** "Each player discards a card." */
const wheel = spell('Wheel', [{ op: 'discard', player: { kind: 'each' }, count: 1 }]);

/** "Destroy target creature." — for what the log says when it resolves. */
const doom = spell(
  'Doom',
  [{ op: 'destroy', object: { kind: 'target', id: 't' } }],
  [{ id: 't', filter: { kind: 'creature' } }],
);

/** "Deal 3 damage to your opponent. You gain 2 life." */
const scorch = spell('Scorch', [
  { op: 'damage', to: { kind: 'player', player: opponent }, amount: 3 },
  { op: 'gainLife', player: you, amount: 2 },
]);

const table = (card: CardDefinition, hand: { A?: number; B?: number } = {}) =>
  game({ definitions: [card], seed: 'program', recordEvents: true })
    .player('A')
    .hand({ name: 'card', definitionId: card.oracleId }, ...filler('a', hand.A ?? 0))
    .battlefield({ name: 'bear', power: 2, toughness: 2 })
    .library(10)
    .player('B')
    .hand(...filler('b', hand.B ?? 0))
    .battlefield({ name: 'ogre', power: 3, toughness: 3 })
    .library(10)
    .player('A')
    .start()
    .to('precombatMain');

const filler = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => ({ name: `${prefix}${i}`, power: 1, toughness: 1 }));

const handOf = (scenario: ReturnType<typeof table>, player: 'A' | 'B') =>
  objectsIn(scenario.get(), playerZone(player, 'hand'));

/** Cast it and let both players pass, so it begins to resolve. */
const castAndResolve = (scenario: ReturnType<typeof table>, targets = {}) =>
  scenario.cast('card', targets).pass(2);

describe('"you may" (CR 608.2d)', () => {
  it('stops for a yes or no from the player, with the spell still on the stack', () => {
    const scenario = castAndResolve(table(ponder));
    const decision = scenario.get().pendingDecision;
    expect(decision).toMatchObject({ kind: 'yesNo', player: 'A', options: [true, false] });
    expect(scenario.zoneOf('card')).toBe('stack');
  });

  it('on a yes does it, then the rest of the spell, then the spell leaves the stack', () => {
    const scenario = table(ponder);
    const before = handOf(scenario, 'A').length;
    castAndResolve(scenario).decide({ kind: 'yesNo', answer: true });
    expect(handOf(scenario, 'A')).toHaveLength(before);
    expect(scenario.lifeOf('A')).toBe(21);
    expect(scenario.zoneOf('card')).toBe(playerZone('A', 'graveyard'));
    expect(scenario.get().resolution).toBeNull();
  });

  it('on a no skips it, and still does the rest', () => {
    const scenario = table(ponder);
    const before = handOf(scenario, 'A').length;
    castAndResolve(scenario).decide({ kind: 'yesNo', answer: false });
    expect(handOf(scenario, 'A')).toHaveLength(before - 1);
    expect(scenario.lifeOf('A')).toBe(21);
    expect(scenario.zoneOf('card')).toBe(playerZone('A', 'graveyard'));
  });
});

describe('a discard the player chooses (CR 701.9b)', () => {
  it('asks the player discarding, not the caster, for as many as it says', () => {
    const scenario = table(mindRot, { B: 3 });
    castAndResolve(scenario, { targets: [{ kind: 'player', player: 'B' }] });
    expect(scenario.get().pendingDecision).toMatchObject({
      kind: 'discard',
      player: 'B',
      count: 2,
    });
    const [first, , third] = handOf(scenario, 'B');
    scenario.decide({ kind: 'discard', cards: [first, third] as never });
    expect(handOf(scenario, 'B')).toHaveLength(1);
    expect(objectsIn(scenario.get(), playerZone('B', 'graveyard'))).toEqual([first, third]);
    expect(scenario.zoneOf('card')).toBe(playerZone('A', 'graveyard'));
  });

  it('asks for only what the hand holds, and nothing of an empty hand', () => {
    const one = table(mindRot, { B: 1 });
    castAndResolve(one, { targets: [{ kind: 'player', player: 'B' }] });
    expect(one.get().pendingDecision).toMatchObject({ kind: 'discard', count: 1 });

    const none = table(mindRot, { B: 0 });
    castAndResolve(none, { targets: [{ kind: 'player', player: 'B' }] });
    expect(none.get().pendingDecision?.kind).not.toBe('discard');
    expect(none.zoneOf('card')).toBe(playerZone('A', 'graveyard'));
  });

  it('asks each player in turn, the active player first (CR 101.4)', () => {
    const scenario = table(wheel, { A: 2, B: 2 });
    castAndResolve(scenario);
    expect(scenario.get().pendingDecision).toMatchObject({ kind: 'discard', player: 'A' });
    scenario.decide({ kind: 'discard', cards: [handOf(scenario, 'A')[0]] as never });
    expect(scenario.get().pendingDecision).toMatchObject({ kind: 'discard', player: 'B' });
    scenario.decide({ kind: 'discard', cards: [handOf(scenario, 'B')[0]] as never });
    expect(handOf(scenario, 'A')).toHaveLength(1);
    expect(handOf(scenario, 'B')).toHaveLength(1);
    expect(scenario.zoneOf('card')).toBe(playerZone('A', 'graveyard'));
  });
});

describe('a replacement choice part-way through an ability (CR 616.1)', () => {
  /** This used to throw: there was nowhere to keep the rest of the ability. */
  it('waits on the choice, then runs the rest of the ability', () => {
    const scenario = game({ definitions: [scorch], seed: 'program' })
      .player('A')
      .hand({ name: 'card', definitionId: scorch.oracleId })
      .library(10)
      .player('B')
      .battlefield({ name: 'shield' }, { name: 'doubler' })
      .library(10);
    scenario
      .replacement({
        source: scenario.ref('shield'),
        controller: 'B',
        applies: { kind: 'damageToPlayer', player: 'B' },
        change: { kind: 'preventDamage', amount: 2 },
        duration: { kind: 'permanent' },
      })
      .replacement({
        source: scenario.ref('doubler'),
        controller: 'B',
        applies: { kind: 'damageToPlayer', player: 'B' },
        change: { kind: 'modifyDamage', multiply: 2 },
        duration: { kind: 'permanent' },
      })
      .player('A')
      .start()
      .to('precombatMain');
    scenario.cast('card').pass(2);
    const decision = scenario.get().pendingDecision;
    expect(decision?.kind).toBe('chooseReplacement');
    if (decision?.kind !== 'chooseReplacement') return;
    scenario.decide({ kind: 'chooseReplacement', effect: decision.options[0] as number });
    expect(scenario.lifeOf('A')).toBe(22);
    expect(scenario.lifeOf('B')).toBeLessThan(20);
    expect(scenario.zoneOf('card')).toBe(playerZone('A', 'graveyard'));
  });
});

/** "Destroy each creature your opponent controls", one at a time in battlefield order. */
const sweep = spell('Sweep', [
  {
    op: 'forEach',
    of: {
      kind: 'and',
      filters: [{ kind: 'creature' }, { kind: 'controlledBy', player: 'opponent' }],
    },
    effects: [{ op: 'destroy', object: { kind: 'each' } }],
  },
]);

describe('"for each" (CR 608.2c)', () => {
  it('does it to each object in turn, in the order they are on the battlefield', () => {
    const scenario = game({ definitions: [sweep], seed: 'program' })
      .player('A')
      .hand({ name: 'card', definitionId: sweep.oracleId })
      .library(5)
      .player('B')
      .battlefield(
        { name: 'first', power: 1, toughness: 1 },
        { name: 'second', power: 2, toughness: 2 },
        { name: 'third', power: 3, toughness: 3 },
      )
      .library(5)
      .player('A')
      .start()
      .to('precombatMain');
    scenario.cast('card').resolve();
    expect(objectsIn(scenario.get(), playerZone('B', 'graveyard'))).toEqual([
      scenario.ref('first'),
      scenario.ref('second'),
      scenario.ref('third'),
    ]);
  });
});

/** "If your opponent controls a creature, you gain 3 life. Otherwise, you lose 1 life." */
const verdict = (condition: 'exists' | 'notExists') =>
  spell(`Verdict-${condition}`, [
    {
      op: 'if',
      condition: {
        kind: condition,
        filter: {
          kind: 'and',
          filters: [{ kind: 'creature' }, { kind: 'controlledBy', player: 'opponent' }],
        },
      },
      thenDo: [{ op: 'gainLife', player: you, amount: 3 }],
      otherwise: [{ op: 'loseLife', player: you, amount: 1 }],
    },
  ]);

describe('"if … otherwise"', () => {
  it('runs the branch the condition picks as the spell resolves, and only that one', () => {
    const holds = table(verdict('exists'));
    holds.cast('card').resolve();
    expect(holds.lifeOf('A')).toBe(23);

    const fails = table(verdict('notExists'));
    fails.cast('card').resolve();
    expect(fails.lifeOf('A')).toBe(19);
  });
});

describe('what the log says when a spell resolves', () => {
  /**
   * Whether it fizzles is decided as it begins (CR 608.2b). Asking again at the end called
   * every removal spell fizzled, because by then its target is in the graveyard.
   */
  it('a removal spell resolved, and did not fizzle', () => {
    const scenario = table(doom);
    scenario.cast('card', { targets: [scenario.target('ogre')] }).resolve();
    expect(scenario.zoneOf('ogre')).toBe(playerZone('B', 'graveyard'));
    expect(scenario.events()).toContain('resolve');
    expect(scenario.events()).not.toContain('fizzle');
  });
});
