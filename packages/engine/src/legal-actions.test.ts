import { asOracleId, type ObjectId, playerZone } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { createEventEmitter, type EventEmitter } from './events/emitter.js';
import { type CardInfo, type CardInfoSource, canCast, legalActions } from './legal-actions.js';
import { basicLandAbility, type ManaAbility } from './mana/ability.js';
import { type ManaCost, parseManaCost } from './mana/cost.js';
import { addMana, emptyManaPool } from './mana/pool.js';
import { stateFromSeed } from './rng.js';
import { putOnStack } from './stack.js';
import { createGameState, type GameState } from './state/game-state.js';
import { createObject, updateObject, updatePlayer } from './state/update.js';
import { playLand } from './turn/land.js';
import { applyDecision, startGame } from './turn/turn.js';

const bolt = asOracleId('oracle-bolt');
const bear = asOracleId('oracle-bear');
const forest = asOracleId('oracle-forest');

const info = (overrides: Partial<CardInfo> = {}): CardInfo => ({
  isLand: false,
  manaCost: parseManaCost('{R}'),
  sorcerySpeed: false,
  colours: ['R'],
  targets: [],
  ...overrides,
});

/** A card-info source backed by a plain map, standing in for card scripts (2.1). */
const source = (
  byId: Map<ObjectId, CardInfo>,
  abilities: readonly ManaAbility[] = [],
): CardInfoSource => ({
  infoFor: (_state, id) => byId.get(id) ?? null,
  manaAbilitiesFor: () => abilities,
});

const pass = (state: GameState, emitter: EventEmitter): GameState =>
  applyDecision(state, emitter, { kind: 'priority', action: { kind: 'pass' } });

/** A started game at A's precombat main, with the given cards in A's hand. */
const atMain = (cards: readonly { oracle: typeof bolt; info: CardInfo }[]) => {
  let state = createGameState({ rng: stateFromSeed('1'), onPlay: 'A' });
  const byId = new Map<ObjectId, CardInfo>();
  const ids: ObjectId[] = [];
  for (const card of cards) {
    const created = createObject(state, {
      definitionId: card.oracle,
      owner: 'A',
      zone: playerZone('A', 'hand'),
    });
    state = created.state;
    byId.set(created.object.id, card.info);
    ids.push(created.object.id);
  }

  const emitter = createEventEmitter();
  let current = startGame(state, emitter);
  while (current.step !== 'precombatMain') current = pass(current, emitter);
  return { state: current, emitter, byId, ids };
};

describe('who may act', () => {
  it('offers nothing to the player without priority', () => {
    const { state, byId } = atMain([]);
    expect(legalActions(state, 'B', source(byId))).toEqual([]);
  });

  it('offers nothing once the game is over', () => {
    const { state, byId } = atMain([]);
    const over = { ...state, result: { winner: null, reason: 'turnCap' as const, turn: 1 } };
    expect(legalActions(over, 'A', source(byId))).toEqual([]);
  });

  it('always offers a pass to whoever holds priority (CR 117.4)', () => {
    const { state, byId } = atMain([]);
    expect(legalActions(state, 'A', source(byId))).toEqual([{ kind: 'pass' }]);
  });
});

describe('playing lands', () => {
  const landCard = { oracle: forest, info: info({ isLand: true, manaCost: parseManaCost('') }) };

  it('offers a land in the main phase', () => {
    const { state, byId, ids } = atMain([landCard]);
    expect(legalActions(state, 'A', source(byId))).toContainEqual({
      kind: 'playLand',
      object: ids[0],
    });
  });

  it('stops offering it once the land drop is spent', () => {
    const { state, byId } = atMain([landCard]);
    const spent = updatePlayer(state, 'A', { landsPlayedThisTurn: 1 });
    expect(legalActions(spent, 'A', source(byId)).every((a) => a.kind !== 'playLand')).toBe(true);
  });

  it('does not offer it outside a main phase', () => {
    const { state, emitter, byId } = atMain([landCard]);
    let current = state;
    while (current.step !== 'declareAttackers') current = pass(current, emitter);
    expect(legalActions(current, 'A', source(byId)).every((a) => a.kind !== 'playLand')).toBe(true);
  });

  it('does not offer it while something is on the stack', () => {
    const { state, byId, ids } = atMain([landCard, { oracle: bolt, info: info() }]);
    const withSpell = putOnStack(state, createEventEmitter(), 'A', ids[1] as ObjectId);
    expect(legalActions(withSpell, 'A', source(byId)).every((a) => a.kind !== 'playLand')).toBe(
      true,
    );
  });
});

