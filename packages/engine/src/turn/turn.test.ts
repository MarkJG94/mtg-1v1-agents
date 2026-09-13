import { asOracleId, type ObjectId, type PlayerId, playerIds, playerZone } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { createEventEmitter, type EventEmitter } from '../events/emitter.js';
import { addMana, emptyManaPool } from '../mana/pool.js';
import { stateFromSeed } from '../rng.js';
import {
  type CreateGameStateOptions,
  createGameState,
  type GameState,
} from '../state/game-state.js';
import { createObject, getObject, objectsIn, updateObject, updatePlayer } from '../state/update.js';
import {
  advanceStep,
  advanceUntilGameOver,
  drawCard,
  grantExtraTurn,
  nextStep,
  startFirstTurn,
} from './turn.js';

const card = asOracleId('oracle-card');

/** A game with `librarySize` cards in each library and nothing else. */
const setup = (
  librarySize = 10,
  options: Partial<CreateGameStateOptions> = {},
): { state: GameState; emitter: EventEmitter } => {
  let state = createGameState({ rng: stateFromSeed('1'), onPlay: 'A', ...options });
  for (const player of playerIds) {
    for (let i = 0; i < librarySize; i += 1) {
      state = createObject(state, {
        definitionId: card,
        owner: player,
        zone: playerZone(player, 'library'),
      }).state;
    }
  }
  return { state, emitter: createEventEmitter() };
};

const putOnBattlefield = (
  state: GameState,
  controller: PlayerId,
  patch: { tapped?: boolean; summoningSick?: boolean; damage?: number } = {},
): { state: GameState; id: ObjectId } => {
  const created = createObject(state, {
    definitionId: card,
    owner: controller,
    zone: 'battlefield',
  });
  return { state: updateObject(created.state, created.object.id, patch), id: created.object.id };
};

const stepsOfTurn = (state: GameState, emitter: EventEmitter): string[] => {
  const seen = [state.step];
  let current = state;
  const startingTurn = state.turn;
  while (current.turn === startingTurn) {
    current = advanceStep(current, emitter);
    if (current.turn === startingTurn) seen.push(current.step);
  }
  return seen;
};

describe('starting the game', () => {
  it('begins turn 1 with the player on the play, in the untap step', () => {
    const { state, emitter } = setup();
    const started = startFirstTurn(state, emitter);
    expect(started).toMatchObject({ turn: 1, activePlayer: 'A', step: 'untap' });
  });

  it('gives the first turn to whoever is on the play', () => {
    const { state, emitter } = setup(10, { onPlay: 'B' });
    expect(startFirstTurn(state, emitter).activePlayer).toBe('B');
  });

  it('emits turnStart then stepStart', () => {
    const { state, emitter } = setup();
    startFirstTurn(state, emitter);
    expect(emitter.events.map((event) => event.type)).toEqual(['turnStart', 'stepStart']);
    expect(emitter.events[0]).toMatchObject({ type: 'turnStart', activePlayer: 'A', turn: 1 });
  });

  it('refuses to start twice', () => {
    const { state, emitter } = setup();
    expect(() => startFirstTurn(startFirstTurn(state, emitter), emitter)).toThrow(
      /already started/,
    );
  });

  it('refuses to advance a game that has not started', () => {
    const { state, emitter } = setup();
    expect(() => advanceStep(state, emitter)).toThrow(/has not started/);
  });
});

describe('the sequence of steps (CR 500)', () => {
  it('walks every step in turn order', () => {
    const { state, emitter } = setup();
    expect(stepsOfTurn(startFirstTurn(state, emitter), emitter)).toEqual([
      'untap',
      'upkeep',
      'draw',
      'precombatMain',
      'beginCombat',
      'declareAttackers',
      'declareBlockers',
      'combatDamage',
      'endCombat',
      'postcombatMain',
      'end',
      'cleanup',
    ]);
  });

  it('skips the first-strike damage step when no first striker is in combat (CR 510.5)', () => {
    const { state, emitter } = setup();
    const walked = stepsOfTurn(startFirstTurn(state, emitter), emitter);
    expect(walked).not.toContain('firstStrikeDamage');
    expect(nextStep(state, 'declareBlockers')).toBe('combatDamage');
  });

  it('reports no next step after cleanup', () => {
    const { state } = setup();
    expect(nextStep(state, 'cleanup')).toBeNull();
  });

  it('emits one stepStart per step of the turn', () => {
    const { state, emitter } = setup();
    // stepsOfTurn runs on into the next turn's untap, so count only turn 1's events.
    stepsOfTurn(startFirstTurn(state, emitter), emitter);
    const stepStarts = emitter.events.filter(
      (event) => event.type === 'stepStart' && event.turn === 1,
    );
    expect(stepStarts).toHaveLength(12);
    expect(stepStarts.map((event) => event.step)).toEqual([
      'untap',
      'upkeep',
      'draw',
      'precombatMain',
      'beginCombat',
      'declareAttackers',
      'declareBlockers',
      'combatDamage',
      'endCombat',
      'postcombatMain',
      'end',
      'cleanup',
    ]);
  });
});

