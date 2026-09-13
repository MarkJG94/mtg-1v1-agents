import { asOracleId, type ObjectId, playerZone } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { createEventEmitter, type EventEmitter } from '../events/emitter.js';
import { stateFromSeed } from '../rng.js';
import { createGameState, type GameState } from '../state/game-state.js';
import { createObject, getObject, objectsIn, updatePlayer } from '../state/update.js';
import { canPlayLand, IllegalLandPlayError, landsRemainingThisTurn, playLand } from './land.js';
import { advanceStep, startFirstTurn } from './turn.js';

const forest = asOracleId('oracle-forest');

/** A started game with one card in each player's hand, stopped at A's precombat main. */
const atMainPhase = (): {
  state: GameState;
  emitter: EventEmitter;
  mine: ObjectId;
  theirs: ObjectId;
} => {
  let state = createGameState({ rng: stateFromSeed('1'), onPlay: 'A' });
  const a = createObject(state, {
    definitionId: forest,
    owner: 'A',
    zone: playerZone('A', 'hand'),
  });
  state = a.state;
  const b = createObject(state, {
    definitionId: forest,
    owner: 'B',
    zone: playerZone('B', 'hand'),
  });
  state = b.state;

  const emitter = createEventEmitter();
  let current = startFirstTurn(state, emitter);
  while (current.step !== 'precombatMain') current = advanceStep(current, emitter);
  return { state: current, emitter, mine: a.object.id, theirs: b.object.id };
};

describe('landsRemainingThisTurn', () => {
  it('starts at the player’s allowance', () => {
    const { state } = atMainPhase();
    expect(landsRemainingThisTurn(state, 'A')).toBe(1);
  });

  it('falls to zero once the drop is spent', () => {
    const { state, emitter, mine } = atMainPhase();
    expect(landsRemainingThisTurn(playLand(state, emitter, 'A', mine), 'A')).toBe(0);
  });

  it('follows maxLandsPerTurn, which effects such as Exploration raise', () => {
    const { state } = atMainPhase();
    expect(landsRemainingThisTurn(updatePlayer(state, 'A', { maxLandsPerTurn: 2 }), 'A')).toBe(2);
  });

  it('never reports a negative allowance', () => {
    const { state } = atMainPhase();
    const overspent = updatePlayer(state, 'A', { landsPlayedThisTurn: 3 });
    expect(landsRemainingThisTurn(overspent, 'A')).toBe(0);
  });
});

describe('canPlayLand (CR 305.1)', () => {
  it('allows the active player in their main phase', () => {
    const { state } = atMainPhase();
    expect(canPlayLand(state, 'A')).toBe(true);
  });

  it('refuses the non-active player', () => {
    const { state } = atMainPhase();
    expect(canPlayLand(state, 'B')).toBe(false);
  });

  it('refuses outside a main phase', () => {
    const { state, emitter } = atMainPhase();
    let current = state;
    while (current.step !== 'declareAttackers') current = advanceStep(current, emitter);
    expect(canPlayLand(current, 'A')).toBe(false);
  });

  it('allows the postcombat main phase too', () => {
    const { state, emitter } = atMainPhase();
    let current = state;
    while (current.step !== 'postcombatMain') current = advanceStep(current, emitter);
    expect(canPlayLand(current, 'A')).toBe(true);
  });

  it('refuses while something is on the stack', () => {
    const { state } = atMainPhase();
    const onStack = createObject(state, { definitionId: forest, owner: 'A', zone: 'stack' });
    expect(canPlayLand(onStack.state, 'A')).toBe(false);
  });

  it('refuses once the land drop is spent (CR 305.2)', () => {
    const { state, emitter, mine } = atMainPhase();
    expect(canPlayLand(playLand(state, emitter, 'A', mine), 'A')).toBe(false);
  });

  it('refuses once the game is over', () => {
    const { state } = atMainPhase();
    const over = { ...state, result: { winner: null, reason: 'turnCap' as const, turn: 1 } };
    expect(canPlayLand(over, 'A')).toBe(false);
  });
});

