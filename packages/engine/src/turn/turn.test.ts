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
import { type Keywords, keywords } from '../targeting.js';
import {
  applyDecision,
  drawCard,
  grantExtraTurn,
  nextStep,
  runUntilGameOver,
  startGame,
} from './turn.js';

const card = asOracleId('oracle-card');

/** Answer the pending priority decision by passing. */
const pass = (state: GameState, emitter: EventEmitter): GameState =>
  applyDecision(state, emitter, { kind: 'priority', action: { kind: 'pass' } });

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

const addToHand = (state: GameState, player: PlayerId, count: number): GameState => {
  let current = state;
  for (let i = 0; i < count; i += 1) {
    current = createObject(current, {
      definitionId: card,
      owner: player,
      zone: playerZone(player, 'hand'),
    }).state;
  }
  return current;
};

/** Pass priority until the turn number changes. */
const passThroughTurn = (state: GameState, emitter: EventEmitter): GameState => {
  let current = state;
  const startingTurn = current.turn;
  while (current.turn === startingTurn && !current.result) current = pass(current, emitter);
  return current;
};

describe('starting the game', () => {
  it('stops at the first step where a player gets priority', () => {
    const { state, emitter } = setup();
    const started = startGame(state, emitter);
    // Untap gives nobody priority (CR 502.3), so the first stop is upkeep.
    expect(started).toMatchObject({ turn: 1, activePlayer: 'A', step: 'upkeep' });
    expect(started.pendingDecision).toEqual({
      kind: 'priority',
      player: 'A',
      options: [{ kind: 'pass' }],
    });
  });

  it('gives the first turn and the first priority to the player on the play', () => {
    const { state, emitter } = setup(10, { onPlay: 'B' });
    const started = startGame(state, emitter);
    expect(started.activePlayer).toBe('B');
    expect(started.priority).toBe('B');
  });

  it('emits turnStart and the untap and upkeep stepStarts before stopping', () => {
    const { state, emitter } = setup();
    startGame(state, emitter);
    expect(emitter.events.map((event) => event.type)).toEqual([
      'turnStart',
      'stepStart',
      'stepStart',
    ]);
  });

  it('refuses to start twice', () => {
    const { state, emitter } = setup();
    expect(() => startGame(startGame(state, emitter), emitter)).toThrow(/already started/);
  });
});

describe('the sequence of steps (CR 500)', () => {
  it('walks the steps of a turn with no attack, skipping blockers and damage (CR 506.5)', () => {
    const { state, emitter } = setup();
    passThroughTurn(startGame(state, emitter), emitter);

    const walked = emitter.events
      .filter((event) => event.type === 'stepStart' && event.turn === 1)
      .map((event) => event.step);
    // Nobody attacked, so the declare blockers and combat damage steps do not happen.
    expect(walked).toEqual([
      'untap',
      'upkeep',
      'draw',
      'precombatMain',
      'beginCombat',
      'declareAttackers',
      'endCombat',
      'postcombatMain',
      'end',
      'cleanup',
    ]);
  });

  it('never reaches the first-strike damage step with nobody in combat (CR 510.4)', () => {
    const { state, emitter } = setup();
    passThroughTurn(startGame(state, emitter), emitter);
    const walked = emitter.events.filter((event) => event.type === 'stepStart').map((e) => e.step);
    expect(walked).not.toContain('firstStrikeDamage');
    expect(nextStep(state, 'declareBlockers')).toBe('endCombat');
  });

  it('reports no next step after cleanup', () => {
    const { state } = setup();
    expect(nextStep(state, 'cleanup')).toBeNull();
  });

  it('never rests in a step that gives no priority', () => {
    const { state, emitter } = setup();
    let current = startGame(state, emitter);
    for (let i = 0; i < 40; i += 1) {
      expect(current.step).not.toBe('untap');
      expect(current.step).not.toBe('cleanup');
      current = pass(current, emitter);
    }
  });
});

