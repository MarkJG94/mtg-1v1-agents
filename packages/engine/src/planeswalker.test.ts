import { asOracleId, type ObjectId, type PlayerId, playerZone, steps } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { currentLoyalty } from './characteristics.js';
import {
  dealCombatDamage,
  declareAttackers,
  IllegalCombatError,
  legalDefenders,
} from './combat.js';
import { createEventEmitter } from './events/emitter.js';
import { runEvent } from './events/perform.js';
import { legalActions } from './legal-actions.js';
import {
  activateLoyaltyAbility,
  canActivateLoyalty,
  IllegalLoyaltyActivationError,
  type LoyaltyAbility,
  legalLoyaltyAbilities,
  whyNotActivateLoyalty,
} from './planeswalker.js';
import { addReplacement } from './replacement.js';
import { stateFromSeed } from './rng.js';
import { checkStateBasedActions } from './sba.js';
import { resolveTopOfStack, topOfStack } from './stack.js';
import { createGameState, type GameState } from './state/game-state.js';
import { createObject, getObject, objectsIn, updateObject } from './state/update.js';
import { keywords } from './targeting.js';
import { advanceToStep, applyDecision, startGame } from './turn/turn.js';

const card = asOracleId('oracle-card');

interface Spec {
  readonly power?: number;
  readonly toughness?: number;
  readonly loyalty?: number;
  readonly counters?: Readonly<Record<string, number>>;
  readonly loyaltyAbilities?: readonly LoyaltyAbility[];
  readonly zone?: 'battlefield' | 'stack';
  readonly trample?: boolean;
  readonly tapped?: boolean;
  readonly summoningSick?: boolean;
}

/** A board in A's precombat main phase, with A active. */
const board = (step: GameState['step'] = 'precombatMain') => {
  let state: GameState = createGameState({ rng: stateFromSeed('1'), onPlay: 'A' });
  state = { ...state, turn: 1, step, priority: 'A' };
  const emitter = createEventEmitter();

  const put = (owner: PlayerId, spec: Spec = {}): ObjectId => {
    const created = createObject(state, {
      definitionId: card,
      owner,
      zone: spec.zone ?? 'battlefield',
      ...(spec.power !== undefined ? { power: spec.power } : {}),
      ...(spec.toughness !== undefined ? { toughness: spec.toughness } : {}),
      ...(spec.loyalty !== undefined ? { loyalty: spec.loyalty } : {}),
      ...(spec.loyaltyAbilities !== undefined ? { loyaltyAbilities: spec.loyaltyAbilities } : {}),
      keywords: keywords(spec.trample ? { trample: true } : {}),
    });
    state = updateObject(created.state, created.object.id, {
      counters: spec.counters ?? {},
      tapped: spec.tapped ?? false,
      summoningSick: spec.summoningSick ?? false,
    });
    return created.object.id;
  };

  return {
    put,
    emitter,
    get state(): GameState {
      return state;
    },
    set state(next: GameState) {
      state = next;
    },
  };
};

/** Put a permanent spell on the stack so it can be resolved onto the battlefield. */
const onStack = (game: ReturnType<typeof board>, owner: PlayerId, spec: Spec): ObjectId => {
  const id = game.put(owner, { ...spec, zone: 'stack' });
  game.state = updateObject(game.state, id, {
    stack: { resolvesTo: 'battlefield', splitSecond: false, targets: [], colours: [] },
  });
  return id;
};

