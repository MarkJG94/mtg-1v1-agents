import { asOracleId, type ObjectId, type PlayerId, playerZone } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { createEventEmitter, type EventEmitter } from './events/emitter.js';
import { stateFromSeed } from './rng.js';
import {
  counterObject,
  IllegalStackActionError,
  isStackEmpty,
  putOnStack,
  resolveTopOfStack,
  splitSecondActive,
  topOfStack,
} from './stack.js';
import { createGameState, type GameState } from './state/game-state.js';
import { createObject, getObject, objectsIn } from './state/update.js';
import { applyDecision, startGame } from './turn/turn.js';

const spell = asOracleId('oracle-spell');

const pass = (state: GameState, emitter: EventEmitter): GameState =>
  applyDecision(state, emitter, { kind: 'priority', action: { kind: 'pass' } });

/**
 * A started game at A's precombat main phase, with `cards` in each player's hand.
 * Returns the hands so tests can name the card they cast.
 */
const atMain = (cards = 2) => {
  let state = createGameState({ rng: stateFromSeed('1'), onPlay: 'A' });
  const hands: Record<PlayerId, ObjectId[]> = { A: [], B: [] };
  for (const player of ['A', 'B'] as const) {
    for (let i = 0; i < cards; i += 1) {
      const created = createObject(state, {
        definitionId: spell,
        owner: player,
        zone: playerZone(player, 'hand'),
      });
      state = created.state;
      hands[player].push(created.object.id);
    }
  }

  const emitter = createEventEmitter();
  let current = startGame(state, emitter);
  while (current.step !== 'precombatMain') current = pass(current, emitter);
  return { state: current, emitter, hands };
};

describe('reading the stack', () => {
  it('starts empty', () => {
    const { state } = atMain();
    expect(isStackEmpty(state)).toBe(true);
    expect(topOfStack(state)).toBeUndefined();
  });

  it('reports the most recently added object as the top', () => {
    const { state, emitter, hands } = atMain();
    const first = putOnStack(state, emitter, 'A', hands.A[0] as ObjectId);
    expect(topOfStack(first)).toBe(hands.A[0]);

    const second = putOnStack(first, emitter, 'A', hands.A[1] as ObjectId);
    expect(topOfStack(second)).toBe(hands.A[1]);
    expect(objectsIn(second, 'stack')).toEqual([hands.A[0], hands.A[1]]);
  });
});

describe('putOnStack', () => {
  it('moves the card from hand to the stack', () => {
    const { state, emitter, hands } = atMain();
    const id = hands.A[0] as ObjectId;
    const after = putOnStack(state, emitter, 'A', id);
    expect(objectsIn(after, 'stack')).toEqual([id]);
    expect(objectsIn(after, playerZone('A', 'hand'))).not.toContain(id);
    expect(getObject(after, id).zone).toBe('stack');
  });

  it('emits cast and putOnStack', () => {
    const { state, emitter, hands } = atMain();
    putOnStack(state, emitter, 'A', hands.A[0] as ObjectId);
    expect(emitter.events.slice(-2).map((event) => event.type)).toEqual(['cast', 'putOnStack']);
  });

  it('records where the spell will go when it resolves', () => {
    const { state, emitter, hands } = atMain();
    const id = hands.A[0] as ObjectId;
    const after = putOnStack(state, emitter, 'A', id, { resolvesTo: 'battlefield' });
    expect(getObject(after, id).stack).toEqual({ resolvesTo: 'battlefield', splitSecond: false });
  });

  it('defaults to resolving into the owner’s graveyard, as instants do', () => {
    const { state, emitter, hands } = atMain();
    const id = hands.A[0] as ObjectId;
    expect(getObject(putOnStack(state, emitter, 'A', id), id).stack?.resolvesTo).toBe(
      'A:graveyard',
    );
  });

  it('hands priority straight back to the caster and restarts the pass count (CR 117.3c)', () => {
    const { state, emitter, hands } = atMain();
    const passedOnce = pass(state, emitter);
    expect(passedOnce.passesInARow).toBe(1);

    const after = putOnStack(passedOnce, emitter, 'B', hands.B[0] as ObjectId);
    expect(after.passesInARow).toBe(0);
    expect(after.priority).toBe('B');
    expect(after.pendingDecision).toEqual({
      kind: 'priority',
      player: 'B',
      options: [{ kind: 'pass' }],
    });
  });

  it('refuses a player who does not have priority', () => {
    const { state, emitter, hands } = atMain();
    expect(() => putOnStack(state, emitter, 'B', hands.B[0] as ObjectId)).toThrow(
      /does not have priority/,
    );
  });

  it('refuses a card that is not in the caster’s hand', () => {
    const { state, emitter, hands } = atMain();
    expect(() => putOnStack(state, emitter, 'A', hands.B[0] as ObjectId)).toThrow(
      IllegalStackActionError,
    );
  });
});