describe('priority (CR 117)', () => {
  it('gives the active player priority first in each step (CR 117.3a)', () => {
    const { state, emitter } = setup();
    expect(startGame(state, emitter).priority).toBe('A');
  });

  it('passes priority to the opponent on a pass', () => {
    const { state, emitter } = setup();
    expect(pass(startGame(state, emitter), emitter).priority).toBe('B');
  });

  it('ends the step when both players pass in succession (CR 117.4)', () => {
    const { state, emitter } = setup();
    const started = startGame(state, emitter);
    expect(started.step).toBe('upkeep');
    const bothPassed = pass(pass(started, emitter), emitter);
    expect(bothPassed.step).toBe('draw');
    expect(bothPassed.priority).toBe('A');
  });

  it('resets the pass count when the step changes', () => {
    const { state, emitter } = setup();
    const bothPassed = pass(pass(startGame(state, emitter), emitter), emitter);
    expect(bothPassed.passesInARow).toBe(0);
  });

  it('refuses a decision when none is pending', () => {
    const { state, emitter } = setup();
    const started = startGame(state, emitter);
    const noDecision = { ...started, pendingDecision: null };
    expect(() => pass(noDecision, emitter)).toThrow(/no decision is pending/);
  });

  it('refuses an answer of the wrong kind', () => {
    const { state, emitter } = setup();
    const started = startGame(state, emitter);
    expect(() => applyDecision(started, emitter, { kind: 'discard', cards: [] })).toThrow(
      /pending decision is "priority"/,
    );
  });
});

describe('turn rollover', () => {
  it('passes the turn to the opponent after cleanup', () => {
    const { state, emitter } = setup();
    const next = passThroughTurn(startGame(state, emitter), emitter);
    expect(next).toMatchObject({ turn: 2, activePlayer: 'B', step: 'upkeep' });
  });

  it('alternates players across several turns', () => {
    const { state, emitter } = setup(60);
    let current = startGame(state, emitter);
    const active: PlayerId[] = [current.activePlayer];
    while (current.turn < 5) {
      current = passThroughTurn(current, emitter);
      active.push(current.activePlayer);
    }
    expect(active).toEqual(['A', 'B', 'A', 'B', 'A']);
  });

  it('resets land drops for both players each turn', () => {
    const { state, emitter } = setup();
    let current = startGame(state, emitter);
    current = updatePlayer(current, 'A', { landsPlayedThisTurn: 1 });
    current = updatePlayer(current, 'B', { landsPlayedThisTurn: 1 });
    current = passThroughTurn(current, emitter);
    expect(current.players.A.landsPlayedThisTurn).toBe(0);
    expect(current.players.B.landsPlayedThisTurn).toBe(0);
  });
});

describe('the untap step (CR 502)', () => {
  it('untaps the permanents the active player controls', () => {
    const { state, emitter } = setup();
    const mine = putOnBattlefield(state, 'A', { tapped: true });
    expect(getObject(startGame(mine.state, emitter), mine.id).tapped).toBe(false);
  });

  it('leaves the opponent’s permanents tapped', () => {
    const { state, emitter } = setup();
    const theirs = putOnBattlefield(state, 'B', { tapped: true });
    expect(getObject(startGame(theirs.state, emitter), theirs.id).tapped).toBe(true);
  });

  it('clears summoning sickness for the active player (CR 302.6)', () => {
    const { state, emitter } = setup();
    const mine = putOnBattlefield(state, 'A', { summoningSick: true });
    expect(getObject(startGame(mine.state, emitter), mine.id).summoningSick).toBe(false);
  });

  it('leaves the opponent’s creatures summoning sick', () => {
    const { state, emitter } = setup();
    const theirs = putOnBattlefield(state, 'B', { summoningSick: true });
    expect(getObject(startGame(theirs.state, emitter), theirs.id).summoningSick).toBe(true);
  });

  it('emits an untap event per permanent actually untapped', () => {
    const { state, emitter } = setup();
    const tapped = putOnBattlefield(state, 'A', { tapped: true });
    const untappedAlready = putOnBattlefield(tapped.state, 'A');
    startGame(untappedAlready.state, emitter);
    const untaps = emitter.events.filter((event) => event.type === 'untap');
    expect(untaps).toHaveLength(1);
    expect(untaps[0]).toMatchObject({ object: tapped.id });
  });
});

