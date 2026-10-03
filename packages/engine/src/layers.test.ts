import { asOracleId, type ObjectId, type PlayerId } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import {
  activeEffects,
  addEffect,
  characteristicsOf,
  expireEndOfTurnEffects,
  powerOf,
  removeEffect,
  toughnessOf,
} from './characteristics.js';
import type { EffectChange, EffectDuration, EffectSelector } from './layers.js';
import { layerFor, layers } from './layers.js';
import { stateFromSeed } from './rng.js';
import { createGameState, type GameState } from './state/game-state.js';
import { createObject, updateObject } from './state/update.js';
import { keywords } from './targeting.js';

const card = asOracleId('oracle-card');

const build = () => {
  let state: GameState = createGameState({ rng: stateFromSeed('1'), onPlay: 'A' });

  const put = (
    owner: PlayerId,
    spec: {
      power?: number;
      toughness?: number;
      colours?: readonly ('W' | 'U' | 'B' | 'R' | 'G')[];
      flying?: boolean;
    } = {},
  ): ObjectId => {
    const created = createObject(state, {
      definitionId: card,
      owner,
      zone: 'battlefield',
      ...(spec.power !== undefined ? { power: spec.power } : {}),
      ...(spec.toughness !== undefined ? { toughness: spec.toughness } : {}),
      ...(spec.colours !== undefined ? { colours: spec.colours } : {}),
      keywords: keywords(spec.flying ? { flying: true } : {}),
    });
    state = created.state;
    return created.object.id;
  };

  const effect = (
    source: ObjectId,
    change: EffectChange,
    affects: EffectSelector = { kind: 'self' },
    duration: EffectDuration = { kind: 'permanent' },
  ) => {
    const added = addEffect(state, { source, affects, change, duration });
    state = added.state;
    return added.effect;
  };

  return {
    put,
    effect,
    get state() {
      return state;
    },
    set state(next: GameState) {
      state = next;
    },
  };
};

describe('the layer list', () => {
  it('runs from copy to switch, with all five of layer 7’s sublayers (CR 613.4)', () => {
    expect(layers).toEqual([
      '1-copy',
      '2-control',
      '3-text',
      '4-type',
      '5-colour',
      '6-ability',
      '7a-characteristicDefining',
      '7b-set',
      '7c-modify',
      '7d-counters',
      '7e-switch',
    ]);
  });

  it('files each change in its own layer', () => {
    expect(layerFor({ kind: 'changeControl', controller: 'A' })).toBe('2-control');
    expect(layerFor({ kind: 'setColours', colours: ['R'] })).toBe('5-colour');
    expect(layerFor({ kind: 'addKeyword', keyword: 'flying' })).toBe('6-ability');
    expect(layerFor({ kind: 'setPowerToughness', power: 1, toughness: 1 })).toBe('7b-set');
    expect(layerFor({ kind: 'modifyPowerToughness', power: 1, toughness: 1 })).toBe('7c-modify');
    expect(layerFor({ kind: 'switchPowerToughness' })).toBe('7e-switch');
  });
});

describe('printed characteristics with no effects', () => {
  it('are simply what the object says', () => {
    const g = build();
    const id = g.put('A', { power: 2, toughness: 2 });
    expect(characteristicsOf(g.state, id)).toMatchObject({
      power: 2,
      toughness: 2,
      controller: 'A',
      isCreature: true,
    });
  });

  it('treat something with no power as not a creature', () => {
    const g = build();
    const id = g.put('A');
    expect(characteristicsOf(g.state, id).isCreature).toBe(false);
  });
});