describe('turn rollover', () => {
  it('passes the turn to the opponent after cleanup', () => {
    const { state, emitter } = setup();
    let current = startFirstTurn(state, emitter);
    while (current.turn === 1) current = advanceStep(current, emitter);
    expect(current).toMatchObject({ turn: 2, activePlayer: 'B', step: 'untap' });
  });

  it('alternates players across several turns', () => {
    const { state, emitter } = setup(60);
    let current = startFirstTurn(state, emitter);
    const active: PlayerId[] = [current.activePlayer];
    while (current.turn < 5) {
      current = advanceStep(current, emitter);
      if (current.step === 'untap' && active.length < current.turn)
        active.push(current.activePlayer);
    }
    expect(active).toEqual(['A', 'B', 'A', 'B', 'A']);
  });

  it('resets land drops for both players each turn', () => {
    const { state, emitter } = setup();
    let current = startFirstTurn(state, emitter);
    current = updatePlayer(current, 'A', { landsPlayedThisTurn: 1 });
    current = updatePlayer(current, 'B', { landsPlayedThisTurn: 1 });
    while (current.turn === 1) current = advanceStep(current, emitter);
    expect(current.players.A.landsPlayedThisTurn).toBe(0);
    expect(current.players.B.landsPlayedThisTurn).toBe(0);
  });
});

describe('the untap step (CR 502)', () => {
  it('untaps the permanents the active player controls', () => {
    const { state, emitter } = setup();
    const mine = putOnBattlefield(state, 'A', { tapped: true });
    const started = startFirstTurn(mine.state, emitter);
    expect(getObject(started, mine.id).tapped).toBe(false);
  });

  it('leaves the opponent’s permanents tapped', () => {
    const { state, emitter } = setup();
    const theirs = putOnBattlefield(state, 'B', { tapped: true });
    const started = startFirstTurn(theirs.state, emitter);
    expect(getObject(started, theirs.id).tapped).toBe(true);
  });

  it('clears summoning sickness for the active player (CR 302.6)', () => {
    const { state, emitter } = setup();
    const mine = putOnBattlefield(state, 'A', { summoningSick: true });
    const started = startFirstTurn(mine.state, emitter);
    expect(getObject(started, mine.id).summoningSick).toBe(false);
  });

  it('leaves the opponent’s creatures summoning sick', () => {
    const { state, emitter } = setup();
    const theirs = putOnBattlefield(state, 'B', { summoningSick: true });
    const started = startFirstTurn(theirs.state, emitter);
    expect(getObject(started, theirs.id).summoningSick).toBe(true);
  });

  it('emits an untap event per permanent actually untapped', () => {
    const { state, emitter } = setup();
    const tapped = putOnBattlefield(state, 'A', { tapped: true });
    const untappedAlready = putOnBattlefield(tapped.state, 'A');
    startFirstTurn(untappedAlready.state, emitter);
    const untaps = emitter.events.filter((event) => event.type === 'untap');
    expect(untaps).toHaveLength(1);
    expect(untaps[0]).toMatchObject({ object: tapped.id });
  });
});

describe('the draw step (CR 504)', () => {
  const drawUntilStep = (state: GameState, emitter: EventEmitter): GameState => {
    let current = startFirstTurn(state, emitter);
    while (current.step !== 'draw') current = advanceStep(current, emitter);
    return current;
  };

  it('lets the player on the play skip their first draw (CR 103.7a)', () => {
    const { state, emitter } = setup();
    const atDraw = drawUntilStep(state, emitter);
    expect(objectsIn(atDraw, playerZone('A', 'hand'))).toEqual([]);
    expect(objectsIn(atDraw, playerZone('A', 'library'))).toHaveLength(10);
  });

  it('has the player on the draw draw on their first turn', () => {
    const { state, emitter } = setup();
    let current = startFirstTurn(state, emitter);
    while (current.turn === 1) current = advanceStep(current, emitter);
    while (current.step !== 'draw') current = advanceStep(current, emitter);
    expect(objectsIn(current, playerZone('B', 'hand'))).toHaveLength(1);
  });

  it('draws from the top of the library', () => {
    const { state, emitter } = setup(10, { onPlay: 'B' });
    const top = objectsIn(state, playerZone('B', 'library'))[0];
    const atDraw = drawUntilStep(state, emitter);
    // B is on the play here, so it skips; draw explicitly to check which card comes off.
    const drawn = drawCard(atDraw, emitter, 'B');
    expect(objectsIn(drawn, playerZone('B', 'hand'))).toEqual([top]);
  });

  it('emits a draw event naming the card', () => {
    const { state, emitter } = setup();
    const top = objectsIn(state, playerZone('A', 'library'))[0];
    drawCard(startFirstTurn(state, emitter), emitter, 'A');
    expect(emitter.events.at(-1)).toMatchObject({ type: 'draw', player: 'A', object: top });
  });
});