describe('the draw step (CR 504)', () => {
  it('lets the player on the play skip their first draw (CR 103.7a)', () => {
    const { state, emitter } = setup();
    let current = startGame(state, emitter);
    while (current.step !== 'precombatMain') current = pass(current, emitter);
    expect(objectsIn(current, playerZone('A', 'hand'))).toEqual([]);
    expect(objectsIn(current, playerZone('A', 'library'))).toHaveLength(10);
  });

  it('has the player on the draw draw on their first turn', () => {
    const { state, emitter } = setup();
    let current = passThroughTurn(startGame(state, emitter), emitter);
    while (current.step !== 'precombatMain') current = pass(current, emitter);
    expect(objectsIn(current, playerZone('B', 'hand'))).toHaveLength(1);
  });

  it('draws from the top of the library', () => {
    const { state, emitter } = setup();
    const top = objectsIn(state, playerZone('A', 'library'))[0];
    const drawn = drawCard(startGame(state, emitter), emitter, 'A');
    expect(objectsIn(drawn, playerZone('A', 'hand'))).toEqual([top]);
  });

  it('emits a draw event naming the card', () => {
    const { state, emitter } = setup();
    const top = objectsIn(state, playerZone('A', 'library'))[0];
    drawCard(startGame(state, emitter), emitter, 'A');
    expect(emitter.events.at(-1)).toMatchObject({ type: 'draw', player: 'A', object: top });
  });
});

describe('drawing from an empty library (CR 120.3, 704.5b)', () => {
  it('flags the player rather than losing on the spot', () => {
    const { state, emitter } = setup(0);
    const after = drawCard(startGame(state, emitter), emitter, 'A');
    expect(after.players.A.drewFromEmptyLibrary).toBe(true);
    expect(after.result).toBeNull();
  });

  it('draws no card and emits no draw event', () => {
    const { state, emitter } = setup(0);
    const started = startGame(state, emitter);
    const before = emitter.events.length;
    const after = drawCard(started, emitter, 'A');
    expect(objectsIn(after, playerZone('A', 'hand'))).toEqual([]);
    expect(emitter.events).toHaveLength(before);
  });

  it('stays flagged without churning state on a second attempt', () => {
    const { state, emitter } = setup(0);
    const first = drawCard(startGame(state, emitter), emitter, 'A');
    expect(drawCard(first, emitter, 'A')).toBe(first);
  });
});