describe('layer 7: power and toughness', () => {
  it('applies a modifier', () => {
    const g = build();
    const id = g.put('A', { power: 2, toughness: 2 });
    g.effect(id, { kind: 'modifyPowerToughness', power: 1, toughness: 1 });
    expect([powerOf(g.state, id), toughnessOf(g.state, id)]).toEqual([3, 3]);
  });

  it('sets power and toughness outright', () => {
    const g = build();
    const id = g.put('A', { power: 5, toughness: 5 });
    g.effect(id, { kind: 'setPowerToughness', power: 1, toughness: 1 });
    expect([powerOf(g.state, id), toughnessOf(g.state, id)]).toEqual([1, 1]);
  });

  it('applies setting before modifying, whatever order they were created in', () => {
    // The point of layers: +2/+2 cast first, then "becomes 1/1", still ends up 3/3,
    // because setting is layer 7b and modifying is 7c.
    const g = build();
    const id = g.put('A', { power: 2, toughness: 2 });
    g.effect(id, { kind: 'modifyPowerToughness', power: 2, toughness: 2 });
    g.effect(id, { kind: 'setPowerToughness', power: 1, toughness: 1 });
    expect([powerOf(g.state, id), toughnessOf(g.state, id)]).toEqual([3, 3]);
  });

  it('gets the same answer with the effects created the other way round', () => {
    const g = build();
    const id = g.put('A', { power: 2, toughness: 2 });
    g.effect(id, { kind: 'setPowerToughness', power: 1, toughness: 1 });
    g.effect(id, { kind: 'modifyPowerToughness', power: 2, toughness: 2 });
    expect([powerOf(g.state, id), toughnessOf(g.state, id)]).toEqual([3, 3]);
  });

  it('applies counters in layer 7d, after modifiers', () => {
    const g = build();
    const id = g.put('A', { power: 2, toughness: 2 });
    g.state = updateObject(g.state, id, { counters: { '+1/+1': 2 } });
    g.effect(id, { kind: 'modifyPowerToughness', power: 1, toughness: 1 });
    expect([powerOf(g.state, id), toughnessOf(g.state, id)]).toEqual([5, 5]);
  });

  /**
   * A board with nothing in any layer skips the walk altogether and reads the counters
   * straight off the object (roadmap 4.2), which is most boards for most of a game. The
   * two have to give the same answer, so this pins the one the short cut computes —
   * including a creature whose counters cancel it out entirely (CR 704.5f, 704.5q).
   */
  it('applies counters on a board with no effects at all', () => {
    const g = build();
    const grown = g.put('A', { power: 2, toughness: 2 });
    const shrunk = g.put('A', { power: 2, toughness: 2 });
    const noncreature = g.put('A', {});
    g.state = updateObject(g.state, grown, { counters: { '+1/+1': 3 } });
    g.state = updateObject(g.state, shrunk, { counters: { '-1/-1': 2 } });
    g.state = updateObject(g.state, noncreature, { counters: { '+1/+1': 2 } });

    expect(activeEffects(g.state)).toEqual([]);
    expect([powerOf(g.state, grown), toughnessOf(g.state, grown)]).toEqual([5, 5]);
    expect([powerOf(g.state, shrunk), toughnessOf(g.state, shrunk)]).toEqual([0, 0]);
    // Nothing to add to: a permanent with no printed power is not made into a creature
    // by a counter (CR 613.4d).
    expect(characteristicsOf(g.state, noncreature).isCreature).toBe(false);
  });

  it('counters survive a set effect, because 7d comes after 7b', () => {
    const g = build();
    const id = g.put('A', { power: 4, toughness: 4 });
    g.state = updateObject(g.state, id, { counters: { '+1/+1': 1 } });
    g.effect(id, { kind: 'setPowerToughness', power: 1, toughness: 1 });
    expect([powerOf(g.state, id), toughnessOf(g.state, id)]).toEqual([2, 2]);
  });

  it('switches power and toughness last of all (CR 613.4e)', () => {
    const g = build();
    const id = g.put('A', { power: 1, toughness: 4 });
    g.effect(id, { kind: 'switchPowerToughness' });
    expect([powerOf(g.state, id), toughnessOf(g.state, id)]).toEqual([4, 1]);
  });

  it('switches after modifiers, not before', () => {
    const g = build();
    const id = g.put('A', { power: 1, toughness: 3 });
    g.effect(id, { kind: 'modifyPowerToughness', power: 0, toughness: 1 });
    g.effect(id, { kind: 'switchPowerToughness' });
    // 1/3 becomes 1/4, then switches to 4/1.
    expect([powerOf(g.state, id), toughnessOf(g.state, id)]).toEqual([4, 1]);
  });

  it('breaks ties within a layer by timestamp', () => {
    const g = build();
    const id = g.put('A', { power: 2, toughness: 2 });
    g.effect(id, { kind: 'setPowerToughness', power: 1, toughness: 1 });
    g.effect(id, { kind: 'setPowerToughness', power: 7, toughness: 7 });
    // The later effect wins (CR 613.7).
    expect([powerOf(g.state, id), toughnessOf(g.state, id)]).toEqual([7, 7]);
  });
});

