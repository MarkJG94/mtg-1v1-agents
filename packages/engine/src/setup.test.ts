import { asOracleId, type ObjectId, type PlayerId, playerIds, playerZone } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import type { Decision, DecisionResponse } from './decision.js';
import { createEventEmitter, type EventEmitter } from './events/emitter.js';
import { concede, playerLosesGame, playerWinsGame } from './game-end.js';
import { hashState } from './loop.js';
import { stateFromSeed } from './rng.js';
import { MulliganError, setUpGame } from './setup.js';
import {
  type CreateGameStateOptions,
  createGameState,
  type GameState,
} from './state/game-state.js';
import { createObject, objectsIn } from './state/update.js';
import { playRandomGame } from './testing/index.js';
import { applyDecision, runUntilGameOver } from './turn/turn.js';

const card = asOracleId('oracle-card');

const withLibraries = (
  size = 40,
  options: Partial<CreateGameStateOptions> = {},
): { state: GameState; emitter: EventEmitter } => {
  let state = createGameState({ rng: stateFromSeed('1'), onPlay: 'A', ...options });
  for (const player of playerIds) {
    for (let i = 0; i < size; i += 1) {
      state = createObject(state, {
        definitionId: card,
        owner: player,
        zone: playerZone(player, 'library'),
      }).state;
    }
  }
  return { state, emitter: createEventEmitter() };
};

const handOf = (state: GameState, player: PlayerId): readonly ObjectId[] =>
  objectsIn(state, playerZone(player, 'hand'));

const answer = (state: GameState, emitter: EventEmitter, response: DecisionResponse): GameState =>
  applyDecision(state, emitter, response);

const keep = (state: GameState, emitter: EventEmitter): GameState =>
  answer(state, emitter, { kind: 'mulligan', action: 'keep' });

const mulligan = (state: GameState, emitter: EventEmitter): GameState =>
  answer(state, emitter, { kind: 'mulligan', action: 'mulligan' });

const pendingKind = (state: GameState): Decision['kind'] | undefined => state.pendingDecision?.kind;

describe('setting up (CR 103)', () => {
  it('deals seven to each player and asks the player on the play first', () => {
    const { state, emitter } = withLibraries();
    const set = setUpGame(state, emitter);

    expect(handOf(set, 'A')).toHaveLength(7);
    expect(handOf(set, 'B')).toHaveLength(7);
    expect(objectsIn(set, playerZone('A', 'library'))).toHaveLength(33);
    expect(set.pendingDecision).toMatchObject({ kind: 'mulligan', player: 'A', taken: 0 });
  });

  it('asks the other player once the first has declared, before any mulligan is taken', () => {
    const { state, emitter } = withLibraries();
    const asked = mulligan(setUpGame(state, emitter), emitter);

    expect(asked.pendingDecision).toMatchObject({ kind: 'mulligan', player: 'B', taken: 0 });
    // A said mulligan but has not taken it yet: the hand is still the first seven.
    expect(asked.mulligans?.taken.A).toBe(0);
    expect(asked.mulligans?.mulliganing).toEqual(['A']);
  });

  it('shuffles with the game’s own generator, so the same seed deals the same hands', () => {
    const first = withLibraries();
    const second = withLibraries();
    expect(handOf(setUpGame(first.state, first.emitter), 'A')).toEqual(
      handOf(setUpGame(second.state, second.emitter), 'A'),
    );

    const other = withLibraries(40, { rng: stateFromSeed('2') });
    expect(handOf(setUpGame(other.state, other.emitter), 'A')).not.toEqual(
      handOf(setUpGame(first.state, first.emitter), 'A'),
    );
  });

  it('refuses to set up a game that has already started', () => {
    const { state, emitter } = withLibraries();
    expect(() => setUpGame({ ...state, turn: 3 }, emitter)).toThrow(MulliganError);
  });
});