describe('drawing from an empty library (CR 120.3, 704.5b)', () => {
  it('flags the player rather than losing on the spot', () => {
    const { state, emitter } = setup(0);
    const started = startFirstTurn(state, emitter);
    const after = drawCard(started, emitter, 'A');
    expect(after.players.A.drewFromEmptyLibrary).toBe(true);
    expect(after.result).toBeNull();
  });

  it('draws no card and emits no draw event', () => {
    const { state, emitter } = setup(0);
    const started = startFirstTurn(state, emitter);
    const before = emitter.events.length;
    const after = drawCard(started, emitter, 'A');
    expect(objectsIn(after, playerZone('A', 'hand'))).toEqual([]);
    expect(emitter.events).toHaveLength(before);
  });

  it('stays flagged without churning state on a second attempt', () => {
    const { state, emitter } = setup(0);
    const first = drawCard(startFirstTurn(state, emitter), emitter, 'A');
    expect(drawCard(first, emitter, 'A')).toBe(first);
  });
});

describe('the cleanup step (CR 514)', () => {
  const runToCleanup = (state: GameState, emitter: EventEmitter, options = {}): GameState => {
    let current = startFirstTurn(state, emitter, options);
    while (current.step !== 'cleanup') current = advanceStep(current, emitter, options);
    return current;
  };

  it('removes all damage from permanents (CR 514.2)', () => {
    const { state, emitter } = setup();
    const damaged = putOnBattlefield(state, 'A', { damage: 3 });
    const other = putOnBattlefield(damaged.state, 'B', { damage: 1 });
    const cleaned = runToCleanup(other.state, emitter);
    expect(getObject(cleaned, damaged.id).damage).toBe(0);
    expect(getObject(cleaned, other.id).damage).toBe(0);
  });

  it('does nothing when the hand is within the limit', () => {
    const { state, emitter } = setup();
    const cleaned = runToCleanup(state, emitter);
    expect(objectsIn(cleaned, playerZone('A', 'graveyard'))).toEqual([]);
  });

  it('discards down to the maximum hand size (CR 514.1)', () => {
    const { state, emitter } = setup();
    let current = state;
    for (let i = 0; i < 9; i += 1) {
      current = createObject(current, {
        definitionId: card,
        owner: 'A',
        zone: playerZone('A', 'hand'),
      }).state;
    }
    const cleaned = runToCleanup(current, emitter, {
      chooseDiscards: (s: GameState, player: PlayerId, count: number) =>
        objectsIn(s, playerZone(player, 'hand')).slice(0, count),
    });
    expect(objectsIn(cleaned, playerZone('A', 'hand'))).toHaveLength(7);
    expect(objectsIn(cleaned, playerZone('A', 'graveyard'))).toHaveLength(2);
  });

  it('fails loudly rather than guessing which cards to discard', () => {
    const { state, emitter } = setup();
    let current = state;
    for (let i = 0; i < 8; i += 1) {
      current = createObject(current, {
        definitionId: card,
        owner: 'A',
        zone: playerZone('A', 'hand'),
      }).state;
    }
    expect(() => runToCleanup(current, emitter)).toThrow(/must discard 1 card/);
  });

  it('rejects a chooser that returns the wrong number of cards', () => {
    const { state, emitter } = setup();
    let current = state;
    for (let i = 0; i < 9; i += 1) {
      current = createObject(current, {
        definitionId: card,
        owner: 'A',
        zone: playerZone('A', 'hand'),
      }).state;
    }
    expect(() => runToCleanup(current, emitter, { chooseDiscards: () => [] })).toThrow(
      /expected 2/,
    );
  });

  it('rejects a chooser that names a card outside the hand', () => {
    const { state, emitter } = setup();
    let current = state;
    for (let i = 0; i < 8; i += 1) {
      current = createObject(current, {
        definitionId: card,
        owner: 'A',
        zone: playerZone('A', 'hand'),
      }).state;
    }
    const notInHand = objectsIn(current, playerZone('A', 'library'))[0];
    expect(() =>
      runToCleanup(current, emitter, { chooseDiscards: () => [notInHand as ObjectId] }),
    ).toThrow(/not in A's hand/);
  });

  it('honours a custom maximum hand size', () => {
    const { state, emitter } = setup(10, { maxHandSize: 3 });
    let current = state;
    for (let i = 0; i < 4; i += 1) {
      current = createObject(current, {
        definitionId: card,
        owner: 'A',
        zone: playerZone('A', 'hand'),
      }).state;
    }
    const cleaned = runToCleanup(current, emitter, {
      chooseDiscards: (s: GameState, player: PlayerId, count: number) =>
        objectsIn(s, playerZone(player, 'hand')).slice(0, count),
    });
    expect(objectsIn(cleaned, playerZone('A', 'hand'))).toHaveLength(3);
  });
});

describe('the turn cap', () => {
  it('ends the game as a draw once the cap is passed', () => {
    const { state, emitter } = setup(200, { turnCap: 3 });
    const finished = advanceUntilGameOver(startFirstTurn(state, emitter), emitter);
    expect(finished.result).toEqual({ winner: null, reason: 'turnCap', turn: 3 });
  });

  it('plays exactly turnCap turns', () => {
    const { state, emitter } = setup(200, { turnCap: 5 });
    const finished = advanceUntilGameOver(startFirstTurn(state, emitter), emitter);
    expect(finished.turn).toBe(5);
  });

  it('emits gameEnd once', () => {
    const { state, emitter } = setup(200, { turnCap: 2 });
    advanceUntilGameOver(startFirstTurn(state, emitter), emitter);
    const ends = emitter.events.filter((event) => event.type === 'gameEnd');
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ winner: null, reason: 'turnCap' });
  });

  it('is inert once the game is over', () => {
    const { state, emitter } = setup(200, { turnCap: 2 });
    const finished = advanceUntilGameOver(startFirstTurn(state, emitter), emitter);
    expect(advanceStep(finished, emitter)).toBe(finished);
  });
});