describe('casting spells', () => {
  it('does not offer a spell the player cannot pay for', () => {
    const { state, byId } = atMain([{ oracle: bolt, info: info() }]);
    expect(legalActions(state, 'A', source(byId)).every((a) => a.kind !== 'cast')).toBe(true);
  });

  it('offers it once the mana is in the pool', () => {
    const { state, byId, ids } = atMain([{ oracle: bolt, info: info() }]);
    const withMana = updatePlayer(state, 'A', { manaPool: addMana(emptyManaPool, 'R', 1) });
    expect(legalActions(withMana, 'A', source(byId))).toContainEqual({
      kind: 'cast',
      object: ids[0],
      cost: parseManaCost('{R}'),
      targets: [],
    });
  });

  it('counts mana an untapped land could still make', () => {
    const { state, byId, ids } = atMain([{ oracle: bolt, info: info() }]);
    const mountain = createObject(state, {
      definitionId: forest,
      owner: 'A',
      zone: 'battlefield',
    });
    const abilities = [basicLandAbility(mountain.object.id, 'R')];
    expect(canCast(mountain.state, 'A', ids[0] as ObjectId, source(byId, abilities))).toBe(true);
  });

  it('does not count a land that is already tapped', () => {
    const { state, byId, ids } = atMain([{ oracle: bolt, info: info() }]);
    const mountain = createObject(state, {
      definitionId: forest,
      owner: 'A',
      zone: 'battlefield',
    });
    const tapped = updateObject(mountain.state, mountain.object.id, { tapped: true });
    const abilities = [basicLandAbility(mountain.object.id, 'R')];
    expect(canCast(tapped, 'A', ids[0] as ObjectId, source(byId, abilities))).toBe(false);
  });

  it('does not count a land the opponent controls', () => {
    const { state, byId, ids } = atMain([{ oracle: bolt, info: info() }]);
    const theirs = createObject(state, { definitionId: forest, owner: 'B', zone: 'battlefield' });
    const abilities = [basicLandAbility(theirs.object.id, 'R')];
    expect(canCast(theirs.state, 'A', ids[0] as ObjectId, source(byId, abilities))).toBe(false);
  });

  it('counts a dual land as either colour it could make', () => {
    const { state, byId, ids } = atMain([{ oracle: bolt, info: info() }]);
    const dual = createObject(state, { definitionId: forest, owner: 'A', zone: 'battlefield' });
    const ability: ManaAbility = {
      source: dual.object.id,
      requiresTap: true,
      modes: [[{ type: 'W', amount: 1 }], [{ type: 'R', amount: 1 }]],
    };
    expect(canCast(dual.state, 'A', ids[0] as ObjectId, source(byId, [ability]))).toBe(true);
  });

  it('adds pool mana and land mana together for a two-mana spell', () => {
    const cost: ManaCost = parseManaCost('{1}{R}');
    const { state, byId, ids } = atMain([{ oracle: bear, info: info({ manaCost: cost }) }]);
    const mountain = createObject(state, {
      definitionId: forest,
      owner: 'A',
      zone: 'battlefield',
    });
    const withMana = updatePlayer(mountain.state, 'A', {
      manaPool: addMana(emptyManaPool, 'R', 1),
    });
    const abilities = [basicLandAbility(mountain.object.id, 'R')];
    expect(canCast(withMana, 'A', ids[0] as ObjectId, source(byId, abilities))).toBe(true);
  });

  it('skips a card the engine has no script for', () => {
    const { state, ids } = atMain([{ oracle: bolt, info: info() }]);
    const empty: CardInfoSource = { infoFor: () => null };
    expect(legalActions(state, 'A', empty)).toEqual([{ kind: 'pass' }]);
    expect(canCast(state, 'A', ids[0] as ObjectId, empty)).toBe(false);
  });
});