describe('the London mulligan (CR 103.4)', () => {
  /** A always mulligans `times`, B always keeps. Stops at the first bottoming decision. */
  const mulliganTimes = (times: number) => {
    const { state, emitter } = withLibraries();
    let current = setUpGame(state, emitter);

    for (let round = 0; round < times; round += 1) {
      current = mulligan(current, emitter); // A
      if (round === 0) current = keep(current, emitter); // B, only asked once
    }
    current = keep(current, emitter); // A finally keeps
    return { state: current, emitter };
  };

  it('draws a fresh seven every time rather than one fewer', () => {
    const { state } = mulliganTimes(2);
    // Still seven in hand; the price is paid by bottoming, not by drawing less.
    expect(handOf(state, 'A')).toHaveLength(7);
    expect(state.pendingDecision).toMatchObject({ kind: 'bottomCards', player: 'A', count: 2 });
  });

  it('puts one card on the bottom per mulligan taken, in the chosen order', () => {
    const { state, emitter } = mulliganTimes(2);
    const hand = handOf(state, 'A');
    const [first, second] = [hand[1], hand[3]];
    if (first === undefined || second === undefined) throw new Error('hand too small');

    const kept = answer(state, emitter, { kind: 'bottomCards', cards: [first, second] });
    expect(handOf(kept, 'A')).toHaveLength(5);

    const library = objectsIn(kept, playerZone('A', 'library'));
    expect(library.slice(-2)).toEqual([first, second]);
  });

  it('asks nobody to bottom anything when neither player mulliganed', () => {
    const { state, emitter } = withLibraries();
    let current = keep(setUpGame(state, emitter), emitter);
    current = keep(current, emitter);

    expect(pendingKind(current)).not.toBe('bottomCards');
    expect(handOf(current, 'A')).toHaveLength(7);
    expect(current.mulligans).toBeNull();
  });

  it('begins turn 1 once the hands are settled', () => {
    const { state, emitter } = withLibraries();
    let current = keep(setUpGame(state, emitter), emitter);
    current = keep(current, emitter);

    expect(current.turn).toBe(1);
    expect(current.activePlayer).toBe('A');
    expect(current.pendingDecision).toMatchObject({ kind: 'priority' });
  });

  it('stops offering a mulligan at the cap', () => {
    const { state, emitter } = withLibraries(40, { maxMulligans: 1 });
    let current = mulligan(setUpGame(state, emitter), emitter);
    current = keep(current, emitter); // B keeps

    expect(current.pendingDecision).toMatchObject({
      kind: 'mulligan',
      player: 'A',
      taken: 1,
      options: ['keep'],
    });
    expect(() => mulligan(current, emitter)).toThrow(MulliganError);
  });

  it('refuses a bottoming that is the wrong size or names a card not in hand', () => {
    const { state, emitter } = mulliganTimes(1);
    const hand = handOf(state, 'A');
    const one = hand[0];
    const notMine = objectsIn(state, playerZone('B', 'hand'))[0];
    if (one === undefined || notMine === undefined) throw new Error('missing cards');

    expect(() => answer(state, emitter, { kind: 'bottomCards', cards: [] })).toThrow(MulliganError);
    expect(() => answer(state, emitter, { kind: 'bottomCards', cards: [notMine] })).toThrow(
      MulliganError,
    );
  });

  it('logs a mulligan and a keep for each player', () => {
    const events: string[] = [];
    const emitter = createEventEmitter({
      onEvent: (event) => {
        if (event.type === 'mulligan' || event.type === 'keep') events.push(event.type);
      },
    });
    let current = setUpGame(withLibraries().state, emitter);
    current = mulligan(current, emitter);
    current = keep(current, emitter); // B keeps, 0 taken, logged now
    current = keep(current, emitter); // A keeps after one mulligan
    const hand = handOf(current, 'A');
    const one = hand[0];
    if (one === undefined) throw new Error('hand too small');
    answer(current, emitter, { kind: 'bottomCards', cards: [one] });

    expect(events).toEqual(['keep', 'mulligan', 'keep']);
  });
});

describe('game end (CR 104)', () => {
  const started = () => {
    const { state, emitter } = withLibraries();
    let current = keep(setUpGame(state, emitter), emitter);
    current = keep(current, emitter);
    return { state: current, emitter };
  };

  it('gives the win to the opponent when a player concedes', () => {
    const { state, emitter } = started();
    const ended = concede(state, emitter, 'A');
    expect(ended.result).toMatchObject({ winner: 'B', reason: 'concede' });
    expect(ended.pendingDecision).toBeNull();
  });

  it('records an effect that makes a player lose or win outright', () => {
    const { state, emitter } = started();
    expect(playerLosesGame(state, emitter, 'B').result).toMatchObject({
      winner: 'A',
      reason: 'effect',
    });
    expect(playerWinsGame(state, emitter, 'B').result).toMatchObject({
      winner: 'B',
      reason: 'effect',
    });
  });

  it('keeps the first ending rather than letting a second overwrite it', () => {
    const { state, emitter } = started();
    const conceded = concede(state, emitter, 'A');
    expect(playerWinsGame(conceded, emitter, 'A').result).toMatchObject({ reason: 'concede' });
  });

  it('ends an unfinished game as a draw at the turn cap', () => {
    const { state, emitter } = withLibraries(40, { turnCap: 2 });
    let current = keep(setUpGame(state, emitter), emitter);
    current = keep(current, emitter);

    const finished = runUntilGameOver(current, emitter);
    expect(finished.result).toMatchObject({ winner: null, reason: 'turnCap' });
  });
});