describe('playLand', () => {
  it('moves the card from hand to the battlefield', () => {
    const { state, emitter, mine } = atMainPhase();
    const played = playLand(state, emitter, 'A', mine);
    expect(objectsIn(played, 'battlefield')).toEqual([mine]);
    expect(objectsIn(played, playerZone('A', 'hand'))).toEqual([]);
    expect(getObject(played, mine).zone).toBe('battlefield');
  });

  it('spends the land drop', () => {
    const { state, emitter, mine } = atMainPhase();
    expect(playLand(state, emitter, 'A', mine).players.A.landsPlayedThisTurn).toBe(1);
  });

  it('emits a playLand event', () => {
    const { state, emitter, mine } = atMainPhase();
    playLand(state, emitter, 'A', mine);
    expect(emitter.events.at(-1)).toMatchObject({ type: 'playLand', player: 'A', object: mine });
  });

  it('does not spend the opponent’s land drop', () => {
    const { state, emitter, mine } = atMainPhase();
    expect(playLand(state, emitter, 'A', mine).players.B.landsPlayedThisTurn).toBe(0);
  });

  it('refuses a second land in the same turn', () => {
    const { state, emitter, mine } = atMainPhase();
    const played = playLand(state, emitter, 'A', mine);
    const second = createObject(played, {
      definitionId: forest,
      owner: 'A',
      zone: playerZone('A', 'hand'),
    });
    expect(() => playLand(second.state, emitter, 'A', second.object.id)).toThrow(
      IllegalLandPlayError,
    );
  });

  it('allows a second land when an effect raised the allowance', () => {
    const { state, emitter, mine } = atMainPhase();
    const raised = updatePlayer(state, 'A', { maxLandsPerTurn: 2 });
    const played = playLand(raised, emitter, 'A', mine);
    const second = createObject(played, {
      definitionId: forest,
      owner: 'A',
      zone: playerZone('A', 'hand'),
    });
    const bothPlayed = playLand(second.state, emitter, 'A', second.object.id);
    expect(objectsIn(bothPlayed, 'battlefield')).toHaveLength(2);
    expect(bothPlayed.players.A.landsPlayedThisTurn).toBe(2);
  });

  it('refuses a card that is not in the player’s hand', () => {
    const { state, emitter, theirs } = atMainPhase();
    expect(() => playLand(state, emitter, 'A', theirs)).toThrow(/is in B:hand, not A's hand/);
  });

  it('refuses the non-active player', () => {
    const { state, emitter, theirs } = atMainPhase();
    expect(() => playLand(state, emitter, 'B', theirs)).toThrow(IllegalLandPlayError);
  });

  it('lets the allowance come back on the player’s next turn', () => {
    const { state, emitter, mine } = atMainPhase();
    let current = playLand(state, emitter, 'A', mine);
    expect(landsRemainingThisTurn(current, 'A')).toBe(0);

    while (
      !(current.activePlayer === 'A' && current.step === 'precombatMain' && current.turn > 1)
    ) {
      current = advanceStep(current, emitter);
    }
    expect(current.turn).toBe(3);
    expect(landsRemainingThisTurn(current, 'A')).toBe(1);
  });
});

describe('the land-drop counter is per player', () => {
  it('lets each player play a land on their own turn', () => {
    const { state, emitter, mine, theirs } = atMainPhase();
    let current = playLand(state, emitter, 'A', mine);
    while (!(current.activePlayer === 'B' && current.step === 'precombatMain')) {
      current = advanceStep(current, emitter);
    }
    const bothPlayed = playLand(current, emitter, 'B', theirs);
    expect(objectsIn(bothPlayed, 'battlefield')).toHaveLength(2);
    expect(bothPlayed.players.B.landsPlayedThisTurn).toBe(1);
  });
});