describe('split second (CR 702.61)', () => {
  it('is not active for an ordinary spell', () => {
    const { state, emitter, hands } = atMain();
    expect(splitSecondActive(putOnStack(state, emitter, 'A', hands.A[0] as ObjectId))).toBe(false);
  });

  it('is active while a split-second spell is on the stack', () => {
    const { state, emitter, hands } = atMain();
    const after = putOnStack(state, emitter, 'A', hands.A[0] as ObjectId, { splitSecond: true });
    expect(splitSecondActive(after)).toBe(true);
  });

  it('stops anything else being cast', () => {
    const { state, emitter, hands } = atMain();
    const after = putOnStack(state, emitter, 'A', hands.A[0] as ObjectId, { splitSecond: true });
    const opponentHasPriority = pass(after, emitter);
    expect(() => putOnStack(opponentHasPriority, emitter, 'B', hands.B[0] as ObjectId)).toThrow(
      /split second/,
    );
  });

  it('stops applying once the spell has resolved', () => {
    const { state, emitter, hands } = atMain();
    const cast = putOnStack(state, emitter, 'A', hands.A[0] as ObjectId, { splitSecond: true });
    expect(splitSecondActive(resolveTopOfStack(cast, emitter))).toBe(false);
  });
});

describe('resolveTopOfStack (CR 608)', () => {
  it('sends an instant to its owner’s graveyard', () => {
    const { state, emitter, hands } = atMain();
    const id = hands.A[0] as ObjectId;
    const resolved = resolveTopOfStack(putOnStack(state, emitter, 'A', id), emitter);
    expect(objectsIn(resolved, playerZone('A', 'graveyard'))).toEqual([id]);
    expect(isStackEmpty(resolved)).toBe(true);
  });

  it('puts a permanent spell onto the battlefield', () => {
    const { state, emitter, hands } = atMain();
    const id = hands.A[0] as ObjectId;
    const cast = putOnStack(state, emitter, 'A', id, { resolvesTo: 'battlefield' });
    const resolved = resolveTopOfStack(cast, emitter);
    expect(objectsIn(resolved, 'battlefield')).toEqual([id]);
  });

  it('gives a permanent summoning sickness as it enters (CR 302.6)', () => {
    const { state, emitter, hands } = atMain();
    const id = hands.A[0] as ObjectId;
    const cast = putOnStack(state, emitter, 'A', id, { resolvesTo: 'battlefield' });
    expect(getObject(resolveTopOfStack(cast, emitter), id).summoningSick).toBe(true);
  });

  it('clears the stack properties as the object leaves', () => {
    const { state, emitter, hands } = atMain();
    const id = hands.A[0] as ObjectId;
    const resolved = resolveTopOfStack(putOnStack(state, emitter, 'A', id), emitter);
    expect(getObject(resolved, id).stack).toBeUndefined();
  });

  it('emits resolve then moveZone', () => {
    const { state, emitter, hands } = atMain();
    resolveTopOfStack(putOnStack(state, emitter, 'A', hands.A[0] as ObjectId), emitter);
    expect(emitter.events.slice(-2).map((event) => event.type)).toEqual(['resolve', 'moveZone']);
  });

  it('throws on an empty stack', () => {
    const { state, emitter } = atMain();
    expect(() => resolveTopOfStack(state, emitter)).toThrow(/stack is empty/);
  });
});