describe('entering the battlefield (CR 306.5b)', () => {
  it('arrives with loyalty counters equal to its printed loyalty', () => {
    const game = board();
    const walker = onStack(game, 'A', { loyalty: 4 });

    const resolved = resolveTopOfStack(game.state, game.emitter);
    expect(getObject(resolved, walker).zone).toBe('battlefield');
    expect(currentLoyalty(resolved, walker)).toBe(4);
  });

  it('survives the state-based actions it would otherwise die to', () => {
    const game = board();
    const walker = onStack(game, 'A', { loyalty: 3 });

    const settled = checkStateBasedActions(
      resolveTopOfStack(game.state, game.emitter),
      game.emitter,
    );
    expect(getObject(settled, walker).zone).toBe('battlefield');
  });

  /**
   * Doubling Season's shape. Starting loyalty is counters placed as the permanent enters,
   * so it is a replacement effect that sees them (CR 614.1c) — which only works because
   * the loyalty is seeded into the event rather than set after the fact.
   */
  it('lets a replacement effect double the loyalty it enters with', () => {
    const game = board();
    const doubler = game.put('A');
    const walker = onStack(game, 'A', { loyalty: 3 });
    game.state = addReplacement(game.state, {
      source: doubler,
      controller: 'A',
      applies: { kind: 'addCounters', object: 'any', onEntry: true },
      change: { kind: 'modifyCounters', multiply: 2 },
      duration: { kind: 'permanent' },
    }).state;

    const resolved = resolveTopOfStack(game.state, game.emitter);
    expect(currentLoyalty(resolved, walker)).toBe(6);
  });

  it('leaves a permanent that is not a planeswalker with no counters', () => {
    const game = board();
    const creature = onStack(game, 'A', { power: 2, toughness: 2 });
    const resolved = resolveTopOfStack(game.state, game.emitter);
    expect(getObject(resolved, creature).counters).toEqual({});
  });
});

describe('attacking a planeswalker (CR 508.1a)', () => {
  const attackBoard = () => {
    const game = board('declareAttackers');
    const attacker = game.put('A', { power: 3, toughness: 3 });
    const walker = game.put('B', { loyalty: 5, counters: { loyalty: 5 } });
    return { game, attacker, walker };
  };

  it('offers the defending player and each of their planeswalkers', () => {
    const { game, walker } = attackBoard();
    expect(legalDefenders(game.state)).toEqual([
      { kind: 'player', player: 'B' },
      { kind: 'object', object: walker },
    ]);
  });

  it('does not offer a planeswalker the attacking player controls', () => {
    const game = board('declareAttackers');
    game.put('A', { power: 3, toughness: 3 });
    game.put('A', { loyalty: 5, counters: { loyalty: 5 } });
    expect(legalDefenders(game.state)).toEqual([{ kind: 'player', player: 'B' }]);
  });

  it('refuses a declaration against anything else', () => {
    const { game, attacker } = attackBoard();
    const bystander = game.put('B', { power: 1, toughness: 1 });
    expect(() =>
      declareAttackers(game.state, game.emitter, [
        { attacker, defender: { kind: 'object', object: bystander } },
      ]),
    ).toThrow(IllegalCombatError);
  });

  it('removes loyalty counters rather than marking damage (CR 306.8)', () => {
    const { game, attacker, walker } = attackBoard();
    const attacking = declareAttackers(game.state, game.emitter, [
      { attacker, defender: { kind: 'object', object: walker } },
    ]);

    const after = dealCombatDamage(attacking, game.emitter, false);
    expect(currentLoyalty(after, walker)).toBe(2);
    expect(getObject(after, walker).damage).toBe(0);
    // The attack went at the planeswalker, so the player took nothing.
    expect(after.players.B.life).toBe(20);
  });

  it('kills the planeswalker once its loyalty runs out', () => {
    const game = board('declareAttackers');
    const attacker = game.put('A', { power: 3, toughness: 3 });
    const walker = game.put('B', { loyalty: 2, counters: { loyalty: 2 } });

    const attacking = declareAttackers(game.state, game.emitter, [
      { attacker, defender: { kind: 'object', object: walker } },
    ]);
    const after = checkStateBasedActions(
      dealCombatDamage(attacking, game.emitter, false),
      game.emitter,
    );
    expect(getObject(after, walker).zone).toBe(playerZone('B', 'graveyard'));
  });

  /** CR 702.19b: the excess goes to "the player or planeswalker it's attacking". */
  it('tramples the excess onto the planeswalker, not the player', () => {
    const game = board('declareAttackers');
    const attacker = game.put('A', { power: 5, toughness: 5, trample: true });
    const walker = game.put('B', { loyalty: 6, counters: { loyalty: 6 } });
    const blocker = game.put('B', { power: 1, toughness: 2 });

    let attacking = declareAttackers(game.state, game.emitter, [
      { attacker, defender: { kind: 'object', object: walker } },
    ]);
    attacking = {
      ...attacking,
      combat: {
        firstStrikeDone: false,
        attackers: [
          {
            attacker,
            defender: { kind: 'object', object: walker },
            blockedBy: [blocker],
            blocked: true,
            orderSettled: true,
          },
        ],
      },
    };

    const after = dealCombatDamage(attacking, game.emitter, false);
    expect(currentLoyalty(after, walker)).toBe(3);
    expect(after.players.B.life).toBe(20);
  });

  /** The 2018 rules change: there is no redirection of damage from a player. */
  it('does not redirect damage aimed at a player onto their planeswalker', () => {
    const { game, attacker, walker } = attackBoard();
    const attacking = declareAttackers(game.state, game.emitter, [
      { attacker, defender: { kind: 'player', player: 'B' } },
    ]);

    const after = dealCombatDamage(attacking, game.emitter, false);
    expect(after.players.B.life).toBe(17);
    expect(currentLoyalty(after, walker)).toBe(5);
  });

  it('deals no damage at all when the planeswalker has already left', () => {
    const { game, attacker, walker } = attackBoard();
    let attacking = declareAttackers(game.state, game.emitter, [
      { attacker, defender: { kind: 'object', object: walker } },
    ]);
    attacking = updateObject(attacking, walker, { zone: 'B:graveyard' });

    const after = dealCombatDamage(attacking, game.emitter, false);
    expect(after.players.B.life).toBe(20);
  });

  it('marks damage on a permanent that is both a creature and a planeswalker', () => {
    const game = board();
    const gideon = game.put('B', { power: 4, toughness: 4, loyalty: 5, counters: { loyalty: 5 } });
    const source = game.put('A');

    const after = runEvent(game.state, game.emitter, {
      kind: 'damage',
      source,
      controller: 'A',
      target: { kind: 'object', object: gideon },
      amount: 2,
      combat: false,
      deathtouch: false,
      lifelink: false,
    });
    expect(getObject(after, gideon).damage).toBe(2);
    expect(currentLoyalty(after, gideon)).toBe(3);
  });
});

