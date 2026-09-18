import { asOracleId, type ObjectId } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { createEventEmitter, type EventEmitter } from '../events/emitter.js';
import { stateFromSeed } from '../rng.js';
import { createGameState, type GameState } from '../state/game-state.js';
import { createObject, getObject, updateObject } from '../state/update.js';
import {
  activateManaAbility,
  basicLandAbility,
  canActivateManaAbility,
  IllegalManaAbilityError,
  type ManaAbility,
} from './ability.js';
import { manaPoolCounts, manaPoolSize } from './pool.js';

const land = asOracleId('oracle-forest');

const withPermanent = (
  controller: 'A' | 'B' = 'A',
  zone: 'battlefield' | 'A:hand' = 'battlefield',
): { state: GameState; emitter: EventEmitter; id: ObjectId } => {
  const base = createGameState({ rng: stateFromSeed('1'), onPlay: 'A' });
  const created = createObject(base, { definitionId: land, owner: controller, zone });
  return { state: created.state, emitter: createEventEmitter(), id: created.object.id };
};

describe('canActivateManaAbility', () => {
  it('allows an untapped permanent its controller owns', () => {
    const { state, id } = withPermanent();
    expect(canActivateManaAbility(state, 'A', basicLandAbility(id, 'G'))).toBe(true);
  });

  it('refuses a permanent someone else controls', () => {
    const { state, id } = withPermanent('B');
    expect(canActivateManaAbility(state, 'A', basicLandAbility(id, 'G'))).toBe(false);
  });

  it('refuses a card that is not on the battlefield', () => {
    const { state, id } = withPermanent('A', 'A:hand');
    expect(canActivateManaAbility(state, 'A', basicLandAbility(id, 'G'))).toBe(false);
  });

  it('refuses a tapped permanent when the ability needs {T}', () => {
    const { state, id } = withPermanent();
    const tapped = updateObject(state, id, { tapped: true });
    expect(canActivateManaAbility(tapped, 'A', basicLandAbility(id, 'G'))).toBe(false);
  });

  it('allows a tapped permanent when the ability does not need {T}', () => {
    const { state, id } = withPermanent();
    const tapped = updateObject(state, id, { tapped: true });
    const ability: ManaAbility = {
      source: id,
      requiresTap: false,
      modes: [[{ type: 'B', amount: 3 }]],
    };
    expect(canActivateManaAbility(tapped, 'A', ability)).toBe(true);
  });

  it('refuses an object the game has never heard of', () => {
    const { state } = withPermanent();
    expect(canActivateManaAbility(state, 'A', basicLandAbility(999 as ObjectId, 'G'))).toBe(false);
  });

  it('refuses once the game is over', () => {
    const { state, id } = withPermanent();
    const over = { ...state, result: { winner: null, reason: 'turnCap' as const, turn: 1 } };
    expect(canActivateManaAbility(over, 'A', basicLandAbility(id, 'G'))).toBe(false);
  });
});

describe('activateManaAbility', () => {
  it('adds the mana to the pool immediately, without using the stack (CR 605.3b)', () => {
    const { state, emitter, id } = withPermanent();
    const after = activateManaAbility(state, emitter, 'A', basicLandAbility(id, 'G'));
    expect(manaPoolCounts(after.players.A.manaPool)).toMatchObject({ G: 1 });
    expect(after.zones.stack).toEqual([]);
  });

  it('taps the source', () => {
    const { state, emitter, id } = withPermanent();
    const after = activateManaAbility(state, emitter, 'A', basicLandAbility(id, 'G'));
    expect(getObject(after, id).tapped).toBe(true);
  });

  it('leaves the source untapped when the ability needs no tap', () => {
    const { state, emitter, id } = withPermanent();
    const ability: ManaAbility = {
      source: id,
      requiresTap: false,
      modes: [[{ type: 'B', amount: 3 }]],
    };
    const after = activateManaAbility(state, emitter, 'A', ability);
    expect(getObject(after, id).tapped).toBe(false);
    expect(manaPoolCounts(after.players.A.manaPool)).toMatchObject({ B: 3 });
  });

  it('emits a tap and an activate event', () => {
    const { state, emitter, id } = withPermanent();
    activateManaAbility(state, emitter, 'A', basicLandAbility(id, 'G'));
    expect(emitter.events.map((event) => event.type)).toEqual(['tap', 'activate']);
    expect(emitter.events[1]).toMatchObject({ type: 'activate', player: 'A', source: id });
  });

  it('accumulates across several activations', () => {
    const { state, emitter, id } = withPermanent();
    const second = createObject(state, { definitionId: land, owner: 'A', zone: 'battlefield' });
    let current = activateManaAbility(second.state, emitter, 'A', basicLandAbility(id, 'G'));
    current = activateManaAbility(current, emitter, 'A', basicLandAbility(second.object.id, 'U'));
    expect(manaPoolSize(current.players.A.manaPool)).toBe(2);
    expect(manaPoolCounts(current.players.A.manaPool)).toMatchObject({ G: 1, U: 1 });
  });

  it('produces snow mana when the source is snow', () => {
    const { state, emitter, id } = withPermanent();
    const after = activateManaAbility(state, emitter, 'A', basicLandAbility(id, 'G', true));
    expect(after.players.A.manaPool[0]).toMatchObject({ type: 'G', snow: true });
  });

  it('carries a spend restriction onto the mana it makes', () => {
    const { state, emitter, id } = withPermanent();
    const ability: ManaAbility = {
      source: id,
      requiresTap: true,
      modes: [[{ type: 'R', amount: 2, restriction: 'creature-spells-only' }]],
    };
    const after = activateManaAbility(state, emitter, 'A', ability);
    expect(after.players.A.manaPool[0]?.restriction).toBe('creature-spells-only');
  });

  it('lets a dual land choose between its modes', () => {
    const { state, emitter, id } = withPermanent();
    const dual: ManaAbility = {
      source: id,
      requiresTap: true,
      modes: [[{ type: 'W', amount: 1 }], [{ type: 'U', amount: 1 }]],
    };
    expect(
      manaPoolCounts(activateManaAbility(state, emitter, 'A', dual, 0).players.A.manaPool),
    ).toMatchObject({ W: 1 });
    expect(
      manaPoolCounts(activateManaAbility(state, emitter, 'A', dual, 1).players.A.manaPool),
    ).toMatchObject({ U: 1 });
  });

  it('produces several mana at once when a mode says so', () => {
    const { state, emitter, id } = withPermanent();
    const ability: ManaAbility = {
      source: id,
      requiresTap: true,
      modes: [
        [
          { type: 'G', amount: 1 },
          { type: 'U', amount: 1 },
        ],
      ],
    };
    const after = activateManaAbility(state, emitter, 'A', ability);
    expect(manaPoolCounts(after.players.A.manaPool)).toMatchObject({ G: 1, U: 1 });
  });

  it('refuses an illegal activation', () => {
    const { state, emitter, id } = withPermanent('B');
    expect(() => activateManaAbility(state, emitter, 'A', basicLandAbility(id, 'G'))).toThrow(
      IllegalManaAbilityError,
    );
  });

  it('refuses a mode that does not exist', () => {
    const { state, emitter, id } = withPermanent();
    expect(() => activateManaAbility(state, emitter, 'A', basicLandAbility(id, 'G'), 3)).toThrow(
      /no mode 3/,
    );
  });

  it('does not give the mana to the wrong player', () => {
    const { state, emitter, id } = withPermanent();
    const after = activateManaAbility(state, emitter, 'A', basicLandAbility(id, 'G'));
    expect(manaPoolSize(after.players.B.manaPool)).toBe(0);
  });
});