describe('the cleanup step (CR 514)', () => {
  it('removes all damage from permanents (CR 514.2)', () => {
    const { state, emitter } = setup();
    const damaged = putOnBattlefield(state, 'A', { damage: 3 });
    const other = putOnBattlefield(damaged.state, 'B', { damage: 1 });
    const nextTurn = passThroughTurn(startGame(other.state, emitter), emitter);
    expect(getObject(nextTurn, damaged.id).damage).toBe(0);
    expect(getObject(nextTurn, other.id).damage).toBe(0);
  });

  it('runs straight through when the hand is within the limit', () => {
    const { state, emitter } = setup();
    const nextTurn = passThroughTurn(startGame(state, emitter), emitter);
    expect(objectsIn(nextTurn, playerZone('A', 'graveyard'))).toEqual([]);
    expect(nextTurn.turn).toBe(2);
  });

  it('stops for a discard decision when the hand is too big (CR 514.1)', () => {
    const { state, emitter } = setup();
    const full = addToHand(state, 'A', 9);
    let current = startGame(full, emitter);
    while (current.pendingDecision?.kind !== 'discard') current = pass(current, emitter);

    expect(current.step).toBe('cleanup');
    expect(current.pendingDecision).toMatchObject({ kind: 'discard', player: 'A', count: 2 });
    expect(current.pendingDecision?.from).toHaveLength(9);
  });

  it('discards the chosen cards and carries on', () => {
    const { state, emitter } = setup();
    const full = addToHand(state, 'A', 9);
    let current = startGame(full, emitter);
    while (current.pendingDecision?.kind !== 'discard') current = pass(current, emitter);

    const chosen = current.pendingDecision.from.slice(0, 2);
    const after = applyDecision(current, emitter, { kind: 'discard', cards: chosen });
    expect(objectsIn(after, playerZone('A', 'hand'))).toHaveLength(7);
    expect(objectsIn(after, playerZone('A', 'graveyard'))).toEqual(chosen);
    expect(after.turn).toBe(2);
  });

  it('rejects the wrong number of cards', () => {
    const { state, emitter } = setup();
    const full = addToHand(state, 'A', 9);
    let current = startGame(full, emitter);
    while (current.pendingDecision?.kind !== 'discard') current = pass(current, emitter);
    expect(() => applyDecision(current, emitter, { kind: 'discard', cards: [] })).toThrow(
      /expected 2 card/,
    );
  });

  it('rejects a card that is not in hand', () => {
    const { state, emitter } = setup();
    const full = addToHand(state, 'A', 9);
    let current = startGame(full, emitter);
    while (current.pendingDecision?.kind !== 'discard') current = pass(current, emitter);
    const notInHand = objectsIn(current, playerZone('A', 'library'))[0];
    expect(() =>
      applyDecision(current, emitter, {
        kind: 'discard',
        cards: [notInHand as ObjectId, notInHand as ObjectId],
      }),
    ).toThrow(/not in A's hand/);
  });

  it('honours a custom maximum hand size', () => {
    const { state, emitter } = setup(10, { maxHandSize: 3 });
    const full = addToHand(state, 'A', 4);
    let current = startGame(full, emitter);
    while (current.pendingDecision?.kind !== 'discard') current = pass(current, emitter);
    expect(current.pendingDecision).toMatchObject({ count: 1 });
  });
});

describe('the turn cap', () => {
  it('ends the game as a draw once the cap is passed', () => {
    const { state, emitter } = setup(200, { turnCap: 3 });
    const finished = runUntilGameOver(startGame(state, emitter), emitter);
    expect(finished.result).toEqual({ winner: null, reason: 'turnCap', turn: 3 });
  });

  it('plays exactly turnCap turns', () => {
    const { state, emitter } = setup(200, { turnCap: 5 });
    expect(runUntilGameOver(startGame(state, emitter), emitter).turn).toBe(5);
  });

  it('emits gameEnd once', () => {
    const { state, emitter } = setup(200, { turnCap: 2 });
    runUntilGameOver(startGame(state, emitter), emitter);
    const ends = emitter.events.filter((event) => event.type === 'gameEnd');
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ winner: null, reason: 'turnCap' });
  });

  it('leaves no decision pending once the game is over', () => {
    const { state, emitter } = setup(200, { turnCap: 2 });
    const finished = runUntilGameOver(startGame(state, emitter), emitter);
    expect(finished.pendingDecision).toBeNull();
  });

  it('handles discards along the way', () => {
    const { state, emitter } = setup(200, { turnCap: 12 });
    const finished = runUntilGameOver(startGame(state, emitter), emitter);
    expect(finished.result?.reason).toBe('turnCap');
    expect(objectsIn(finished, playerZone('B', 'hand')).length).toBeLessThanOrEqual(7);
  });
});

describe('extra turns (CR 500.7)', () => {
  it('gives the next turn to the player owed one', () => {
    const { state, emitter } = setup(60);
    const current = passThroughTurn(grantExtraTurn(startGame(state, emitter), 'A'), emitter);
    expect(current).toMatchObject({ turn: 2, activePlayer: 'A' });
  });

  it('consumes the extra turn, so the turn after that is the opponent’s', () => {
    const { state, emitter } = setup(60);
    let current = passThroughTurn(grantExtraTurn(startGame(state, emitter), 'A'), emitter);
    current = passThroughTurn(current, emitter);
    expect(current).toMatchObject({ turn: 3, activePlayer: 'B' });
    expect(current.extraTurns).toEqual([]);
  });

  it('queues several extra turns in order', () => {
    const { state, emitter } = setup(60);
    let current = grantExtraTurn(grantExtraTurn(startGame(state, emitter), 'A'), 'B');
    expect(current.extraTurns).toEqual(['A', 'B']);
    current = passThroughTurn(current, emitter);
    expect(current.activePlayer).toBe('A');
    current = passThroughTurn(current, emitter);
    expect(current.activePlayer).toBe('B');
  });
});