describe('loyalty abilities (CR 606)', () => {
  const plus: LoyaltyAbility = { id: 'plus', cost: 1 };
  const minus: LoyaltyAbility = { id: 'ultimate', cost: -6 };

  const withWalker = (loyalty = 3, step: GameState['step'] = 'precombatMain') => {
    const game = board(step);
    const walker = game.put('A', {
      loyalty,
      counters: { loyalty },
      loyaltyAbilities: [plus, minus],
    });
    return { game, walker };
  };

  it('pays a plus cost by adding loyalty counters and puts the ability on the stack', () => {
    const { game, walker } = withWalker(3);
    const after = activateLoyaltyAbility(game.state, game.emitter, 'A', walker, 'plus');

    expect(currentLoyalty(after, walker)).toBe(4);
    const top = topOfStack(after);
    expect(top).toBeDefined();
    if (top === undefined) return;
    expect(getObject(after, top).stack?.abilityId).toBe('plus');
    // The activating player gets priority back (CR 117.3c).
    expect(after.pendingDecision).toMatchObject({ kind: 'priority', player: 'A' });
  });

  it('refuses a minus cost bigger than the loyalty it has (CR 606.3)', () => {
    const { game, walker } = withWalker(3);
    expect(whyNotActivateLoyalty(game.state, 'A', walker, 'ultimate')).toMatch(/not enough/);
    expect(() => activateLoyaltyAbility(game.state, game.emitter, 'A', walker, 'ultimate')).toThrow(
      IllegalLoyaltyActivationError,
    );
  });

  /**
   * An ultimate that empties a planeswalker's loyalty kills it to a state-based action,
   * and its ability resolves anyway — the cost is paid on activation, not resolution.
   */
  it('lets an ultimate kill its own planeswalker with the ability still on the stack', () => {
    const { game, walker } = withWalker(6);
    const activated = activateLoyaltyAbility(game.state, game.emitter, 'A', walker, 'ultimate');
    expect(currentLoyalty(activated, walker)).toBe(0);

    const settled = checkStateBasedActions(activated, game.emitter);
    expect(getObject(settled, walker).zone).toBe(playerZone('A', 'graveyard'));
    expect(objectsIn(settled, 'stack')).toHaveLength(1);
  });

  it('allows only one loyalty ability per planeswalker per turn (CR 606.3)', () => {
    const { game, walker } = withWalker(3);
    let after = activateLoyaltyAbility(game.state, game.emitter, 'A', walker, 'plus');
    // Clear the stack so timing is not what stops the second activation.
    after = resolveTopOfStack(after, game.emitter);
    after = { ...after, priority: 'A' };

    expect(whyNotActivateLoyalty(after, 'A', walker, 'plus')).toMatch(/already had a loyalty/);
    expect(legalLoyaltyAbilities(after, 'A')).toHaveLength(0);
  });

  it('refuses activation outside a main phase, on the opponent’s turn, or with a full stack', () => {
    const inCombat = withWalker(3, 'declareAttackers');
    expect(whyNotActivateLoyalty(inCombat.game.state, 'A', inCombat.walker, 'plus')).toMatch(
      /main phase/,
    );

    const theirTurn = withWalker(3);
    theirTurn.game.state = { ...theirTurn.game.state, activePlayer: 'B' };
    expect(whyNotActivateLoyalty(theirTurn.game.state, 'A', theirTurn.walker, 'plus')).toMatch(
      /on your turn/,
    );

    const busy = withWalker(3);
    busy.game.state = activateLoyaltyAbility(
      busy.game.state,
      busy.game.emitter,
      'A',
      busy.walker,
      'plus',
    );
    expect(whyNotActivateLoyalty(busy.game.state, 'A', busy.walker, 'plus')).toMatch(/empty stack/);
  });

  it('refuses activation by a player who does not control the planeswalker', () => {
    const { game, walker } = withWalker(3);
    expect(whyNotActivateLoyalty(game.state, 'B', walker, 'plus')).toMatch(/does not control/);

    // Even on their own turn, holding priority, with everything else in order.
    const theirs = { ...game.state, priority: 'B' as const, activePlayer: 'B' as const };
    expect(whyNotActivateLoyalty(theirs, 'B', walker, 'plus')).toMatch(/does not control/);
    expect(legalLoyaltyAbilities(theirs, 'B')).toHaveLength(0);
  });

  it('offers exactly the abilities it would then accept', () => {
    const { game, walker } = withWalker(3);
    const offered = legalLoyaltyAbilities(game.state, 'A');
    expect(offered).toEqual([{ source: walker, ability: plus }]);

    const actions = legalActions(game.state, 'A', { infoFor: () => null });
    expect(actions).toContainEqual({
      kind: 'activateLoyalty',
      object: walker,
      ability: 'plus',
      cost: 1,
    });
  });

  /**
   * `legalLoyaltyAbilities` asks the timing questions once, before it walks anything, so
   * that six hundred priority grants a game do not each walk the battlefield to be told
   * what the step already said (CR 606.3). The short cut is only sound while it agrees
   * exactly with asking each permanent in turn — which is what `whyNotActivateLoyalty`
   * does, and what activation itself then checks — so this asks both, everywhere.
   */
  it('agrees with asking each permanent in turn, in every step and for either player', () => {
    for (const step of steps) {
      // One planeswalker each, so a short cut that quietly only answered for the player
      // on the play — or only for the active player's own walker — is visible here.
      const game = board(step);
      const walkers = (['A', 'B'] as const).map((owner) => ({
        owner,
        id: game.put(owner, {
          loyalty: 3,
          counters: { loyalty: 3 },
          loyaltyAbilities: [plus, minus],
        }),
      }));

      for (const active of ['A', 'B'] as const) {
        for (const holder of ['A', 'B'] as const) {
          const state = { ...game.state, activePlayer: active, priority: holder };

          const byHand = walkers.flatMap(({ id }) =>
            [plus, minus]
              .filter((ability) => canActivateLoyalty(state, holder, id, ability.id))
              .map((ability) => ({ source: id, ability })),
          );

          const where = `${step}, ${active} active, ${holder} holding`;
          expect(legalLoyaltyAbilities(state, holder), where).toEqual(byHand);
        }
      }
    }
  });

  /** Each player can reach their own, so the agreement above is not agreement on nothing. */
  it('offers each player their own planeswalker on their own turn', () => {
    for (const owner of ['A', 'B'] as const) {
      const game = board('precombatMain');
      const walker = game.put(owner, {
        loyalty: 3,
        counters: { loyalty: 3 },
        loyaltyAbilities: [plus],
      });
      const state = { ...game.state, activePlayer: owner, priority: owner };
      expect(legalLoyaltyAbilities(state, owner)).toEqual([{ source: walker, ability: plus }]);
    }
  });

  /** And with a spell waiting, which is the one condition that is not about the step. */
  it('agrees with asking each permanent in turn while something is on the stack', () => {
    const { game, walker } = withWalker(3);
    const spell = game.put('A', { zone: 'stack' });
    expect(objectsIn(game.state, 'stack')).toEqual([spell]);

    expect(canActivateLoyalty(game.state, 'A', walker, 'plus')).toBe(false);
    expect(legalLoyaltyAbilities(game.state, 'A')).toEqual([]);
  });

  it('offers nothing for a planeswalker that has left the battlefield', () => {
    const { game, walker } = withWalker(3);
    game.state = updateObject(game.state, walker, { zone: 'A:graveyard' });
    expect(legalLoyaltyAbilities(game.state, 'A')).toHaveLength(0);
  });
});

