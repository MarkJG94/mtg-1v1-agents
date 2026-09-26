import { asOracleId, type ObjectId } from '@mtg/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { stateFromSeed } from '../rng.js';
import { createGameState, type GameState } from './game-state.js';
import {
  assertStateInvariants,
  checkStateInvariants,
  createObject,
  destroyObject,
  findObject,
  getObject,
  moveObject,
  objectsIn,
  setZone,
  UnknownObjectError,
  updateObject,
  updateObjects,
  updatePlayer,
  updateState,
  zoneSize,
} from './update.js';

const bear = asOracleId('oracle-grizzly-bears');
const bolt = asOracleId('oracle-lightning-bolt');

const emptyState = (): GameState => createGameState({ rng: stateFromSeed('1'), onPlay: 'A' });

/**
 * A state with two cards in A's library — `top` then `bottom` — and one permanent on the
 * battlefield owned by B. Ids come back by name so tests never index into an array, which
 * under `noUncheckedIndexedAccess` would need a non-null assertion at every use.
 */
const stateWithObjects = () => {
  const first = createObject(emptyState(), {
    definitionId: bear,
    owner: 'A',
    zone: 'A:library',
  });
  const second = createObject(first.state, {
    definitionId: bolt,
    owner: 'A',
    zone: 'A:library',
  });
  const onField = createObject(second.state, {
    definitionId: bear,
    owner: 'B',
    zone: 'battlefield',
  });
  const top = first.object.id;
  const bottom = second.object.id;
  return {
    state: onField.state,
    top,
    bottom,
    library: [top, bottom] as readonly ObjectId[],
    field: onField.object.id,
  };
};

describe('updateState', () => {
  it('bumps the version and leaves the original untouched', () => {
    const before = emptyState();
    const after = updateState(before, { turn: 3 });
    expect(after.turn).toBe(3);
    expect(after.version).toBe(before.version + 1);
    expect(before.turn).toBe(0);
  });

  it('shares everything it did not touch', () => {
    const before = stateWithObjects().state;
    const after = updateState(before, { turn: 1 });
    expect(after.objects).toBe(before.objects);
    expect(after.zones).toBe(before.zones);
    expect(after.players).toBe(before.players);
  });
});

describe('createObject', () => {
  it('assigns sequential ids and timestamps', () => {
    const first = createObject(emptyState(), { definitionId: bear, owner: 'A', zone: 'A:hand' });
    const second = createObject(first.state, {
      definitionId: bolt,
      owner: 'A',
      zone: 'A:hand',
    });
    expect(second.object.id).toBe(first.object.id + 1);
    expect(second.object.timestamp).toBeGreaterThan(first.object.timestamp);
    expect(second.state.nextObjectId).toBe(second.object.id + 1);
  });

  it('puts the object in its zone and records the zone on the object', () => {
    const { state, object } = createObject(emptyState(), {
      definitionId: bear,
      owner: 'A',
      zone: 'A:hand',
    });
    expect(objectsIn(state, 'A:hand')).toEqual([object.id]);
    expect(getObject(state, object.id).zone).toBe('A:hand');
    assertStateInvariants(state);
  });

  it('defaults the controller to the owner', () => {
    const { object } = createObject(emptyState(), {
      definitionId: bear,
      owner: 'B',
      zone: 'battlefield',
    });
    expect(object.controller).toBe('B');
  });

  it('honours an explicit controller, for objects that enter under someone else', () => {
    const { object } = createObject(emptyState(), {
      definitionId: bear,
      owner: 'B',
      zone: 'battlefield',
      controller: 'A',
    });
    expect(object.owner).toBe('B');
    expect(object.controller).toBe('A');
  });

  it('starts with no counters, no damage and untapped', () => {
    const { object } = createObject(emptyState(), {
      definitionId: bear,
      owner: 'A',
      zone: 'battlefield',
    });
    expect(object).toMatchObject({
      tapped: false,
      damage: 0,
      counters: {},
      attachedTo: null,
      attachments: [],
      token: false,
      summoningSick: false,
    });
  });

  it('can insert at the top of a library', () => {
    const { state, library } = stateWithObjects();
    const added = createObject(state, {
      definitionId: bolt,
      owner: 'A',
      zone: 'A:library',
      position: 'start',
    });
    expect(objectsIn(added.state, 'A:library')).toEqual([added.object.id, ...library]);
  });
});