describe('extra turns (CR 500.7)', () => {
  it('gives the next turn to the player owed one', () => {
    const { state, emitter } = setup(60);
    let current = grantExtraTurn(startFirstTurn(state, emitter), 'A');
    while (current.turn === 1) current = advanceStep(current, emitter);
    expect(current).toMatchObject({ turn: 2, activePlayer: 'A' });
  });

  it('consumes the extra turn, so the turn after that is the opponent’s', () => {
    const { state, emitter } = setup(60);
    let current = grantExtraTurn(startFirstTurn(state, emitter), 'A');
    while (current.turn < 3) current = advanceStep(current, emitter);
    expect(current).toMatchObject({ turn: 3, activePlayer: 'B' });
    expect(current.extraTurns).toEqual([]);
  });

  it('queues several extra turns in order', () => {
    const { state, emitter } = setup(60);
    let current = grantExtraTurn(grantExtraTurn(startFirstTurn(state, emitter), 'A'), 'B');
    expect(current.extraTurns).toEqual(['A', 'B']);
    while (current.turn < 2) current = advanceStep(current, emitter);
    expect(current.activePlayer).toBe('A');
    while (current.turn < 3) current = advanceStep(current, emitter);
    expect(current.activePlayer).toBe('B');
  });
});

describe('the event stream', () => {
  it('stamps every event with the turn and step it happened in', () => {
    const { state, emitter } = setup();
    let current = startFirstTurn(state, emitter);
    while (current.turn === 1) current = advanceStep(current, emitter);

    for (const event of emitter.events) {
      expect(event.turn).toBeGreaterThanOrEqual(1);
      expect(typeof event.step).toBe('string');
    }
    expect(emitter.events.map((event) => event.seq)).toEqual(
      emitter.events.map((_event, index) => index),
    );
  });
});

describe('mana empties between steps (CR 500.4)', () => {
  it('clears both pools as the next step begins', () => {
    const { state, emitter } = setup();
    let current = startFirstTurn(state, emitter);
    current = updatePlayer(current, 'A', { manaPool: addMana(emptyManaPool, 'G', 2) });
    current = updatePlayer(current, 'B', { manaPool: addMana(emptyManaPool, 'U', 1) });

    const next = advanceStep(current, emitter);
    expect(next.players.A.manaPool).toEqual([]);
    expect(next.players.B.manaPool).toEqual([]);
  });

  it('leaves mana alone within the step that produced it', () => {
    const { state, emitter } = setup();
    const started = startFirstTurn(state, emitter);
    const withMana = updatePlayer(started, 'A', { manaPool: addMana(emptyManaPool, 'G', 2) });
    expect(withMana.players.A.manaPool).toHaveLength(2);
  });

  it('is empty again after a turn rolls over', () => {
    const { state, emitter } = setup();
    let current = updatePlayer(startFirstTurn(state, emitter), 'A', {
      manaPool: addMana(emptyManaPool, 'G', 2),
    });
    while (current.turn === 1) current = advanceStep(current, emitter);
    expect(current.players.A.manaPool).toEqual([]);
  });
});