describe('in a real game', () => {
  /** A game with libraries, a planeswalker A controls, run to A's first main phase. */
  const gameWithWalker = (abilities: readonly LoyaltyAbility[]) => {
    let state: GameState = createGameState({ rng: stateFromSeed('1'), onPlay: 'A' });
    for (const player of ['A', 'B'] as const) {
      for (let i = 0; i < 10; i += 1) {
        state = createObject(state, {
          definitionId: card,
          owner: player,
          zone: playerZone(player, 'library'),
        }).state;
      }
    }
    const created = createObject(state, {
      definitionId: card,
      owner: 'A',
      zone: 'battlefield',
      loyalty: 4,
      loyaltyAbilities: abilities,
    });
    state = updateObject(created.state, created.object.id, { counters: { loyalty: 4 } });

    const emitter = createEventEmitter();
    return {
      state: advanceToStep(startGame(state, emitter), emitter, 'precombatMain'),
      emitter,
      walker: created.object.id,
    };
  };

  it('activates through the priority loop and resolves off the stack', () => {
    const plus: LoyaltyAbility = { id: 'plus', cost: 2 };
    const { state, emitter, walker } = gameWithWalker([plus]);

    // The engine offers it, and accepts exactly what it offered (docs/09).
    expect(legalActions(state, 'A', { infoFor: () => null })).toContainEqual({
      kind: 'activateLoyalty',
      object: walker,
      ability: 'plus',
      cost: 2,
    });

    const activated = activateLoyaltyAbility(state, emitter, 'A', walker, 'plus');
    expect(currentLoyalty(activated, walker)).toBe(6);

    // Both players pass and the ability resolves, ceasing to exist rather than being
    // buried (CR 608.2m).
    let current = applyDecision(activated, emitter, { kind: 'priority', action: { kind: 'pass' } });
    current = applyDecision(current, emitter, { kind: 'priority', action: { kind: 'pass' } });
    expect(objectsIn(current, 'stack')).toHaveLength(0);
    expect(currentLoyalty(current, walker)).toBe(6);
  });

  it('offers the ability again on the following turn', () => {
    const plus: LoyaltyAbility = { id: 'plus', cost: 1 };
    const { state, emitter, walker } = gameWithWalker([plus]);

    let current = activateLoyaltyAbility(state, emitter, 'A', walker, 'plus');
    current = applyDecision(current, emitter, { kind: 'priority', action: { kind: 'pass' } });
    current = applyDecision(current, emitter, { kind: 'priority', action: { kind: 'pass' } });
    expect(legalLoyaltyAbilities(current, 'A')).toHaveLength(0);

    // Pass through B's turn and back round to A's main phase.
    for (let i = 0; i < 200 && current.turn < 3; i += 1) {
      current = applyDecision(current, emitter, { kind: 'priority', action: { kind: 'pass' } });
    }
    current = advanceToStep(current, emitter, 'precombatMain');
    expect(current.activePlayer).toBe('A');
    expect(legalLoyaltyAbilities(current, 'A')).toHaveLength(1);
  });
});
