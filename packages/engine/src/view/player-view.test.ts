import { type ObjectId, playerZone } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import type { GameState } from '../state/game-state.js';
import { game } from '../testing/scenario.js';
import { objectsSeenIn, seen } from './player-view.js';
import { viewFor } from './project.js';

/**
 * The player view (docs/04, roadmap 4.1).
 *
 * Almost every case here asserts an **absence**, which is unusual and is the point: the
 * view's job is to withhold things, and a withholding rule that quietly stops applying
 * leaves every other test green. An agent given the opponent's hand does not crash or
 * fail a behaviour test — it simply wins more, for years, without anyone knowing why.
 * So each rule is stated as a test that goes red the moment the information leaks.
 */

const board = () =>
  game({ seed: 'view' })
    .player('A')
    .battlefield({ name: 'bear', power: 2, toughness: 2 })
    .hand({ name: 'mine-1' }, { name: 'mine-2' })
    .graveyard({ name: 'mine-dead' })
    .library(12)
    .life(18)
    .player('B')
    .battlefield({ name: 'wall', power: 0, toughness: 4 })
    .hand({ name: 'theirs-1' }, { name: 'theirs-2' }, { name: 'theirs-3' })
    .graveyard({ name: 'theirs-dead' })
    .library(9)
    .life(11);

describe('what a player is shown', () => {
  it('shows their own hand, and the opponent’s only as a number', () => {
    const scenario = board();
    const view = viewFor(scenario.get(), 'A');

    expect(view.you.hand).toEqual([scenario.ref('mine-1'), scenario.ref('mine-2')]);
    expect(view.you.handSize).toBe(2);
    expect(view.opponent.handSize).toBe(3);

    // The opponent's side has no `hand` at all — not an empty one. A reader looking for
    // it finds nothing rather than something that might be filled in later.
    expect('hand' in view.opponent).toBe(false);
  });

  it('never puts a card in a hidden hand into the objects it can name', () => {
    const scenario = board();
    const view = viewFor(scenario.get(), 'A');

    for (const name of ['theirs-1', 'theirs-2', 'theirs-3']) {
      expect(seen(view, scenario.ref(name))).toBeNull();
    }
    expect(seen(view, scenario.ref('mine-1'))).not.toBeNull();
  });

  /**
   * Nobody knows a library's order, not even its owner (CR 401.2), and knowing the
   * contents is most of knowing the order. A view that showed A their own library would
   * let an agent play as though every draw were already decided.
   */
  it('shows neither library, including the viewer’s own', () => {
    const scenario = board();
    const view = viewFor(scenario.get(), 'A');
    const state = scenario.get();

    expect(view.you.librarySize).toBe(12);
    expect(view.opponent.librarySize).toBe(9);

    const libraries = [
      ...state.zones[playerZone('A', 'library')],
      ...state.zones[playerZone('B', 'library')],
    ];
    expect(libraries.length).toBe(21);
    expect(libraries.filter((id) => view.objects.has(id))).toEqual([]);
  });

  it('shows both graveyards and both battlefields, which are public (CR 400.2)', () => {
    const scenario = board();
    const view = viewFor(scenario.get(), 'A');

    expect(objectsSeenIn(view, view.opponent.graveyard).map((each) => each.name)).toEqual([
      'theirs-dead',
    ]);
    expect(objectsSeenIn(view, view.you.battlefield).map((each) => each.name)).toEqual(['bear']);
    expect(objectsSeenIn(view, view.opponent.battlefield).map((each) => each.name)).toEqual([
      'wall',
    ]);
  });

  it('is the same board from the other seat, with the hidden halves swapped', () => {
    const scenario = board();
    const mine = viewFor(scenario.get(), 'A');
    const theirs = viewFor(scenario.get(), 'B');

    expect(theirs.you.life).toBe(11);
    expect(theirs.opponent.life).toBe(18);
    expect(theirs.you.hand).toHaveLength(3);
    expect(theirs.opponent.handSize).toBe(2);
    expect(seen(theirs, scenario.ref('theirs-1'))).not.toBeNull();
    expect(seen(theirs, scenario.ref('mine-1'))).toBeNull();
    // The battlefield is one shared zone, so both seats see all of it (ADR 0002).
    expect(theirs.battlefield).toEqual(mine.battlefield);
  });
});

/**
 * The test the sabotage checks asked for — twice.
 *
 * Every case above names a field and checks it is absent, which catches a rule that stops
 * applying and misses a rule that never existed: adding a *new* field carrying the
 * opponent's hand left all ten of them green. The first replacement compared two boards
 * whose hidden cards had different names, and a leak of their **ids** walked past that one
 * too, because both boards numbered their objects the same way.
 *
 * So the check is the definition of information hiding rather than a list of places to
 * look: **two states that differ only in what is hidden must produce the same view.** The
 * variant below gives every hidden card a fresh id and a different name, touching nothing
 * visible. Any leak at all — an id, a name, a stray field, something added next year —
 * makes the two views differ, whether or not anybody knew to check for it.
 */