describe('layer 6: abilities', () => {
  it('grants a keyword', () => {
    const g = build();
    const id = g.put('A', { power: 2, toughness: 2 });
    expect(characteristicsOf(g.state, id).keywords.flying).toBe(false);
    g.effect(id, { kind: 'addKeyword', keyword: 'flying' });
    expect(characteristicsOf(g.state, id).keywords.flying).toBe(true);
  });

  it('removes every ability, as Humility does', () => {
    const g = build();
    const id = g.put('A', { power: 2, toughness: 2, flying: true });
    g.effect(id, { kind: 'removeAllAbilities' });
    expect(characteristicsOf(g.state, id).keywords.flying).toBe(false);
  });

  it('a keyword granted later in the same layer survives an earlier removal', () => {
    const g = build();
    const id = g.put('A', { power: 2, toughness: 2, flying: true });
    g.effect(id, { kind: 'removeAllAbilities' });
    g.effect(id, { kind: 'addKeyword', keyword: 'trample' });
    const traits = characteristicsOf(g.state, id);
    expect(traits.keywords.flying).toBe(false);
    expect(traits.keywords.trample).toBe(true);
  });
});

describe('layer 5: colour, and layer 2: control', () => {
  it('changes colours', () => {
    const g = build();
    const id = g.put('A', { power: 2, toughness: 2, colours: ['G'] });
    g.effect(id, { kind: 'setColours', colours: ['U'] });
    expect(characteristicsOf(g.state, id).colours).toEqual(['U']);
  });

  it('changes control without moving the object between zones (ADR 0002)', () => {
    const g = build();
    const id = g.put('B', { power: 2, toughness: 2 });
    g.effect(id, { kind: 'changeControl', controller: 'A' });

    expect(characteristicsOf(g.state, id).controller).toBe('A');
    // Owner is untouched, and it never left the battlefield.
    expect(g.state.objects.get(id)?.owner).toBe('B');
    expect(g.state.zones.battlefield).toContain(id);
  });
});

describe('layer 4: becoming a creature', () => {
  it('turns a non-creature permanent into one', () => {
    const g = build();
    const id = g.put('A');
    expect(characteristicsOf(g.state, id).isCreature).toBe(false);

    g.effect(id, { kind: 'becomesCreature', power: 4, toughness: 4 });
    expect(characteristicsOf(g.state, id)).toMatchObject({
      isCreature: true,
      power: 4,
      toughness: 4,
    });
  });

  it('and a later pump still applies on top', () => {
    const g = build();
    const id = g.put('A');
    g.effect(id, { kind: 'becomesCreature', power: 4, toughness: 4 });
    g.effect(id, { kind: 'modifyPowerToughness', power: 1, toughness: 1 });
    expect([powerOf(g.state, id), toughnessOf(g.state, id)]).toEqual([5, 5]);
  });
});

