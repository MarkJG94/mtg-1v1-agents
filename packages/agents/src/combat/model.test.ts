import type { ObjectId } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { creature, viewOf } from '../test-views.js';
import { type CombatPlan, projectCombat } from './model.js';

/**
 * The combat model (roadmap 4.4): each test is one rule of combat damage, in a fight small
 * enough to work out by hand, so the model and the rule it cites can be read side by side.
 * A is attacking B throughout.
 */

type Creature = ReturnType<typeof creature>;

const fight = (
  mine: readonly Creature[],
  theirs: readonly Creature[],
  blocks: readonly (readonly [Creature, readonly Creature[]])[],
  attacking: readonly Creature[] = mine,
  theirLife = 20,
) => {
  const view = viewOf({ mine, theirs, theirLife });
  const plan: CombatPlan = {
    attacks: attacking.map((attacker) => ({ attacker: attacker.id, defender: 'B' })),
    blocks: new Map(blocks.map(([attacker, blockers]) => [attacker.id, blockers.map((b) => b.id)])),
  };
  return { view, outcome: projectCombat(view, plan) };
};

const dead = (outcome: { died: ReadonlySet<ObjectId> }, ...creatures: Creature[]) =>
  creatures.map((c) => outcome.died.has(c.id));

describe('unblocked and blocked attackers (CR 510.1)', () => {
  it('deals an unblocked attacker’s power to the defending player', () => {
    const bear = creature(2, 2);
    const { outcome } = fight([bear], [], []);
    expect(outcome.damage.B).toBe(2);
    expect(outcome.view.opponent.life).toBe(18);
  });

  it('trades two creatures that kill each other', () => {
    const mine = creature(2, 2);
    const theirs = creature(2, 2);
    const { outcome } = fight([mine], [theirs], [[mine, [theirs]]]);
    expect(dead(outcome, mine, theirs)).toEqual([true, true]);
    expect(outcome.damage.B).toBe(0);
  });

  /** Damage already marked this turn counts toward lethal (CR 704.5g). */
  it('counts damage a creature already has', () => {
    const mine = creature(2, 2);
    const theirs = creature(1, 3, { damage: 1 });
    const { outcome } = fight([mine], [theirs], [[mine, [theirs]]]);
    expect(dead(outcome, theirs)).toEqual([true]);
  });
});

describe('first and double strike (CR 510.4, 702.7, 702.4)', () => {
  it('kills a blocker with first strike before it can strike back', () => {
    const mine = creature(2, 2, { keywords: { firstStrike: true } });
    const theirs = creature(2, 2);
    const { outcome } = fight([mine], [theirs], [[mine, [theirs]]]);
    expect(dead(outcome, mine, theirs)).toEqual([false, true]);
  });

  it('deals double strike’s damage twice', () => {
    const mine = creature(2, 2, { keywords: { doubleStrike: true } });
    const { outcome } = fight([mine], [], []);
    expect(outcome.damage.B).toBe(4);
  });

  /** Blocked, and its blocker gone after first strike: no damage without trample (CR 509.1h). */
  it('deals nothing to the player once its only blocker died in the first-strike step', () => {
    const mine = creature(3, 3, { keywords: { doubleStrike: true } });
    const chump = creature(1, 1);
    const { outcome } = fight([mine], [chump], [[mine, [chump]]]);
    expect(dead(outcome, chump)).toEqual([true]);
    expect(outcome.damage.B).toBe(0);
  });
});

describe('damage assignment among several blockers (CR 510.1c)', () => {
  it('assigns lethal to each blocker in order before the next gets any', () => {
    const mine = creature(4, 6);
    const small = creature(1, 2);
    const big = creature(1, 3);
    const { outcome } = fight([mine], [small, big], [[mine, [small, big]]]);
    // Two to the first is lethal; the remaining two go to the last, which survives.
    expect(dead(outcome, small, big)).toEqual([true, false]);
  });

  it('takes damage from every blocker', () => {
    const mine = creature(4, 3);
    const a = creature(2, 1);
    const b = creature(2, 1);
    const { outcome } = fight([mine], [a, b], [[mine, [a, b]]]);
    expect(dead(outcome, mine, a, b)).toEqual([true, true, true]);
  });
});