describe('mana empties between steps (CR 500.4)', () => {
  it('clears both pools as the next step begins', () => {
    const { state, emitter } = setup();
    let current = startGame(state, emitter);
    current = updatePlayer(current, 'A', { manaPool: addMana(emptyManaPool, 'G', 2) });
    current = updatePlayer(current, 'B', { manaPool: addMana(emptyManaPool, 'U', 1) });

    const next = pass(pass(current, emitter), emitter);
    expect(next.players.A.manaPool).toEqual([]);
    expect(next.players.B.manaPool).toEqual([]);
  });

  it('leaves mana alone within the step that produced it', () => {
    const { state, emitter } = setup();
    const withMana = updatePlayer(startGame(state, emitter), 'A', {
      manaPool: addMana(emptyManaPool, 'G', 2),
    });
    expect(withMana.players.A.manaPool).toHaveLength(2);
    // One pass moves priority but does not end the step.
    expect(pass(withMana, emitter).players.A.manaPool).toHaveLength(2);
  });
});

describe('the event stream', () => {
  it('numbers events in order and stamps each with its turn and step', () => {
    const { state, emitter } = setup();
    passThroughTurn(startGame(state, emitter), emitter);
    expect(emitter.events.map((event) => event.seq)).toEqual(
      emitter.events.map((_event, index) => index),
    );
    for (const event of emitter.events) expect(event.turn).toBeGreaterThanOrEqual(1);
  });
});