describe('who an effect applies to', () => {
  it('all creatures, as an anthem does', () => {
    const g = build();
    const source = g.put('A');
    const mine = g.put('A', { power: 2, toughness: 2 });
    const theirs = g.put('B', { power: 2, toughness: 2 });
    g.effect(
      source,
      { kind: 'modifyPowerToughness', power: 1, toughness: 1 },
      { kind: 'allCreatures' },
    );

    expect(powerOf(g.state, mine)).toBe(3);
    expect(powerOf(g.state, theirs)).toBe(3);
  });

  it('only the source controller’s creatures', () => {
    const g = build();
    const source = g.put('A');
    const mine = g.put('A', { power: 2, toughness: 2 });
    const theirs = g.put('B', { power: 2, toughness: 2 });
    g.effect(
      source,
      { kind: 'modifyPowerToughness', power: 1, toughness: 1 },
      { kind: 'creaturesControlledBy', player: 'sourceController' },
    );

    expect(powerOf(g.state, mine)).toBe(3);
    expect(powerOf(g.state, theirs)).toBe(2);
  });

  it('does not pump a non-creature under an all-creatures effect', () => {
    const g = build();
    const source = g.put('A');
    const artifact = g.put('A');
    g.effect(
      source,
      { kind: 'modifyPowerToughness', power: 1, toughness: 1 },
      { kind: 'allCreatures' },
    );
    expect(characteristicsOf(g.state, artifact).isCreature).toBe(false);
  });

  it('follows the source’s controller when control of the source changes', () => {
    const g = build();
    const source = g.put('A');
    const mine = g.put('A', { power: 2, toughness: 2 });
    g.effect(
      source,
      { kind: 'modifyPowerToughness', power: 1, toughness: 1 },
      { kind: 'creaturesControlledBy', player: 'sourceController' },
    );
    expect(powerOf(g.state, mine)).toBe(3);

    // The anthem changes hands; it now pumps the other player's creatures.
    g.state = updateObject(g.state, source, { controller: 'B' });
    expect(powerOf(g.state, mine)).toBe(2);
  });
});

describe('duration', () => {
  it('an until-end-of-turn effect goes away in cleanup', () => {
    const g = build();
    const id = g.put('A', { power: 2, toughness: 2 });
    g.effect(
      id,
      { kind: 'modifyPowerToughness', power: 3, toughness: 3 },
      { kind: 'self' },
      {
        kind: 'untilEndOfTurn',
      },
    );
    expect(powerOf(g.state, id)).toBe(5);

    const afterCleanup = expireEndOfTurnEffects(g.state);
    expect(powerOf(afterCleanup, id)).toBe(2);
  });

  it('a permanent effect survives cleanup', () => {
    const g = build();
    const id = g.put('A', { power: 2, toughness: 2 });
    g.effect(id, { kind: 'modifyPowerToughness', power: 3, toughness: 3 });
    expect(powerOf(expireEndOfTurnEffects(g.state), id)).toBe(5);
  });

  it('an effect tied to its source stops applying when the source leaves', () => {
    const g = build();
    const source = g.put('A');
    const creature = g.put('A', { power: 2, toughness: 2 });
    g.effect(
      source,
      { kind: 'modifyPowerToughness', power: 1, toughness: 1 },
      { kind: 'allCreatures' },
      { kind: 'whileSourceOnBattlefield' },
    );
    expect(powerOf(g.state, creature)).toBe(3);

    g.state = updateObject(g.state, source, { zone: 'A:graveyard' });
    expect(powerOf(g.state, creature)).toBe(2);
  });

  it('an effect can be removed outright', () => {
    const g = build();
    const id = g.put('A', { power: 2, toughness: 2 });
    const effect = g.effect(id, { kind: 'modifyPowerToughness', power: 3, toughness: 3 });
    expect(powerOf(removeEffect(g.state, effect.id), id)).toBe(2);
  });
});

describe('memoisation', () => {
  it('returns the same computed object for the same state', () => {
    const g = build();
    const id = g.put('A', { power: 2, toughness: 2 });
    expect(characteristicsOf(g.state, id)).toBe(characteristicsOf(g.state, id));
  });

  it('recomputes once the state changes', () => {
    const g = build();
    const id = g.put('A', { power: 2, toughness: 2 });
    const before = characteristicsOf(g.state, id);
    g.effect(id, { kind: 'modifyPowerToughness', power: 1, toughness: 1 });
    expect(characteristicsOf(g.state, id)).not.toBe(before);
    expect(powerOf(g.state, id)).toBe(3);
  });
});