describe('getObject and findObject', () => {
  it('finds an object that exists', () => {
    const { state, field } = stateWithObjects();
    expect(getObject(state, field).id).toBe(field);
    expect(findObject(state, field)?.id).toBe(field);
  });

  it('throws or returns undefined for one that does not', () => {
    const state = emptyState();
    const missing = 999 as ObjectId;
    expect(() => getObject(state, missing)).toThrow(UnknownObjectError);
    expect(findObject(state, missing)).toBeUndefined();
  });
});

describe('updateObject', () => {
  it('applies the patch and bumps the version', () => {
    const { state, field } = stateWithObjects();
    const after = updateObject(state, field, { tapped: true, damage: 2 });
    expect(getObject(after, field)).toMatchObject({ tapped: true, damage: 2 });
    expect(after.version).toBe(state.version + 1);
  });

  it('leaves the original state untouched', () => {
    const { state, field } = stateWithObjects();
    updateObject(state, field, { tapped: true });
    expect(getObject(state, field).tapped).toBe(false);
  });

  it('shares objects it did not touch by reference', () => {
    const { state, library, field } = stateWithObjects();
    const after = updateObject(state, field, { tapped: true });
    for (const id of library) {
      expect(getObject(after, id)).toBe(getObject(state, id));
    }
    expect(after.zones).toBe(state.zones);
    expect(after.players).toBe(state.players);
  });

  it('cannot change an object id', () => {
    const { state, field } = stateWithObjects();
    // @ts-expect-error id is stripped from the patch type
    const after = updateObject(state, field, { id: 12345 as ObjectId });
    expect(getObject(after, field).id).toBe(field);
  });

  it('throws for an unknown object', () => {
    expect(() => updateObject(emptyState(), 42 as ObjectId, { tapped: true })).toThrow(
      UnknownObjectError,
    );
  });
});

describe('updateObjects', () => {
  it('patches several objects with one version bump', () => {
    const { state, library } = stateWithObjects();
    const after = updateObjects(
      state,
      library.map((id) => [id, { tapped: true }] as const),
    );
    expect(after.version).toBe(state.version + 1);
    for (const id of library) expect(getObject(after, id).tapped).toBe(true);
  });

  it('is a no-op for an empty patch list, without bumping the version', () => {
    const { state } = stateWithObjects();
    expect(updateObjects(state, [])).toBe(state);
  });

  it('applies nothing if any object is unknown', () => {
    const { state, field } = stateWithObjects();
    expect(() =>
      updateObjects(state, [
        [field, { tapped: true }],
        [999 as ObjectId, { tapped: true }],
      ]),
    ).toThrow(UnknownObjectError);
    expect(getObject(state, field).tapped).toBe(false);
  });
});

describe('moveObject', () => {
  it('moves between zones and keeps object.zone in step', () => {
    const { state, top, library } = stateWithObjects();
    const moved = moveObject(state, top, 'A:hand');
    expect(objectsIn(moved, 'A:hand')).toEqual([library[0]]);
    expect(objectsIn(moved, 'A:library')).toEqual([library[1]]);
    expect(getObject(moved, top).zone).toBe('A:hand');
    assertStateInvariants(moved);
  });

  it('appends to the destination by default', () => {
    const { state, top, library, field } = stateWithObjects();
    const moved = moveObject(state, top, 'battlefield');
    expect(objectsIn(moved, 'battlefield')).toEqual([field, library[0]]);
  });

  it('can insert at a chosen position', () => {
    const { state, top, library, field } = stateWithObjects();
    const moved = moveObject(state, top, 'battlefield', 'start');
    expect(objectsIn(moved, 'battlefield')).toEqual([library[0], field]);
  });

  it('rejects an out-of-range position', () => {
    const { state, top } = stateWithObjects();
    expect(() => moveObject(state, top, 'A:hand', 5)).toThrow(RangeError);
  });

  it('leaves untouched zones shared by reference', () => {
    const { state, top } = stateWithObjects();
    const moved = moveObject(state, top, 'A:hand');
    expect(moved.zones.battlefield).toBe(state.zones.battlefield);
    expect(moved.zones.exile).toBe(state.zones.exile);
  });

  it('keeps the object count constant', () => {
    const { state, top } = stateWithObjects();
    const moved = moveObject(state, top, 'exile');
    expect(moved.objects.size).toBe(state.objects.size);
  });
});

