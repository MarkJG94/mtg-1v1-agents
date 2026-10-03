import { describe, expect, it } from 'vitest';
import { afterAction } from './after-action.js';
import { card, cast, creature, land, viewOf } from './test-views.js';

/**
 * `afterAction` — greedy's stand-in for a simulator. It has to move exactly what the
 * action visibly moves, and it must never touch the view it was given: the objects in a
 * view are shared with whoever made it.
 */

describe('playing a land (CR 305.1)', () => {
  it('moves it from the hand to the battlefield and counts the land drop', () => {
    const forest = land({ zone: 'hand' });
    const view = viewOf({ hand: [forest] });

    const after = afterAction(view, { kind: 'playLand', object: forest.id });

    expect(after.you.hand).toEqual([]);
    expect(after.you.handSize).toBe(0);
    expect(after.you.battlefield).toEqual([forest.id]);
    expect(after.battlefield).toEqual([forest.id]);
    expect(after.objects.get(forest.id)?.zone).toBe('battlefield');
    expect(after.you.landsPlayedThisTurn).toBe(1);
  });
});

describe('casting a spell (CR 601.2)', () => {
  it('puts a creature on the battlefield summoning sick (CR 302.6) and taps its mana', () => {
    const bear = creature(2, 2, { zone: 'hand', manaValue: 2 });
    const lands = [land(), land(), land()];
    const view = viewOf({ mine: lands, hand: [bear] });

    const after = afterAction(view, cast(bear.id));

    expect(after.you.battlefield).toContain(bear.id);
    expect(after.objects.get(bear.id)?.summoningSick).toBe(true);
    expect(lands.filter((l) => after.objects.get(l.id)?.tapped)).toHaveLength(2);
    expect(after.you.landsPlayedThisTurn).toBe(0);
  });

  it('taps lands before other mana sources, as the auto-tapper does', () => {
    const elf = creature(1, 1, { producesMana: ['G'] });
    const forest = land();
    const spell = card({ zone: 'hand', types: ['sorcery'], manaValue: 1 });
    const view = viewOf({ mine: [elf, forest], hand: [spell] });

    const after = afterAction(view, cast(spell.id));

    expect(after.objects.get(forest.id)?.tapped).toBe(true);
    expect(after.objects.get(elf.id)?.tapped).toBe(false);
  });

  it('sends an instant or sorcery to the graveyard and does nothing else it cannot see', () => {
    const bolt = card({ zone: 'hand', types: ['instant'], manaValue: 1 });
    const theirs = creature(3, 3);
    const view = viewOf({ mine: [land()], theirs: [theirs], hand: [bolt] });

    const after = afterAction(view, cast(bolt.id));

    expect(after.you.graveyard).toEqual([bolt.id]);
    expect(after.you.battlefield).not.toContain(bolt.id);
    expect(after.opponent).toBe(view.opponent);
  });
});

describe('a loyalty ability (CR 606.4)', () => {
  it('moves the planeswalker’s loyalty by its cost', () => {
    const walker = card({ types: ['planeswalker'], loyalty: 3 });
    const view = viewOf({ mine: [walker] });

    const up = afterAction(view, {
      kind: 'activateLoyalty',
      object: walker.id,
      ability: '+1',
      cost: 1,
    });
    const down = afterAction(view, {
      kind: 'activateLoyalty',
      object: walker.id,
      ability: '-2',
      cost: -2,
    });

    expect(up.objects.get(walker.id)?.loyalty).toBe(4);
    expect(down.objects.get(walker.id)?.loyalty).toBe(1);
  });
});

describe('the view it was given', () => {
  it('is left exactly as it was', () => {
    const bear = creature(2, 2, { zone: 'hand', manaValue: 1 });
    const forest = land();
    const view = viewOf({ mine: [forest], hand: [bear] });
    const objectsBefore = new Map(view.objects);
    const youBefore = view.you;

    afterAction(view, cast(bear.id));

    expect(view.you).toBe(youBefore);
    expect(view.you.hand).toEqual([bear.id]);
    expect(view.objects.get(forest.id)?.tapped).toBe(false);
    expect(new Map(view.objects)).toEqual(objectsBefore);
  });

  it('comes back untouched when the action is to pass', () => {
    const view = viewOf({ mine: [land()] });
    expect(afterAction(view, { kind: 'pass' })).toBe(view);
  });
});
