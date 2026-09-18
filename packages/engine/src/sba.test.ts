import { asOracleId, type ObjectId, type PlayerId, playerZone } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { addEffect } from './characteristics.js';
import { createEventEmitter, type EventEmitter } from './events/emitter.js';
import { stateFromSeed } from './rng.js';
import { applyLegendRule, checkStateBasedActions, legendGroups } from './sba.js';
import { createGameState, type GameState } from './state/game-state.js';
import { withCounters } from './state/object.js';
import {
  createObject,
  findObject,
  getObject,
  objectsIn,
  updateObject,
  updatePlayer,
} from './state/update.js';
import { keywords } from './targeting.js';

const card = asOracleId('oracle-card');

interface Spec {
  readonly power?: number;
  readonly toughness?: number;
  readonly loyalty?: number;
  readonly name?: string;
  readonly legendary?: boolean;
  readonly attachment?: 'aura' | 'equipment';
  readonly token?: boolean;
  readonly indestructible?: boolean;
  readonly damage?: number;
  readonly deathtouched?: boolean;
  readonly counters?: Readonly<Record<string, number>>;
  readonly attachedTo?: ObjectId | null;
  readonly zone?: 'battlefield' | 'A:graveyard';
}

const build = () => {
  let state: GameState = createGameState({ rng: stateFromSeed('1'), onPlay: 'A' });
  const emitter = createEventEmitter();

  const put = (owner: PlayerId, spec: Spec): ObjectId => {
    const created = createObject(state, {
      definitionId: card,
      owner,
      zone: spec.zone ?? 'battlefield',
      ...(spec.power !== undefined ? { power: spec.power } : {}),
      ...(spec.toughness !== undefined ? { toughness: spec.toughness } : {}),
      ...(spec.loyalty !== undefined ? { loyalty: spec.loyalty } : {}),
      ...(spec.name !== undefined ? { name: spec.name } : {}),
      ...(spec.legendary !== undefined ? { legendary: spec.legendary } : {}),
      ...(spec.attachment !== undefined ? { attachment: spec.attachment } : {}),
      ...(spec.token !== undefined ? { token: spec.token } : {}),
      keywords: keywords(spec.indestructible ? { indestructible: true } : {}),
    });
    state = created.state;

    let object = created.object;
    for (const [kind, count] of Object.entries(spec.counters ?? {})) {
      object = withCounters(object, kind, count);
    }
    state = updateObject(state, created.object.id, {
      damage: spec.damage ?? 0,
      deathtouched: spec.deathtouched ?? false,
      counters: object.counters,
      ...(spec.attachedTo !== undefined ? { attachedTo: spec.attachedTo } : {}),
    });
    return created.object.id;
  };

  return {
    put,
    get state() {
      return state;
    },
    set state(next: GameState) {
      state = next;
    },
    emitter,
  };
};

const check = (state: GameState, emitter: EventEmitter): GameState =>
  checkStateBasedActions(state, emitter);

describe('a player losing (CR 704.5a-c)', () => {
  it('loses at zero life', () => {
    const g = build();
    const after = check(updatePlayer(g.state, 'B', { life: 0 }), g.emitter);
    expect(after.result).toEqual({ winner: 'A', reason: 'life', turn: 0 });
  });

  it('loses at negative life', () => {
    const g = build();
    expect(check(updatePlayer(g.state, 'A', { life: -3 }), g.emitter).result?.winner).toBe('B');
  });

  it('loses after trying to draw from an empty library (CR 704.5b)', () => {
    const g = build();
    const after = check(updatePlayer(g.state, 'A', { drewFromEmptyLibrary: true }), g.emitter);
    expect(after.result).toMatchObject({ winner: 'B', reason: 'decked' });
  });

  it('loses at ten poison counters (CR 704.5c)', () => {
    const g = build();
    const after = check(updatePlayer(g.state, 'B', { poison: 10 }), g.emitter);
    expect(after.result).toMatchObject({ winner: 'A', reason: 'poison' });
  });

  it('survives at nine poison', () => {
    const g = build();
    expect(check(updatePlayer(g.state, 'B', { poison: 9 }), g.emitter).result).toBeNull();
  });

  it('is a draw when both players lose at once (CR 104.4b)', () => {
    const g = build();
    let state = updatePlayer(g.state, 'A', { life: 0 });
    state = updatePlayer(state, 'B', { life: 0 });
    expect(check(state, g.emitter).result).toMatchObject({ winner: null });
  });

  it('emits a gameEnd event', () => {
    const g = build();
    check(updatePlayer(g.state, 'B', { life: 0 }), g.emitter);
    expect(g.emitter.events.some((event) => event.type === 'gameEnd')).toBe(true);
  });
});