describe('destroyObject', () => {
  it('removes the object from the game and its zone', () => {
    const { state, field } = stateWithObjects();
    const after = destroyObject(state, field);
    expect(findObject(after, field)).toBeUndefined();
    expect(objectsIn(after, 'battlefield')).toEqual([]);
    assertStateInvariants(after);
  });

  it('throws for an unknown object', () => {
    expect(() => destroyObject(emptyState(), 7 as ObjectId)).toThrow(UnknownObjectError);
  });
});

describe('setZone', () => {
  it('reorders a zone, as a shuffle does', () => {
    const { state, library } = stateWithObjects();
    const reversed = [...library].reverse();
    const after = setZone(state, 'A:library', reversed);
    expect(objectsIn(after, 'A:library')).toEqual(reversed);
    assertStateInvariants(after);
  });

  it('refuses anything that is not a permutation', () => {
    const { state, top, library } = stateWithObjects();
    expect(() => setZone(state, 'A:library', [top])).toThrow(RangeError);
    expect(() => setZone(state, 'A:library', [...library, 99 as ObjectId])).toThrow(RangeError);
    expect(() => setZone(state, 'A:library', [top, 99 as ObjectId])).toThrow(RangeError);
  });

  it('refuses a duplicate that keeps the length right', () => {
    // A set-wise check would accept this, duplicating one card and losing the other.
    const { state, top, library } = stateWithObjects();
    expect(() => setZone(state, 'A:library', [top, top])).toThrow(RangeError);
    expect(objectsIn(state, 'A:library')).toEqual(library);
  });
});

describe('updatePlayer', () => {
  it('patches one player and shares the other', () => {
    const state = emptyState();
    const after = updatePlayer(state, 'A', { life: 17 });
    expect(after.players.A.life).toBe(17);
    expect(after.players.B).toBe(state.players.B);
    expect(state.players.A.life).toBe(20);
  });
});

describe('checkStateInvariants', () => {
  let state: GameState;
  let field: ObjectId;

  beforeEach(() => {
    const built = stateWithObjects();
    state = built.state;
    field = built.field;
  });

  it('passes on a well-formed state', () => {
    expect(checkStateInvariants(state)).toEqual([]);
  });

  it('catches an object listed in a zone it does not claim', () => {
    const id = field;
    const broken: GameState = {
      ...state,
      zones: { ...state.zones, battlefield: [], exile: [id] },
    };
    expect(checkStateInvariants(broken)).toContainEqual(
      expect.stringContaining('says it is in battlefield'),
    );
  });

  it('catches an object in two zones at once', () => {
    const id = field;
    const broken: GameState = { ...state, zones: { ...state.zones, exile: [id] } };
    expect(checkStateInvariants(broken)).toContainEqual(expect.stringContaining('is in both'));
  });

  it('catches an object that is in no zone', () => {
    const broken: GameState = {
      ...state,
      zones: { ...state.zones, battlefield: [] },
    };
    expect(checkStateInvariants(broken)).toContainEqual(expect.stringContaining('is in no zone'));
  });

  it('catches a zone holding an object the game has never heard of', () => {
    const broken: GameState = {
      ...state,
      zones: { ...state.zones, exile: [4242 as ObjectId] },
    };
    expect(checkStateInvariants(broken)).toContainEqual(expect.stringContaining('unknown object'));
  });

  it('assertStateInvariants throws with every problem listed', () => {
    const broken: GameState = { ...state, zones: { ...state.zones, battlefield: [] } };
    expect(() => assertStateInvariants(broken)).toThrow(/invariants violated/);
  });
});

describe('zoneSize', () => {
  it('counts a zone without materialising it', () => {
    const { state } = stateWithObjects();
    expect(zoneSize(state, 'A:library')).toBe(2);
    expect(zoneSize(state, 'battlefield')).toBe(1);
    expect(zoneSize(state, 'A:hand')).toBe(0);
  });
});