describe('loop detection (CR 726) and the decision cap', () => {
  const started = (options: Partial<CreateGameStateOptions> = {}) => {
    const { state, emitter } = withLibraries(40, options);
    let current = keep(setUpGame(state, emitter), emitter);
    current = keep(current, emitter);
    return { state: current, emitter };
  };

  it('hashes two structurally identical states the same and different ones differently', () => {
    const a = started().state;
    const b = started().state;
    expect(hashState(a)).toBe(hashState(b));
    expect(hashState({ ...a, passesInARow: a.passesInARow + 1 })).not.toBe(hashState(a));
    expect(hashState({ ...a, step: 'end' })).not.toBe(hashState(a));
  });

  /**
   * Ordinary play must never trip the detector. Passing priority back and forth advances
   * the step, the pass count and eventually the turn, so no position recurs.
   */
  it('does not call an ordinary game a loop', () => {
    const { state, emitter } = started({ turnCap: 4 });
    const finished = runUntilGameOver(state, emitter);
    expect(finished.result?.reason).toBe('turnCap');
  });

  /**
   * Prime the turn with the hash of the position the engine is about to reach, so that
   * reaching it is a genuine repeat rather than a hash poked in at random.
   */
  const primedWithNextPosition = (options: Partial<CreateGameStateOptions> = {}) => {
    // `loopCheckAfter: 0` puts the detector on watch immediately; the default waits for a
    // turn longer than any ordinary one, which these two-decision cases are not.
    const { state, emitter } = started({ loopCheckAfter: 0, ...options });
    const reached = applyDecision(state, emitter, {
      kind: 'priority',
      action: { kind: 'pass' },
    });
    return {
      state: { ...state, statesThisTurn: [hashState(reached)] },
      emitter,
    };
  };

  it('ends the game as a draw when a state repeats within a turn', () => {
    const { state, emitter } = primedWithNextPosition();
    const finished = runUntilGameOver(state, emitter, { limit: 50 });
    expect(finished.result).toMatchObject({ winner: null, reason: 'loop' });
    expect(finished.turn).toBe(1);
  });

  it('leaves the game alone when loop detection is switched off', () => {
    const { state, emitter } = primedWithNextPosition({ detectLoops: false, turnCap: 2 });
    const finished = runUntilGameOver(state, emitter);
    expect(finished.result?.reason).toBe('turnCap');
  });

  /**
   * The projection has to separate positions that differ only in combat. Ordering the
   * blockers on one attacker changes nothing else at all, so when this was missing, a
   * turn with two multiply-blocked attackers looked like a position repeating and the
   * game was called a draw. The 1.14 benchmarks found it: 36% of the wider boards ended
   * that way. See ADR 0005.
   */
  it('tells two positions apart when only the damage-assignment order differs', () => {
    const base = started().state;
    const [attacker, first, second] = objectsIn(base, playerZone('A', 'library'));
    if (attacker === undefined || first === undefined || second === undefined) {
      throw new Error('expected a library to draw three object ids from');
    }

    const withOrder = (blockedBy: readonly ObjectId[]): GameState => ({
      ...base,
      combat: {
        attackers: [
          {
            attacker,
            defender: { kind: 'player', player: 'B' },
            blockedBy,
            blocked: true,
            orderSettled: true,
          },
        ],
        firstStrikeDone: false,
      },
    });

    expect(hashState(withOrder([first, second]))).not.toBe(hashState(withOrder([second, first])));
    expect(hashState(withOrder([first, second]))).not.toBe(hashState(base));
  });

  /**
   * Which is the other half of the same fix: watching only long turns must not change
   * which games end how. If the projection is complete, a detector that watches every
   * position finds nothing a deferred one misses — in games this size, no loop at all.
   */
  it('ends the same games the same way whether every position is watched or only long turns', () => {
    for (let i = 0; i < 8; i += 1) {
      const options = { creatures: 8, librarySize: 25, turnCap: 12 };
      const eager = playRandomGame(`loops-${i}`, { ...options, loopCheckAfter: 0 });
      const deferred = playRandomGame(`loops-${i}`, options);

      expect(deferred.state.result).toEqual(eager.state.result);
      expect(deferred.decisions.length).toBe(eager.decisions.length);
    }
  });

  it('leaves a turn shorter than any real loop unhashed', () => {
    const { state, emitter } = started({ loopCheckAfter: 4 });
    let current = state;
    for (let i = 0; i < 4; i += 1) {
      expect(current.statesThisTurn).toEqual([]);
      current = answer(current, emitter, { kind: 'priority', action: { kind: 'pass' } });
    }

    expect(current.decisionsThisTurn).toBeGreaterThanOrEqual(4);
    expect(current.statesThisTurn).not.toEqual([]);
  });

  it('draws at the decision cap', () => {
    const { state, emitter } = started({ decisionCap: 3, detectLoops: false });
    const finished = runUntilGameOver(state, emitter);
    expect(finished.result).toMatchObject({ winner: null, reason: 'decisionCap' });
    expect(finished.decisionsMade).toBeLessThanOrEqual(3);
  });
});