describe('creatures dying (CR 704.5f-h)', () => {
  it('destroys a creature with lethal damage', () => {
    const g = build();
    const id = g.put('A', { power: 2, toughness: 2, damage: 2 });
    const after = check(g.state, g.emitter);
    expect(objectsIn(after, playerZone('A', 'graveyard'))).toEqual([id]);
  });

  it('leaves a creature with survivable damage alone', () => {
    const g = build();
    const id = g.put('A', { power: 2, toughness: 3, damage: 2 });
    expect(objectsIn(check(g.state, g.emitter), 'battlefield')).toEqual([id]);
  });

  it('puts a creature with zero toughness into the graveyard (CR 704.5f)', () => {
    const g = build();
    const id = g.put('A', { power: 1, toughness: 1, counters: { '-1/-1': 1 } });
    expect(objectsIn(check(g.state, g.emitter), playerZone('A', 'graveyard'))).toEqual([id]);
  });

  it('destroys a creature dealt any damage by a deathtouch source (CR 702.2b)', () => {
    const g = build();
    const id = g.put('A', { power: 4, toughness: 4, damage: 1, deathtouched: true });
    expect(objectsIn(check(g.state, g.emitter), playerZone('A', 'graveyard'))).toEqual([id]);
  });

  it('spares an indestructible creature from lethal damage', () => {
    const g = build();
    const id = g.put('A', { power: 2, toughness: 2, damage: 5, indestructible: true });
    expect(objectsIn(check(g.state, g.emitter), 'battlefield')).toEqual([id]);
  });

  it('spares an indestructible creature from deathtouch', () => {
    const g = build();
    const id = g.put('A', {
      power: 2,
      toughness: 2,
      damage: 1,
      deathtouched: true,
      indestructible: true,
    });
    expect(objectsIn(check(g.state, g.emitter), 'battlefield')).toEqual([id]);
  });

  it('does not spare an indestructible creature from zero toughness', () => {
    // Zero toughness is not destruction, so indestructible does not apply (CR 704.5f).
    const g = build();
    const id = g.put('A', {
      power: 1,
      toughness: 1,
      indestructible: true,
      counters: { '-1/-1': 2 },
    });
    expect(objectsIn(check(g.state, g.emitter), playerZone('A', 'graveyard'))).toEqual([id]);
  });

  it('counts +1/+1 counters toward surviving damage', () => {
    const g = build();
    const id = g.put('A', { power: 2, toughness: 2, damage: 2, counters: { '+1/+1': 1 } });
    expect(objectsIn(check(g.state, g.emitter), 'battlefield')).toEqual([id]);
  });

  it('kills two creatures that dealt each other lethal damage, together', () => {
    const g = build();
    const first = g.put('A', { power: 2, toughness: 2, damage: 2 });
    const second = g.put('B', { power: 2, toughness: 2, damage: 2 });
    const after = check(g.state, g.emitter);
    expect(objectsIn(after, 'battlefield')).toEqual([]);
    expect(objectsIn(after, playerZone('A', 'graveyard'))).toEqual([first]);
    expect(objectsIn(after, playerZone('B', 'graveyard'))).toEqual([second]);
  });

  it('emits an sba event naming the rule', () => {
    const g = build();
    g.put('A', { power: 2, toughness: 2, damage: 2 });
    check(g.state, g.emitter);
    expect(
      g.emitter.events.some((e) => e.type === 'sba' && e.kind === 'creatureLethalDamage'),
    ).toBe(true);
  });
});

describe('counters cancelling out (CR 704.5q)', () => {
  it('annihilates matched +1/+1 and -1/-1 counters', () => {
    const g = build();
    const id = g.put('A', { power: 2, toughness: 2, counters: { '+1/+1': 3, '-1/-1': 2 } });
    const after = check(g.state, g.emitter);
    expect(getObject(after, id).counters).toEqual({ '+1/+1': 1 });
  });

  it('removes both kinds when they are equal', () => {
    const g = build();
    const id = g.put('A', { power: 2, toughness: 2, counters: { '+1/+1': 2, '-1/-1': 2 } });
    expect(getObject(check(g.state, g.emitter), id).counters).toEqual({});
  });

  it('leaves other counter kinds untouched', () => {
    const g = build();
    const id = g.put('A', {
      power: 2,
      toughness: 2,
      counters: { '+1/+1': 1, '-1/-1': 1, charge: 3 },
    });
    expect(getObject(check(g.state, g.emitter), id).counters).toEqual({ charge: 3 });
  });
});

