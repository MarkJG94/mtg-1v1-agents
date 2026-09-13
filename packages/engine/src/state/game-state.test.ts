import { allZoneIds, playerIds } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { stateFromSeed } from '../rng.js';
import { createGameState, DEFAULT_STARTING_LIFE, isGameOver } from './game-state.js';
import { checkStateInvariants } from './update.js';

const state = () => createGameState({ rng: stateFromSeed('7'), onPlay: 'A' });

describe('createGameState', () => {
  it('starts before turn 1 with no priority and no result', () => {
    const game = state();
    expect(game).toMatchObject({
      version: 0,
      turn: 0,
      step: 'untap',
      priority: null,
      passesInARow: 0,
      result: null,
    });
    expect(isGameOver(game)).toBe(false);
  });

  it('gives the first turn to the player on the play', () => {
    expect(createGameState({ rng: stateFromSeed('1'), onPlay: 'B' }).activePlayer).toBe('B');
  });

  it('creates every zone, all empty', () => {
    const game = state();
    expect(Object.keys(game.zones).sort()).toEqual([...allZoneIds].sort());
    for (const zone of allZoneIds) expect(game.zones[zone]).toEqual([]);
  });

  it('starts both players at the default life total', () => {
    const game = state();
    for (const player of playerIds) {
      expect(game.players[player]).toMatchObject({
        life: DEFAULT_STARTING_LIFE,
        poison: 0,
        landsPlayedThisTurn: 0,
        maxLandsPerTurn: 1,
        drewFromEmptyLibrary: false,
      });
    }
  });

  it('honours a custom starting life total', () => {
    const game = createGameState({ rng: stateFromSeed('1'), onPlay: 'A', startingLife: 25 });
    expect(game.players.A.life).toBe(25);
    expect(game.players.B.life).toBe(25);
  });

  it('gives each player their own state object', () => {
    const game = state();
    expect(game.players.A).not.toBe(game.players.B);
  });

  it('is well formed', () => {
    expect(checkStateInvariants(state())).toEqual([]);
  });

  it('carries the RNG state it was given', () => {
    expect(state().rng).toEqual(stateFromSeed('7'));
  });
});