describe('trample and deathtouch (CR 702.19, 702.2)', () => {
  it('carries damage past a blocker with trample', () => {
    const mine = creature(5, 5, { keywords: { trample: true } });
    const theirs = creature(2, 2);
    const { outcome } = fight([mine], [theirs], [[mine, [theirs]]]);
    expect(outcome.damage.B).toBe(3);
  });

  it('kills with any damage from a deathtouch creature', () => {
    const mine = creature(1, 1, { keywords: { deathtouch: true } });
    const theirs = creature(5, 5);
    const { outcome } = fight([mine], [theirs], [[mine, [theirs]]]);
    expect(dead(outcome, mine, theirs)).toEqual([true, true]);
  });

  /** With deathtouch, one point is lethal, so trample carries the rest (CR 702.19c). */
  it('tramples over for all but one point with deathtouch', () => {
    const mine = creature(5, 5, { keywords: { trample: true, deathtouch: true } });
    const theirs = creature(4, 4);
    const { outcome } = fight([mine], [theirs], [[mine, [theirs]]]);
    expect(outcome.damage.B).toBe(4);
    expect(dead(outcome, theirs)).toEqual([true]);
  });
});

describe('surviving and gaining (CR 702.12, 702.15)', () => {
  it('does not destroy an indestructible creature', () => {
    const mine = creature(2, 2, { keywords: { indestructible: true } });
    const theirs = creature(5, 5);
    const { outcome } = fight([mine], [theirs], [[mine, [theirs]]]);
    expect(dead(outcome, mine)).toEqual([false]);
  });

  /** The last blocker soaks up everything left (CR 510.1c), and lifelink counts all of it. */
  it('gains life for all the damage the last blocker soaks up', () => {
    const mine = creature(5, 5, { keywords: { lifelink: true } });
    const chump = creature(1, 1);
    const { outcome } = fight([mine], [chump], [[mine, [chump]]]);
    expect(outcome.view.you.life).toBe(25);
  });

  it('gains lifelink’s controller the damage it deals', () => {
    const mine = creature(3, 3, { keywords: { lifelink: true } });
    const { outcome } = fight([mine], [], []);
    expect(outcome.view.you.life).toBe(23);
    expect(outcome.view.opponent.life).toBe(17);
  });
});

describe('the board it leaves', () => {
  it('ends the game when the damage is lethal (CR 704.5a)', () => {
    const mine = creature(5, 5);
    const { outcome } = fight([mine], [], [], [mine], 4);
    expect(outcome.view.result).toEqual({ winner: 'A', reason: 'life', turn: 3 });
  });

  it('taps attackers unless they have vigilance (CR 702.20), and moves the dead', () => {
    const tired = creature(2, 2);
    const alert = creature(2, 2, { keywords: { vigilance: true } });
    const theirs = creature(3, 3);
    const { outcome } = fight([tired, alert], [theirs], [[tired, [theirs]]]);
    expect(outcome.view.objects.get(alert.id)?.tapped).toBe(false);
    expect(outcome.view.you.battlefield).not.toContain(tired.id);
    expect(outcome.view.you.graveyard).toContain(tired.id);
    expect(outcome.view.objects.get(tired.id)?.zone).toBe('A:graveyard');
  });

  it('heals the damage survivors took, as cleanup will (CR 514.2)', () => {
    const mine = creature(1, 1);
    const theirs = creature(3, 3, { damage: 1 });
    const { outcome } = fight([mine], [theirs], [[mine, [theirs]]]);
    expect(outcome.view.objects.get(theirs.id)?.damage).toBe(0);
  });

  it('leaves the view it was given alone', () => {
    const mine = creature(2, 2);
    const theirs = creature(2, 2);
    const { view } = fight([mine], [theirs], [[mine, [theirs]]]);
    expect(view.you.battlefield).toContain(mine.id);
    expect(view.objects.get(mine.id)?.tapped).toBe(false);
    expect(view.opponent.life).toBe(20);
  });
});