describe('tokens (CR 704.5e)', () => {
  it('a token that has left the battlefield ceases to exist', () => {
    const g = build();
    const id = g.put('A', { power: 1, toughness: 1, token: true, zone: 'A:graveyard' });
    expect(findObject(check(g.state, g.emitter), id)).toBeUndefined();
  });

  it('a token on the battlefield is left alone', () => {
    const g = build();
    const id = g.put('A', { power: 1, toughness: 1, token: true });
    expect(findObject(check(g.state, g.emitter), id)).toBeDefined();
  });

  it('a dying token goes to the graveyard and then vanishes', () => {
    const g = build();
    const id = g.put('A', { power: 1, toughness: 1, token: true, damage: 5 });
    const after = check(g.state, g.emitter);
    expect(findObject(after, id)).toBeUndefined();
    expect(objectsIn(after, playerZone('A', 'graveyard'))).toEqual([]);
  });

  it('a non-token card in the graveyard stays there', () => {
    const g = build();
    const id = g.put('A', { power: 1, toughness: 1, zone: 'A:graveyard' });
    expect(findObject(check(g.state, g.emitter), id)).toBeDefined();
  });
});

describe('planeswalkers (CR 704.5i)', () => {
  it('goes to the graveyard with no loyalty counters', () => {
    const g = build();
    const id = g.put('A', { loyalty: 3 });
    expect(objectsIn(check(g.state, g.emitter), playerZone('A', 'graveyard'))).toEqual([id]);
  });

  it('survives while it has loyalty', () => {
    const g = build();
    const id = g.put('A', { loyalty: 3, counters: { loyalty: 3 } });
    expect(objectsIn(check(g.state, g.emitter), 'battlefield')).toEqual([id]);
  });
});

describe('auras and equipment (CR 704.5m, 704.5n)', () => {
  it('an aura attached to nothing goes to the graveyard', () => {
    const g = build();
    const id = g.put('A', { attachment: 'aura', attachedTo: null });
    expect(objectsIn(check(g.state, g.emitter), playerZone('A', 'graveyard'))).toEqual([id]);
  });

  it('an aura attached to something on the battlefield survives', () => {
    const g = build();
    const creature = g.put('A', { power: 2, toughness: 2 });
    const aura = g.put('A', { attachment: 'aura', attachedTo: creature });
    expect(objectsIn(check(g.state, g.emitter), 'battlefield')).toEqual([creature, aura]);
  });

  it('an aura falls off and dies when its host leaves', () => {
    const g = build();
    const creature = g.put('A', { power: 2, toughness: 2, damage: 5 });
    const aura = g.put('A', { attachment: 'aura', attachedTo: creature });
    const after = check(g.state, g.emitter);
    expect(objectsIn(after, 'battlefield')).toEqual([]);
    expect(objectsIn(after, playerZone('A', 'graveyard'))).toEqual([creature, aura]);
  });

  it('equipment merely unattaches rather than dying', () => {
    const g = build();
    const creature = g.put('A', { power: 2, toughness: 2, damage: 5 });
    const equipment = g.put('A', { attachment: 'equipment', attachedTo: creature });
    const after = check(g.state, g.emitter);
    expect(objectsIn(after, 'battlefield')).toEqual([equipment]);
    expect(getObject(after, equipment).attachedTo).toBeNull();
  });
});

describe('the legend rule (CR 704.5j)', () => {
  const twoLegends = () => {
    const g = build();
    const first = g.put('A', { power: 2, toughness: 2, name: 'Jace', legendary: true });
    const second = g.put('A', { power: 2, toughness: 2, name: 'Jace', legendary: true });
    return { g, first, second };
  };

  it('spots two legends with the same name under one controller', () => {
    const { g, first, second } = twoLegends();
    expect(legendGroups(g.state)).toEqual([
      { player: 'A', name: 'Jace', objects: [first, second] },
    ]);
  });

  it('ignores the same name under different controllers', () => {
    const g = build();
    g.put('A', { power: 2, toughness: 2, name: 'Jace', legendary: true });
    g.put('B', { power: 2, toughness: 2, name: 'Jace', legendary: true });
    expect(legendGroups(g.state)).toEqual([]);
  });

  it('ignores non-legendary permanents with the same name', () => {
    const g = build();
    g.put('A', { power: 2, toughness: 2, name: 'Bear' });
    g.put('A', { power: 2, toughness: 2, name: 'Bear' });
    expect(legendGroups(g.state)).toEqual([]);
  });

  it('asks the controller which to keep rather than deciding', () => {
    const { g, first, second } = twoLegends();
    const after = check(g.state, g.emitter);
    expect(after.pendingDecision).toEqual({
      kind: 'chooseOption',
      player: 'A',
      reason: 'legendRule',
      options: [first, second],
    });
  });

  it('keeps the chosen one and buries the rest', () => {
    const { g, first, second } = twoLegends();
    const after = applyLegendRule(g.state, g.emitter, [first, second], first);
    expect(objectsIn(after, 'battlefield')).toEqual([first]);
    expect(objectsIn(after, playerZone('A', 'graveyard'))).toEqual([second]);
  });

  it('refuses a choice that is not among the options', () => {
    const { g, first, second } = twoLegends();
    expect(() => applyLegendRule(g.state, g.emitter, [first, second], 999 as ObjectId)).toThrow();
  });
});