describe('combat through the decision flow', () => {
  /** A game at A's declare-attackers step with the given creatures in play. */
  const withCreatures = (
    a: readonly { power: number; toughness: number; keys?: Partial<Keywords> }[],
    b: readonly { power: number; toughness: number; keys?: Partial<Keywords> }[] = [],
  ) => {
    const built = setup();
    let state = built.state;
    const mine: ObjectId[] = [];
    const theirs: ObjectId[] = [];
    for (const [owner, specs, into] of [
      ['A', a, mine],
      ['B', b, theirs],
    ] as const) {
      for (const spec of specs) {
        const created = createObject(state, {
          definitionId: card,
          owner,
          zone: 'battlefield',
          power: spec.power,
          toughness: spec.toughness,
          keywords: keywords(spec.keys ?? {}),
        });
        state = created.state;
        into.push(created.object.id);
      }
    }

    const emitter = built.emitter;
    let current = startGame(state, emitter);
    while (current.pendingDecision?.kind !== 'declareAttackers') current = pass(current, emitter);
    return { state: current, emitter, mine, theirs };
  };

  /** Pass priority until the named decision comes up. */
  const untilDecision = (state: GameState, emitter: EventEmitter, kind: string): GameState => {
    let current = state;
    for (let i = 0; i < 50; i += 1) {
      if (current.pendingDecision?.kind === kind) return current;
      current = pass(current, emitter);
    }
    throw new Error(`never reached a ${kind} decision`);
  };

  const attackWithAll = (
    state: GameState,
    emitter: EventEmitter,
    attackers: readonly ObjectId[],
  ): GameState =>
    applyDecision(state, emitter, {
      kind: 'declareAttackers',
      attackers: attackers.map((attacker) => ({
        attacker,
        defender: { kind: 'player', player: 'B' } as const,
      })),
    });

  it('asks the active player to declare attackers', () => {
    const { state, mine } = withCreatures([{ power: 2, toughness: 2 }]);
    expect(state.pendingDecision).toMatchObject({
      kind: 'declareAttackers',
      player: 'A',
      legal: mine,
      defender: { kind: 'player', player: 'B' },
    });
  });

  it('lets the player decline to attack, skipping blockers and damage', () => {
    const { state, emitter } = withCreatures([{ power: 2, toughness: 2 }]);
    let current = applyDecision(state, emitter, { kind: 'declareAttackers', attackers: [] });
    // Players still get priority in the declare-attackers step (CR 508.2).
    expect(current.step).toBe('declareAttackers');
    current = passThroughTurn(current, emitter);

    const walked = emitter.events
      .filter((event) => event.type === 'stepStart' && event.turn === 1)
      .map((event) => event.step);
    expect(walked).not.toContain('declareBlockers');
    expect(walked).not.toContain('combatDamage');
    expect(current.players.B.life).toBe(20);
  });

  it('asks the defender to block once an attack is declared', () => {
    const { state, emitter, mine } = withCreatures(
      [{ power: 2, toughness: 2 }],
      [{ power: 1, toughness: 1 }],
    );
    const attacked = attackWithAll(state, emitter, [mine[0] as ObjectId]);
    const blocking = untilDecision(attacked, emitter, 'declareBlockers');
    expect(blocking.pendingDecision).toMatchObject({ kind: 'declareBlockers', player: 'B' });
  });

  it('carries an unblocked attack through to the player’s life total', () => {
    const { state, emitter, mine } = withCreatures([{ power: 3, toughness: 3 }]);
    let current = attackWithAll(state, emitter, [mine[0] as ObjectId]);
    // Nobody can block, so the game runs on to the damage step by itself.
    while (current.step !== 'endCombat' && !current.result) current = pass(current, emitter);
    expect(current.players.B.life).toBe(17);
  });

  it('walks all twelve steps when a first striker attacks', () => {
    const { state, emitter, mine } = withCreatures([
      { power: 2, toughness: 2, keys: { firstStrike: true } },
    ]);
    let current = attackWithAll(state, emitter, [mine[0] as ObjectId]);
    current = passThroughTurn(current, emitter);

    const walked = emitter.events
      .filter((event) => event.type === 'stepStart' && event.turn === 1)
      .map((event) => event.step);
    // Every step happens, including the first-strike damage step: thirteen in all.
    expect(walked).toContain('firstStrikeDamage');
    expect(walked).toHaveLength(13);
  });

  it('asks for a damage-assignment order on a double block', () => {
    const { state, emitter, mine, theirs } = withCreatures(
      [{ power: 3, toughness: 3 }],
      [
        { power: 1, toughness: 1 },
        { power: 1, toughness: 1 },
      ],
    );
    const attacked = attackWithAll(state, emitter, [mine[0] as ObjectId]);
    const blocking = untilDecision(attacked, emitter, 'declareBlockers');
    const blocked = applyDecision(blocking, emitter, {
      kind: 'declareBlockers',
      blocks: theirs.map((blocker) => ({ blocker, blocking: [mine[0] as ObjectId] })),
    });
    expect(blocked.pendingDecision).toMatchObject({
      kind: 'orderBlockers',
      player: 'A',
      attacker: mine[0],
    });

    const order = [theirs[1] as ObjectId, theirs[0] as ObjectId];
    const ordered = applyDecision(blocked, emitter, { kind: 'orderBlockers', order });
    expect(ordered.combat?.attackers[0]?.blockedBy).toEqual(order);
    expect(ordered.pendingDecision?.kind).toBe('priority');
  });

  it('clears combat by the end of the turn', () => {
    const { state, emitter, mine } = withCreatures([{ power: 2, toughness: 2 }]);
    let current = attackWithAll(state, emitter, [mine[0] as ObjectId]);
    current = passThroughTurn(current, emitter);
    expect(current.combat).toBeNull();
  });
});