describe('dependency within a layer (CR 613.8)', () => {
  it('applies the effect another depends on first, even with a later timestamp', () => {
    // The Opalescence shape. Effect A is created first and says "all creatures become
    // 4/4". Effect B is created second and makes one non-creature permanent a 1/1
    // creature. In plain timestamp order A would run while the permanent is not yet a
    // creature, miss it, and leave it a 1/1. A depends on B, so B goes first and the
    // permanent ends up 4/4.
    const g = build();
    const source = g.put('A');
    const permanent = g.put('A');
    expect(characteristicsOf(g.state, permanent).isCreature).toBe(false);

    g.effect(source, { kind: 'becomesCreature', power: 4, toughness: 4 }, { kind: 'allCreatures' });
    g.effect(
      source,
      { kind: 'becomesCreature', power: 1, toughness: 1 },
      { kind: 'object', object: permanent },
    );

    expect([powerOf(g.state, permanent), toughnessOf(g.state, permanent)]).toEqual([4, 4]);
  });

  it('still uses timestamp order when neither effect depends on the other', () => {
    const g = build();
    const id = g.put('A', { power: 2, toughness: 2 });
    g.effect(id, { kind: 'setPowerToughness', power: 1, toughness: 1 });
    g.effect(id, { kind: 'setPowerToughness', power: 6, toughness: 6 });
    expect([powerOf(g.state, id), toughnessOf(g.state, id)]).toEqual([6, 6]);
  });

  it('a creature already in play is unaffected by the dependency, just pumped', () => {
    const g = build();
    const source = g.put('A');
    const creature = g.put('A', { power: 2, toughness: 2 });
    g.effect(source, { kind: 'becomesCreature', power: 4, toughness: 4 }, { kind: 'allCreatures' });
    expect([powerOf(g.state, creature), toughnessOf(g.state, creature)]).toEqual([4, 4]);
  });

  it('an effect that does not apply cannot be depended on', () => {
    // B only touches a different object, so A's applicability never changes and plain
    // timestamp order stands.
    const g = build();
    const source = g.put('A');
    const mine = g.put('A', { power: 2, toughness: 2 });
    const other = g.put('B');

    g.effect(mine, { kind: 'setPowerToughness', power: 3, toughness: 3 });
    g.effect(
      source,
      { kind: 'becomesCreature', power: 9, toughness: 9 },
      {
        kind: 'object',
        object: other,
      },
    );
    expect([powerOf(g.state, mine), toughnessOf(g.state, mine)]).toEqual([3, 3]);
  });

  it('removal then granting in layer 6 still follows timestamps', () => {
    // Neither changes what the other applies to, so no dependency is involved.
    const g = build();
    const id = g.put('A', { power: 2, toughness: 2, flying: true });
    g.effect(id, { kind: 'removeAllAbilities' }, { kind: 'allCreatures' });
    g.effect(id, { kind: 'addKeyword', keyword: 'trample' }, { kind: 'allCreatures' });

    const traits = characteristicsOf(g.state, id);
    expect(traits.keywords.flying).toBe(false);
    expect(traits.keywords.trample).toBe(true);
  });

  it('terminates and applies everything with many interacting effects', () => {
    const g = build();
    const source = g.put('A');
    const permanent = g.put('A');

    g.effect(source, { kind: 'becomesCreature', power: 2, toughness: 2 }, { kind: 'allCreatures' });
    g.effect(
      source,
      { kind: 'becomesCreature', power: 1, toughness: 1 },
      {
        kind: 'object',
        object: permanent,
      },
    );
    g.effect(
      source,
      { kind: 'modifyPowerToughness', power: 1, toughness: 1 },
      {
        kind: 'allCreatures',
      },
    );
    g.effect(source, { kind: 'addKeyword', keyword: 'flying' }, { kind: 'allCreatures' });

    const traits = characteristicsOf(g.state, permanent);
    // Became a creature, caught the "all creatures" set, then the pump and the keyword.
    expect([traits.power, traits.toughness]).toEqual([3, 3]);
    expect(traits.keywords.flying).toBe(true);
  });

  it('gives the same answer every time, so a replay matches', () => {
    const g = build();
    const source = g.put('A');
    const permanent = g.put('A');
    g.effect(source, { kind: 'becomesCreature', power: 4, toughness: 4 }, { kind: 'allCreatures' });
    g.effect(
      source,
      { kind: 'becomesCreature', power: 1, toughness: 1 },
      {
        kind: 'object',
        object: permanent,
      },
    );

    const first = characteristicsOf(g.state, permanent);
    // A fresh state with the same effects computes the same thing.
    const again = characteristicsOf({ ...g.state, version: g.state.version + 1 }, permanent);
    expect(again).toEqual(first);
  });
});