describe('repeating until nothing applies (CR 704.3)', () => {
  it('kills a creature, then the aura that was on it, in one check', () => {
    const g = build();
    const creature = g.put('A', { power: 1, toughness: 1, damage: 1 });
    const aura = g.put('A', { attachment: 'aura', attachedTo: creature });
    const after = check(g.state, g.emitter);
    expect(objectsIn(after, 'battlefield')).toEqual([]);
    expect(objectsIn(after, playerZone('A', 'graveyard'))).toEqual([creature, aura]);
  });

  it('returns the state untouched when nothing applies', () => {
    const g = build();
    g.put('A', { power: 2, toughness: 2 });
    const before = g.state;
    expect(check(before, g.emitter)).toBe(before);
  });
});

/**
 * The settled-board memo (roadmap 4.2).
 *
 * A sweep that finds nothing is remembered against the four things it read, so the next
 * one over the same board can be skipped — which is most of them, because passing
 * priority and storing a decision change nothing a state-based action looks at. The
 * danger is the opposite of a slow engine: a board remembered as settled that has since
 * stopped being settled is a creature that should be dead and is not, and no test of the
 * rules themselves would notice, because the rules are right and never asked.
 *
 * So each of these settles a board first — which is what puts it in the memo — and then
 * changes exactly one of the four and checks the sweep still runs.
 */
describe('a board remembered as settled is re-checked when it changes', () => {
  /** Sweep once so the board is remembered, and hand back a state that is unchanged. */
  const settle = (g: ReturnType<typeof build>): GameState => {
    const before = g.state;
    expect(check(before, g.emitter)).toBe(before);
    return before;
  };

  it('still sees a player who has since lost, with every object the same', () => {
    const g = build();
    g.put('A', { power: 2, toughness: 2 });
    const settled = settle(g);

    // `updatePlayer` rewrites the players record and shares everything else, so this is
    // the same object table and the same zones as the board just found clean.
    const dying = updatePlayer(settled, 'B', { life: 0 });
    expect(dying.objects).toBe(settled.objects);
    expect(dying.zones).toBe(settled.zones);

    expect(check(dying, g.emitter).result).toMatchObject({ winner: 'A', reason: 'life' });
  });

  it('still sees a creature that has since taken lethal damage', () => {
    const g = build();
    const creature = g.put('A', { power: 2, toughness: 2 });
    const settled = settle(g);

    const damaged = updateObject(settled, creature, { damage: 2 });
    expect(objectsIn(check(damaged, g.emitter), 'battlefield')).toEqual([]);
  });

  /**
   * An effect is the case the object table cannot see: nothing about the creature changes,
   * and it dies because something else on the board now says it is a 0/0 (CR 704.5f).
   */
  it('still sees a creature an effect has since shrunk to nothing', () => {
    const g = build();
    const creature = g.put('A', { power: 2, toughness: 2 });
    const settled = settle(g);

    const shrunk = addEffect(settled, {
      source: creature,
      affects: { kind: 'allCreatures' },
      change: { kind: 'modifyPowerToughness', power: -2, toughness: -2 },
      duration: { kind: 'untilEndOfTurn' },
    }).state;
    expect(shrunk.objects).toBe(settled.objects);

    expect(objectsIn(check(shrunk, g.emitter), 'battlefield')).toEqual([]);
  });

  /** And the memo has to be doing something: an unchanged board is answered from it. */
  it('answers an unchanged board without sweeping it again', () => {
    const g = build();
    g.put('A', { power: 2, toughness: 2 });
    const settled = settle(g);
    expect(check(settled, g.emitter)).toBe(settled);
  });
});