describe('combat and state-based actions together', () => {
  const boardWith = (
    a: readonly { power: number; toughness: number; keys?: Partial<Keywords> }[],
    b: readonly { power: number; toughness: number; keys?: Partial<Keywords> }[] = [],
  ) => {
    const built = setup(40);
    let state = built.state;
    const mine: ObjectId[] = [];
    const theirs: ObjectId[] = [];
    for (const [owner, specs, into] of [
      ['A', a, mine],
      ['B', b, theirs],
    ] as const) {
      for (const spec of specs) {
        const created = createObject(state, {
          definitionId: card,
          owner,
          zone: 'battlefield',
          power: spec.power,
          toughness: spec.toughness,
          keywords: keywords(spec.keys ?? {}),
        });
        state = created.state;
        into.push(created.object.id);
      }
    }
    const emitter = built.emitter;
    let current = startGame(state, emitter);
    while (current.pendingDecision?.kind !== 'declareAttackers') current = pass(current, emitter);
    return { state: current, emitter, mine, theirs };
  };

  const attack = (state: GameState, emitter: EventEmitter, attackers: readonly ObjectId[]) =>
    applyDecision(state, emitter, {
      kind: 'declareAttackers',
      attackers: attackers.map((attacker) => ({
        attacker,
        defender: { kind: 'player', player: 'B' } as const,
      })),
    });

  it('two 2/2s that block each other both die', () => {
    const { state, emitter, mine, theirs } = boardWith(
      [{ power: 2, toughness: 2 }],
      [{ power: 2, toughness: 2 }],
    );
    let current = attack(state, emitter, [mine[0] as ObjectId]);
    while (current.pendingDecision?.kind !== 'declareBlockers') current = pass(current, emitter);
    current = applyDecision(current, emitter, {
      kind: 'declareBlockers',
      blocks: [{ blocker: theirs[0] as ObjectId, blocking: [mine[0] as ObjectId] }],
    });
    while (current.step !== 'endCombat' && !current.result) current = pass(current, emitter);

    expect(objectsIn(current, 'battlefield')).toEqual([]);
    expect(objectsIn(current, playerZone('A', 'graveyard'))).toEqual([mine[0]]);
    expect(objectsIn(current, playerZone('B', 'graveyard'))).toEqual([theirs[0]]);
  });

  it('a 3/3 blocked by a 1/1 kills the blocker and survives', () => {
    const { state, emitter, mine, theirs } = boardWith(
      [{ power: 3, toughness: 3 }],
      [{ power: 1, toughness: 1 }],
    );
    let current = attack(state, emitter, [mine[0] as ObjectId]);
    while (current.pendingDecision?.kind !== 'declareBlockers') current = pass(current, emitter);
    current = applyDecision(current, emitter, {
      kind: 'declareBlockers',
      blocks: [{ blocker: theirs[0] as ObjectId, blocking: [mine[0] as ObjectId] }],
    });
    while (current.step !== 'endCombat' && !current.result) current = pass(current, emitter);

    expect(objectsIn(current, 'battlefield')).toEqual([mine[0]]);
    expect(getObject(current, mine[0] as ObjectId).damage).toBe(1);
  });

  it('a deathtouch blocker kills what it blocks, however big', () => {
    const { state, emitter, mine, theirs } = boardWith(
      [{ power: 6, toughness: 6 }],
      [{ power: 1, toughness: 1, keys: { deathtouch: true } }],
    );
    let current = attack(state, emitter, [mine[0] as ObjectId]);
    while (current.pendingDecision?.kind !== 'declareBlockers') current = pass(current, emitter);
    current = applyDecision(current, emitter, {
      kind: 'declareBlockers',
      blocks: [{ blocker: theirs[0] as ObjectId, blocking: [mine[0] as ObjectId] }],
    });
    while (current.step !== 'endCombat' && !current.result) current = pass(current, emitter);

    expect(objectsIn(current, playerZone('A', 'graveyard'))).toEqual([mine[0]]);
  });

  it('a lethal unblocked attack ends the game', () => {
    const { state, emitter, mine } = boardWith([{ power: 20, toughness: 20 }]);
    let current = attack(state, emitter, [mine[0] as ObjectId]);
    for (let i = 0; i < 30 && !current.result; i += 1) current = pass(current, emitter);

    expect(current.result).toMatchObject({ winner: 'A', reason: 'life' });
    expect(current.players.B.life).toBe(0);
  });

  it('damage wears off in cleanup, so a survivor is whole next turn', () => {
    const { state, emitter, mine, theirs } = boardWith(
      [{ power: 3, toughness: 3 }],
      [{ power: 1, toughness: 1 }],
    );
    let current = attack(state, emitter, [mine[0] as ObjectId]);
    while (current.pendingDecision?.kind !== 'declareBlockers') current = pass(current, emitter);
    current = applyDecision(current, emitter, {
      kind: 'declareBlockers',
      blocks: [{ blocker: theirs[0] as ObjectId, blocking: [mine[0] as ObjectId] }],
    });
    current = passThroughTurn(current, emitter);
    expect(getObject(current, mine[0] as ObjectId).damage).toBe(0);
  });
});