describe('timing (CR 307.1, 601.3a)', () => {
  const sorcery = { oracle: bear, info: info({ sorcerySpeed: true }) };
  const instant = { oracle: bolt, info: info({ sorcerySpeed: false }) };

  const withRedMana = (state: GameState): GameState =>
    updatePlayer(state, 'A', { manaPool: addMana(emptyManaPool, 'R', 1) });

  it('offers a sorcery-speed spell in the main phase', () => {
    const { state, byId, ids } = atMain([sorcery]);
    expect(canCast(withRedMana(state), 'A', ids[0] as ObjectId, source(byId))).toBe(true);
  });

  it('refuses a sorcery-speed spell outside a main phase', () => {
    const { state, emitter, byId, ids } = atMain([sorcery]);
    let current = state;
    while (current.step !== 'declareAttackers') current = pass(current, emitter);
    expect(canCast(withRedMana(current), 'A', ids[0] as ObjectId, source(byId))).toBe(false);
  });

  it('allows an instant outside a main phase', () => {
    const { state, emitter, byId, ids } = atMain([instant]);
    let current = state;
    while (current.step !== 'declareAttackers') current = pass(current, emitter);
    expect(canCast(withRedMana(current), 'A', ids[0] as ObjectId, source(byId))).toBe(true);
  });

  it('refuses a sorcery-speed spell while the stack is not empty', () => {
    const { state, byId, ids } = atMain([sorcery, instant]);
    const withSpell = putOnStack(withRedMana(state), createEventEmitter(), 'A', ids[1] as ObjectId);
    expect(canCast(withSpell, 'A', ids[0] as ObjectId, source(byId))).toBe(false);
  });

  it('allows an instant in response to something on the stack', () => {
    const { state, byId, ids } = atMain([instant, sorcery]);
    const withSpell = putOnStack(withRedMana(state), createEventEmitter(), 'A', ids[1] as ObjectId);
    expect(canCast(withSpell, 'A', ids[0] as ObjectId, source(byId))).toBe(true);
  });
});

describe('split second (CR 702.61a)', () => {
  it('leaves passing as the only option', () => {
    const { state, byId, ids } = atMain([
      { oracle: bolt, info: info() },
      { oracle: bolt, info: info() },
    ]);
    const withMana = updatePlayer(state, 'A', { manaPool: addMana(emptyManaPool, 'R', 2) });
    const cast = putOnStack(withMana, createEventEmitter(), 'A', ids[1] as ObjectId, {
      splitSecond: true,
    });
    expect(legalActions(cast, 'A', source(byId))).toEqual([{ kind: 'pass' }]);
  });
});

describe('the docs/09 invariant', () => {
  it('every pending decision has at least one option', () => {
    const { state, byId } = atMain([{ oracle: bolt, info: info() }]);
    expect(state.pendingDecision?.kind).toBe('priority');
    expect(legalActions(state, 'A', source(byId)).length).toBeGreaterThan(0);
  });

  it('never offers a land play the engine would then reject', () => {
    const { state, emitter, byId, ids } = atMain([
      { oracle: forest, info: info({ isLand: true, manaCost: parseManaCost('') }) },
    ]);
    const offered = legalActions(state, 'A', source(byId)).some(
      (action) => action.kind === 'playLand' && action.object === ids[0],
    );
    expect(offered).toBe(true);
    // The action the engine offered is one it accepts.
    expect(() => playLand(state, emitter, 'A', ids[0] as ObjectId)).not.toThrow();
  });
});

describe('mana sources whose modes differ in size', () => {
  it('under-reports rather than offering a spell that cannot be paid for', () => {
    // A hypothetical "Add {G}{G}, or add {U}": counting two mana that could each be G or
    // U would let a {G}{U} spell look castable, which it is not.
    const { state, byId, ids } = atMain([
      { oracle: bear, info: info({ manaCost: parseManaCost('{G}{U}'), colours: ['G', 'U'] }) },
    ]);
    const odd = createObject(state, { definitionId: forest, owner: 'A', zone: 'battlefield' });
    const ability: ManaAbility = {
      source: odd.object.id,
      requiresTap: true,
      modes: [[{ type: 'G', amount: 2 }], [{ type: 'U', amount: 1 }]],
    };
    expect(canCast(odd.state, 'A', ids[0] as ObjectId, source(byId, [ability]))).toBe(false);
  });

  it('still counts a same-size dual land exactly', () => {
    const { state, byId, ids } = atMain([
      { oracle: bear, info: info({ manaCost: parseManaCost('{G}'), colours: ['G'] }) },
    ]);
    const dual = createObject(state, { definitionId: forest, owner: 'A', zone: 'battlefield' });
    const ability: ManaAbility = {
      source: dual.object.id,
      requiresTap: true,
      modes: [[{ type: 'G', amount: 1 }], [{ type: 'U', amount: 1 }]],
    };
    expect(canCast(dual.state, 'A', ids[0] as ObjectId, source(byId, [ability]))).toBe(true);
  });
});
