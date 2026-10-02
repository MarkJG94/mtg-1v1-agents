import { asOracleId, type GameEvent } from '@mtg/shared';
import { describe, expect, it, vi } from 'vitest';
import { stateFromSeed } from '../rng.js';
import { createGameState, type GameState } from '../state/game-state.js';
import { createObject, destroyObject, updateObject } from '../state/update.js';
import { createEventEmitter, nullEventEmitter } from './emitter.js';
import { runEvent } from './perform.js';

const state = (patch: Partial<GameState> = {}): GameState => ({
  ...createGameState({ rng: stateFromSeed('1'), onPlay: 'A' }),
  ...patch,
});

describe('createEventEmitter', () => {
  it('numbers events from zero, in order', () => {
    const emitter = createEventEmitter();
    const game = state();
    emitter.emit(game, { type: 'stepStart' });
    emitter.emit(game, { type: 'turnStart', activePlayer: 'A' });
    expect(emitter.events.map((event) => event.seq)).toEqual([0, 1]);
    expect(emitter.nextSeq).toBe(2);
  });

  it('stamps the turn and step from the state, not the caller', () => {
    const emitter = createEventEmitter();
    const event = emitter.emit(state({ turn: 4, step: 'declareBlockers' }), {
      type: 'stepStart',
    });
    expect(event).toMatchObject({ seq: 0, turn: 4, step: 'declareBlockers', type: 'stepStart' });
  });

  it('records what each object is the first time an event names it (docs/06 `objects`)', () => {
    const card = createObject(state(), {
      definitionId: asOracleId('card'),
      owner: 'A',
      zone: 'battlefield',
    });
    const token = createObject(card.state, {
      definitionId: asOracleId('card'),
      owner: 'B',
      zone: 'battlefield',
      token: true,
      name: 'Spirit',
      power: 1,
      toughness: 1,
    });
    const ability = createObject(token.state, {
      definitionId: asOracleId('card'),
      owner: 'A',
      zone: 'stack',
    });
    const game = updateObject(ability.state, ability.object.id, {
      stack: { resolvesTo: 'exile', splitSecond: false, targets: [], colours: [], isAbility: true },
    });
    const introduced: unknown[][] = [];
    const emitter = createEventEmitter({
      onEvent: (_event, objects) => introduced.push([...objects]),
    });

    emitter.emit(game, { type: 'tap', object: card.object.id });
    emitter.emit(game, {
      type: 'block',
      blocker: token.object.id,
      blocking: [card.object.id],
    });
    emitter.emit(game, { type: 'putOnStack', object: ability.object.id });
    // Named once, recorded once — and still known after it has ceased to exist.
    emitter.emit(destroyObject(game, ability.object.id), {
      type: 'resolve',
      object: ability.object.id,
    });

    expect(emitter.objects).toEqual([
      { id: card.object.id, oracleId: 'card', owner: 'A' },
      {
        id: token.object.id,
        oracleId: 'card',
        owner: 'B',
        token: true,
        name: 'Spirit',
        power: 1,
        toughness: 1,
      },
      { id: ability.object.id, oracleId: 'card', owner: 'A', ability: true },
    ]);
    expect(introduced.map((objects) => objects.length)).toEqual([1, 1, 1, 0]);
  });

  it('keeps the payload alongside the envelope', () => {
    const emitter = createEventEmitter();
    const event = emitter.emit(state(), {
      type: 'lifeChange',
      player: 'B',
      from: 20,
      to: 17,
      reason: 'Lightning Bolt',
    });
    expect(event).toMatchObject({ type: 'lifeChange', player: 'B', from: 20, to: 17 });
  });

  it('can resume numbering, so a game split across steps stays monotonic', () => {
    const emitter = createEventEmitter({ startSeq: 41 });
    expect(emitter.emit(state(), { type: 'stepStart' }).seq).toBe(41);
    expect(emitter.nextSeq).toBe(42);
  });

  it('rejects a nonsensical starting sequence', () => {
    expect(() => createEventEmitter({ startSeq: -1 })).toThrow(RangeError);
    expect(() => createEventEmitter({ startSeq: 1.5 })).toThrow(RangeError);
  });

  it('drains the buffer but keeps counting', () => {
    const emitter = createEventEmitter();
    const game = state();
    emitter.emit(game, { type: 'stepStart' });
    emitter.emit(game, { type: 'stepStart' });

    const drained = emitter.drain();
    expect(drained).toHaveLength(2);
    expect(emitter.events).toEqual([]);

    emitter.emit(game, { type: 'stepStart' });
    expect(emitter.events[0]?.seq).toBe(2);
    expect(drained).toHaveLength(2);
  });

  it('streams each event to a listener as it happens', () => {
    const seen: GameEvent[] = [];
    const emitter = createEventEmitter({ onEvent: (event) => seen.push(event) });
    const game = state();
    emitter.emit(game, { type: 'stepStart' });
    emitter.emit(game, { type: 'turnStart', activePlayer: 'B' });
    expect(seen.map((event) => event.type)).toEqual(['stepStart', 'turnStart']);
    expect(seen[0]).toBe(emitter.events[0]);
  });

  it('notifies the listener exactly once per event', () => {
    const onEvent = vi.fn();
    const emitter = createEventEmitter({ onEvent });
    emitter.emit(state(), { type: 'stepStart' });
    expect(onEvent).toHaveBeenCalledTimes(1);
  });
});

describe('nullEventEmitter', () => {
  it('still stamps events, so callers behave identically', () => {
    const emitter = nullEventEmitter();
    const event = emitter.emit(state({ turn: 2 }), { type: 'stepStart' });
    expect(event).toMatchObject({ seq: 0, turn: 2, type: 'stepStart' });
    expect(emitter.nextSeq).toBe(1);
  });

  it('records nothing, so search lookahead allocates no log', () => {
    const emitter = nullEventEmitter();
    emitter.emit(state(), { type: 'stepStart' });
    emitter.emit(state(), { type: 'stepStart' });
    expect(emitter.events).toEqual([]);
    expect(emitter.drain()).toEqual([]);
  });
});

describe('poison, as the log records it', () => {
  it('is logged with the count before and after, which no object counter can carry (CR 122.1)', () => {
    const emitter = createEventEmitter();
    const poisoned = runEvent(state(), emitter, { kind: 'poison', player: 'B', amount: 2 });
    const again = runEvent(poisoned, emitter, { kind: 'poison', player: 'B', amount: 3 });
    expect(again.players.B.poison).toBe(5);
    expect(emitter.events).toMatchObject([
      { type: 'poisonChange', player: 'B', from: 0, to: 2 },
      { type: 'poisonChange', player: 'B', from: 2, to: 5 },
    ]);
  });
});