describe('the view is a function of only what is visible', () => {
  const hiddenZones = [
    playerZone('B', 'hand'),
    playerZone('A', 'library'),
    playerZone('B', 'library'),
  ] as const;

  /** The same game with every hidden card renamed and renumbered, and nothing else moved. */
  const reshuffleTheUnseen = (state: GameState): GameState => {
    let objects = state.objects;
    const zones = { ...state.zones };
    let next = state.nextObjectId;

    for (const zone of hiddenZones) {
      const fresh: ObjectId[] = [];
      for (const id of state.zones[zone]) {
        const object = objects.get(id);
        if (object === undefined) continue;
        objects = objects.without(id);
        next += 1;
        const renumbered = next as unknown as ObjectId;
        objects = objects.withObject(renumbered, {
          ...object,
          id: renumbered,
          name: `unseen-${renumbered}`,
        });
        fresh.push(renumbered);
      }
      zones[zone] = fresh;
    }

    return { ...state, objects, zones, nextObjectId: next, version: state.version + 1 };
  };

  it('is identical when only the hidden cards differ', () => {
    const state = board().get();
    const other = reshuffleTheUnseen(state);

    // The two states are genuinely different games underneath.
    expect([...other.objects.keys()]).not.toEqual([...state.objects.keys()]);
    expect(other.zones[playerZone('B', 'hand')]).not.toEqual(state.zones[playerZone('B', 'hand')]);

    expect(viewFor(other, 'A')).toEqual(viewFor(state, 'A'));
  });

  it('shows B the difference that A cannot see, so the check is not vacuous', () => {
    const state = board().get();
    const other = reshuffleTheUnseen(state);

    // Their own hand changed, so their view must change — otherwise the test above would
    // pass on a projection that showed nobody anything at all.
    expect(viewFor(other, 'B')).not.toEqual(viewFor(state, 'B'));
  });

  it('and differs the moment something visible does', () => {
    const state = board().get();
    const damaged = { ...state, players: { ...state.players, B: { ...state.players.B, life: 9 } } };

    expect(viewFor(damaged, 'A')).not.toEqual(viewFor(state, 'A'));
  });
});

describe('what a visible object says about itself', () => {
  /**
   * The view reports what an object *is* (CR 613), not what it was printed as. An agent
   * that evaluated a board from printed power would misjudge every anthem in Magic.
   */
  it('reports current characteristics rather than printed ones', () => {
    const scenario = game({ seed: 'anthem' })
      .player('A')
      .battlefield({ name: 'bear', power: 2, toughness: 2 })
      .effect({
        source: 0 as unknown as ObjectId,
        affects: { kind: 'allCreatures' },
        change: { kind: 'modifyPowerToughness', power: 1, toughness: 1 },
        duration: { kind: 'permanent' },
      });

    const bear = seen(viewFor(scenario.get(), 'A'), scenario.ref('bear'));
    expect(bear?.power).toBe(3);
    expect(bear?.toughness).toBe(3);
  });

  it('reports the controller rather than the owner, because control can change', () => {
    const scenario = game({ seed: 'steal' })
      .player('B')
      .battlefield({ name: 'stolen', power: 1, toughness: 1 })
      .effect({
        source: 0 as unknown as ObjectId,
        affects: { kind: 'allCreatures' },
        change: { kind: 'changeControl', controller: 'A' },
        duration: { kind: 'permanent' },
      });

    const view = viewFor(scenario.get(), 'A');
    const stolen = seen(view, scenario.ref('stolen'));

    expect(stolen?.owner).toBe('B');
    expect(stolen?.controller).toBe('A');
    // And the side battlefields follow control, not ownership (CR 613.1b).
    expect(view.you.battlefield).toContain(scenario.ref('stolen'));
    expect(view.opponent.battlefield).not.toContain(scenario.ref('stolen'));
  });

  it('reports a planeswalker’s loyalty as the counters it has now (CR 306.5b)', () => {
    const scenario = game({ seed: 'walker' })
      .player('A')
      .battlefield({ name: 'walker', loyalty: 4, counters: { loyalty: 2 } })
      .battlefield({ name: 'bear', power: 2, toughness: 2 });

    const view = viewFor(scenario.get(), 'A');
    expect(seen(view, scenario.ref('walker'))?.loyalty).toBe(2);
    expect(seen(view, scenario.ref('bear'))?.loyalty).toBeNull();
  });

  it('carries the per-object rules state an evaluator needs', () => {
    const scenario = game({ seed: 'state' })
      .player('A')
      .battlefield({
        name: 'bear',
        power: 2,
        toughness: 2,
        tapped: true,
        damage: 1,
        summoningSick: true,
        counters: { '+1/+1': 1 },
        keywords: { flying: true },
      });

    const bear = seen(viewFor(scenario.get(), 'A'), scenario.ref('bear'));
    expect(bear?.tapped).toBe(true);
    expect(bear?.damage).toBe(1);
    expect(bear?.summoningSick).toBe(true);
    expect(bear?.counters).toEqual({ '+1/+1': 1 });
    expect(bear?.keywords.flying).toBe(true);
    // A +1/+1 counter is part of what the creature is, so it is already in the numbers.
    expect(bear?.power).toBe(3);
  });

  it('hands back a copy, so an agent cannot write through the view into the game', () => {
    const scenario = board();
    const state = scenario.get();
    const view = viewFor(state, 'A');

    (view.you.hand as ObjectId[]).length = 0;
    (view.battlefield as ObjectId[]).length = 0;

    expect(state.zones[playerZone('A', 'hand')]).toHaveLength(2);
    expect(state.zones.battlefield).toHaveLength(2);
  });
});