describe('countering (CR 701.5)', () => {
  it('sends the spell to its owner’s graveyard without resolving', () => {
    const { state, emitter, hands } = atMain();
    const target = hands.A[0] as ObjectId;
    const counterspell = hands.B[0] as ObjectId;
    const cast = putOnStack(state, emitter, 'A', target, { resolvesTo: 'battlefield' });

    const countered = counterObject(cast, emitter, target, counterspell);
    expect(objectsIn(countered, playerZone('A', 'graveyard'))).toEqual([target]);
    // It never reached the battlefield, which is the whole point.
    expect(objectsIn(countered, 'battlefield')).toEqual([]);
    expect(isStackEmpty(countered)).toBe(true);
  });

  it('emits a counter event naming what countered it', () => {
    const { state, emitter, hands } = atMain();
    const target = hands.A[0] as ObjectId;
    const cast = putOnStack(state, emitter, 'A', target);
    counterObject(cast, emitter, target, hands.B[0] as ObjectId);
    expect(emitter.events.at(-2)).toMatchObject({
      type: 'counter',
      object: target,
      by: hands.B[0],
    });
  });

  it('refuses to counter something that is not on the stack', () => {
    const { state, emitter, hands } = atMain();
    expect(() =>
      counterObject(state, emitter, hands.A[0] as ObjectId, hands.B[0] as ObjectId),
    ).toThrow(/not on the stack/);
  });
});

describe('priority and the stack together', () => {
  it('resolves the top item when both players pass (CR 117.4)', () => {
    const { state, emitter, hands } = atMain();
    const id = hands.A[0] as ObjectId;
    const cast = putOnStack(state, emitter, 'A', id);

    // Priority returns to the caster; both then pass.
    const afterCast = applyDecision(cast, emitter, {
      kind: 'priority',
      action: { kind: 'pass' },
    });
    expect(afterCast.priority).toBe('B');

    const resolved = pass(afterCast, emitter);
    expect(objectsIn(resolved, playerZone('A', 'graveyard'))).toEqual([id]);
    expect(isStackEmpty(resolved)).toBe(true);
  });

  it('gives the active player priority again after something resolves (CR 117.3b)', () => {
    const { state, emitter, hands } = atMain();
    const cast = putOnStack(state, emitter, 'A', hands.A[0] as ObjectId);
    const resolved = pass(pass(cast, emitter), emitter);
    expect(resolved.priority).toBe('A');
    expect(resolved.step).toBe('precombatMain');
  });

  it('does not end the step while the stack still holds something', () => {
    const { state, emitter, hands } = atMain();
    const cast = putOnStack(state, emitter, 'A', hands.A[0] as ObjectId);
    const resolved = pass(pass(cast, emitter), emitter);
    // One item resolved; the step has not advanced.
    expect(resolved.step).toBe('precombatMain');
  });

  it('resolves a response before the spell it answers (last on, first off)', () => {
    const { state, emitter, hands } = atMain();
    const spellA = hands.A[0] as ObjectId;
    const responseB = hands.B[0] as ObjectId;

    let current = putOnStack(state, emitter, 'A', spellA);
    current = pass(current, emitter); // A passes, B gets priority
    current = putOnStack(current, emitter, 'B', responseB);
    expect(objectsIn(current, 'stack')).toEqual([spellA, responseB]);

    // B passes, A passes: the response resolves first.
    current = pass(current, emitter);
    current = pass(current, emitter);
    expect(objectsIn(current, playerZone('B', 'graveyard'))).toEqual([responseB]);
    expect(objectsIn(current, 'stack')).toEqual([spellA]);
  });
});
