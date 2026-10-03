import { asOracleId, type ObjectId, type PlayerId, playerZone } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { dealCombatDamage, declareAttackers } from './combat.js';
import { createEventEmitter, type EventEmitter } from './events/emitter.js';
import { resumeBatch, runBatch, runEvent } from './events/perform.js';
import type { RulesEvent } from './events/rules-event.js';
import {
  addReplacement,
  applicableReplacements,
  expireEndOfTurnReplacements,
  matches,
  type ReplacementSpec,
  resolveReplacements,
  UnknownReplacementError,
} from './replacement.js';
import { stateFromSeed } from './rng.js';
import { checkStateBasedActions } from './sba.js';
import { resolveTopOfStack } from './stack.js';
import { createGameState, type GameState } from './state/game-state.js';
import { createObject, getObject, objectsIn, updateObject } from './state/update.js';
import { type Keywords, keywords } from './targeting.js';
import { applyDecision, runUntilGameOver, startGame } from './turn/turn.js';

const card = asOracleId('oracle-card');

interface Spec {
  readonly power?: number;
  readonly toughness?: number;
  readonly damage?: number;
  readonly deathtouched?: boolean;
  readonly indestructible?: boolean;
  readonly zone?: 'battlefield' | 'stack' | 'A:hand' | 'A:library';
  readonly counters?: Readonly<Record<string, number>>;
}

const build = () => {
  let state: GameState = createGameState({ rng: stateFromSeed('1'), onPlay: 'A' });
  const emitter = createEventEmitter();

  const put = (owner: PlayerId, spec: Spec = {}): ObjectId => {
    const created = createObject(state, {
      definitionId: card,
      owner,
      zone: spec.zone ?? 'battlefield',
      ...(spec.power !== undefined ? { power: spec.power } : {}),
      ...(spec.toughness !== undefined ? { toughness: spec.toughness } : {}),
      keywords: keywords(spec.indestructible ? { indestructible: true } : {}),
    });
    state = updateObject(created.state, created.object.id, {
      damage: spec.damage ?? 0,
      deathtouched: spec.deathtouched ?? false,
      counters: spec.counters ?? {},
    });
    return created.object.id;
  };

  const effect = (spec: Omit<ReplacementSpec, 'duration'> & Partial<ReplacementSpec>): number => {
    const added = addReplacement(state, { duration: { kind: 'permanent' }, ...spec });
    state = added.state;
    return added.effect.id;
  };

  return {
    put,
    effect,
    get state(): GameState {
      return state;
    },
    set state(next: GameState) {
      state = next;
    },
    emitter,
  };
};

const damageTo = (
  source: ObjectId,
  target: ObjectId | PlayerId,
  amount: number,
  extra: Partial<Extract<RulesEvent, { kind: 'damage' }>> = {},
): RulesEvent => ({
  kind: 'damage',
  source,
  controller: 'A',
  target:
    typeof target === 'number'
      ? { kind: 'object', object: target }
      : { kind: 'player', player: target },
  amount,
  combat: false,
  deathtouch: false,
  lifelink: false,
  ...extra,
});

const run = (game: ReturnType<typeof build>, ...events: RulesEvent[]): GameState =>
  runBatch(game.state, game.emitter, { kind: 'plain' }, events);

/** Answer a pending `chooseReplacement` decision without going through `applyDecision`. */
const answer = (state: GameState, emitter: EventEmitter, effect: number): GameState => {
  const decision = state.pendingDecision;
  if (decision?.kind !== 'chooseReplacement') throw new Error('no replacement choice is pending');
  return resumeBatch({ ...state, pendingDecision: null }, emitter, effect);
};

describe('matching', () => {
  it('matches damage to a named player and ignores damage to anyone else', () => {
    const game = build();
    const source = game.put('A');
    const id = game.effect({
      source,
      controller: 'A',
      applies: { kind: 'damageToPlayer', player: 'B' },
      change: { kind: 'preventDamage', amount: 'all' },
    });

    const effect = game.state.replacements.find((candidate) => candidate.id === id);
    expect(effect).toBeDefined();
    if (!effect) return;

    expect(matches(game.state, effect, damageTo(source, 'B', 3))).toBe(true);
    expect(matches(game.state, effect, damageTo(source, 'A', 3))).toBe(false);
  });

  it('resolves "sourceController" against the source object, not the stored controller', () => {
    const game = build();
    const source = game.put('A');
    const id = game.effect({
      source,
      controller: 'A',
      applies: { kind: 'damageToPlayer', player: 'sourceController' },
      change: { kind: 'preventDamage', amount: 'all' },
    });

    // Something takes control of the source; the effect follows it (CR 613.1b).
    game.state = updateObject(game.state, source, { controller: 'B' });
    const effect = game.state.replacements.find((candidate) => candidate.id === id);
    if (!effect) throw new Error('effect missing');

    expect(matches(game.state, effect, damageTo(source, 'B', 1))).toBe(true);
    expect(matches(game.state, effect, damageTo(source, 'A', 1))).toBe(false);
  });

  it('only sees combat damage when the matcher says so', () => {
    const game = build();
    const source = game.put('A');
    const id = game.effect({
      source,
      controller: 'A',
      applies: { kind: 'damageToPlayer', player: 'any', combatOnly: true },
      change: { kind: 'preventDamage', amount: 'all' },
    });
    const effect = game.state.replacements.find((candidate) => candidate.id === id);
    if (!effect) throw new Error('effect missing');

    expect(matches(game.state, effect, damageTo(source, 'B', 2, { combat: true }))).toBe(true);
    expect(matches(game.state, effect, damageTo(source, 'B', 2))).toBe(false);
  });

  it('ignores an effect whose source has left the battlefield', () => {
    const game = build();
    const source = game.put('A');
    game.effect({
      source,
      controller: 'A',
      applies: { kind: 'damageToPlayer', player: 'any' },
      change: { kind: 'preventDamage', amount: 'all' },
      duration: { kind: 'whileSourceOnBattlefield' },
    });

    game.state = updateObject(game.state, source, { zone: 'A:graveyard' });
    expect(
      applicableReplacements(game.state, { event: damageTo(source, 'B', 2), applied: [] }),
    ).toHaveLength(0);
  });
});

describe('prevention (CR 615)', () => {
  it('prevents all the damage and leaves nothing to apply', () => {
    const game = build();
    const source = game.put('A');
    game.effect({
      source,
      controller: 'B',
      applies: { kind: 'damageToPlayer', player: 'B' },
      change: { kind: 'preventDamage', amount: 'all' },
    });

    const next = run(game, damageTo(source, 'B', 5));
    expect(next.players.B.life).toBe(20);
  });

  it('absorbs what it can and lets the rest through', () => {
    const game = build();
    const source = game.put('A');
    game.effect({
      source,
      controller: 'B',
      applies: { kind: 'damageToPlayer', player: 'B' },
      change: { kind: 'preventDamage', amount: 2 },
    });

    const next = run(game, damageTo(source, 'B', 5));
    expect(next.players.B.life).toBe(17);
  });

  /** CR 615.7: a shield is used up as it absorbs, so the second hit meets a smaller one. */
  it('shrinks a numeric shield by what it absorbed and retires it when empty', () => {
    const game = build();
    const source = game.put('A');
    game.effect({
      source,
      controller: 'B',
      applies: { kind: 'damageToPlayer', player: 'B' },
      change: { kind: 'preventDamage', amount: 3 },
    });

    game.state = run(game, damageTo(source, 'B', 1));
    expect(game.state.players.B.life).toBe(20);
    expect(game.state.replacements[0]?.change).toEqual({ kind: 'preventDamage', amount: 2 });

    game.state = run(game, damageTo(source, 'B', 5));
    expect(game.state.players.B.life).toBe(17);
    expect(game.state.replacements).toHaveLength(0);
  });

  it('prevents damage marked on a creature, so it is never destroyed', () => {
    const game = build();
    const source = game.put('A', { power: 3, toughness: 3 });
    const victim = game.put('B', { power: 2, toughness: 2 });
    game.effect({
      source: victim,
      controller: 'B',
      applies: { kind: 'damageToObject', object: victim },
      change: { kind: 'preventDamage', amount: 'all' },
    });

    const next = run(game, damageTo(source, victim, 4));
    expect(getObject(next, victim).damage).toBe(0);

    const settled = checkStateBasedActions(next, game.emitter);
    expect(getObject(settled, victim).zone).toBe('battlefield');
  });
});

describe('modifying an event', () => {
  it('doubles damage', () => {
    const game = build();
    const source = game.put('A');
    game.effect({
      source,
      controller: 'A',
      applies: { kind: 'damageToPlayer', player: 'B' },
      change: { kind: 'modifyDamage', multiply: 2 },
    });

    expect(run(game, damageTo(source, 'B', 3)).players.B.life).toBe(14);
  });

  it('redirects damage from a player to a creature', () => {
    const game = build();
    const source = game.put('A', { power: 2, toughness: 2 });
    const wall = game.put('B', { power: 0, toughness: 4 });
    game.effect({
      source: wall,
      controller: 'B',
      applies: { kind: 'damageToPlayer', player: 'B' },
      change: { kind: 'redirectDamage', to: { kind: 'object', object: wall } },
    });

    const next = run(game, damageTo(source, 'B', 3));
    expect(next.players.B.life).toBe(20);
    expect(getObject(next, wall).damage).toBe(3);
  });

  it('doubles a life gain and leaves a life loss alone', () => {
    const game = build();
    const source = game.put('A');
    game.effect({
      source,
      controller: 'A',
      applies: { kind: 'lifeChange', player: 'A', direction: 'gain' },
      change: { kind: 'modifyLife', multiply: 2 },
    });

    expect(run(game, { kind: 'gainLife', player: 'A', amount: 3 }).players.A.life).toBe(26);
    expect(run(game, { kind: 'loseLife', player: 'A', amount: 3 }).players.A.life).toBe(17);
  });

  /** Doubling Season's shape: counters placed on a permanent arrive doubled. */
  it('doubles counters as they are placed', () => {
    const game = build();
    const source = game.put('A');
    const creature = game.put('A', { power: 1, toughness: 1 });
    game.effect({
      source,
      controller: 'A',
      applies: { kind: 'addCounters', object: 'any', counter: '+1/+1' },
      change: { kind: 'modifyCounters', multiply: 2 },
    });

    const next = run(game, {
      kind: 'addCounters',
      object: creature,
      counter: '+1/+1',
      amount: 2,
    });
    expect(getObject(next, creature).counters['+1/+1']).toBe(4);
  });
});

describe('zone changes', () => {
  it('exiles a creature that would die instead of putting it in the graveyard', () => {
    const game = build();
    const source = game.put('B');
    const victim = game.put('A', { power: 1, toughness: 1, damage: 5 });
    game.effect({
      source,
      controller: 'B',
      applies: { kind: 'movesToZone', object: 'any', to: playerZone('A', 'graveyard') },
      change: { kind: 'moveToZoneInstead', to: 'exile' },
    });

    const settled = checkStateBasedActions(game.state, game.emitter);
    expect(getObject(settled, victim).zone).toBe('exile');
    expect(objectsIn(settled, playerZone('A', 'graveyard'))).toHaveLength(0);
  });

  /** CR 701.15: the shield taps it, clears its damage, and it does not die. */
  it('regenerates a creature destroyed by lethal damage', () => {
    const game = build();
    const victim = game.put('A', { power: 2, toughness: 2, damage: 3 });
    game.effect({
      source: victim,
      controller: 'A',
      applies: {
        kind: 'movesToZone',
        object: victim,
        to: playerZone('A', 'graveyard'),
        destructionOnly: true,
      },
      change: { kind: 'regenerate' },
      duration: { kind: 'untilEndOfTurn' },
      uses: 1,
    });

    const settled = checkStateBasedActions(game.state, game.emitter);
    const object = getObject(settled, victim);
    expect(object.zone).toBe('battlefield');
    expect(object.tapped).toBe(true);
    expect(object.damage).toBe(0);
    // One shield, one save: the effect is gone and a second lethal hit kills it.
    expect(settled.replacements).toHaveLength(0);
  });

  /**
   * CR 704.5f: a creature with zero toughness is *put into* its graveyard rather than
   * destroyed, so no regeneration shield saves it.
   */
  it('does not regenerate a creature with zero toughness', () => {
    const game = build();
    const victim = game.put('A', { power: 1, toughness: 0 });
    game.effect({
      source: victim,
      controller: 'A',
      applies: {
        kind: 'movesToZone',
        object: victim,
        to: playerZone('A', 'graveyard'),
        destructionOnly: true,
      },
      change: { kind: 'regenerate' },
      duration: { kind: 'untilEndOfTurn' },
      uses: 1,
    });

    const settled = checkStateBasedActions(game.state, game.emitter);
    expect(getObject(settled, victim).zone).toBe(playerZone('A', 'graveyard'));
  });

  /**
   * A replacement that hands the state-based actions back the very situation they were
   * reacting to has no fixed point. The engine must fail loudly rather than hang; the
   * rules-accurate fix needs CR 614.5 bookkeeping that spans passes, which no real card
   * has asked for yet.
   */
  it('gives up loudly on a replacement the state-based actions can never settle', () => {
    const game = build();
    const victim = game.put('A', { power: 1, toughness: 1, damage: 5 });
    game.effect({
      source: victim,
      controller: 'A',
      applies: { kind: 'movesToZone', object: victim, to: playerZone('A', 'graveyard') },
      change: { kind: 'moveToZoneInstead', to: 'battlefield' },
    });

    expect(() => checkStateBasedActions(game.state, game.emitter)).toThrow(/did not settle/);
  });

  it('drops an unused regeneration shield at end of turn', () => {
    const game = build();
    const victim = game.put('A', { power: 1, toughness: 1 });
    game.effect({
      source: victim,
      controller: 'A',
      applies: { kind: 'movesToZone', object: victim, to: playerZone('A', 'graveyard') },
      change: { kind: 'regenerate' },
      duration: { kind: 'untilEndOfTurn' },
    });

    expect(expireEndOfTurnReplacements(game.state).replacements).toHaveLength(0);
  });
});

describe('entering the battlefield (CR 614.1c)', () => {
  it('brings a permanent in tapped', () => {
    const game = build();
    const land = game.put('A', { zone: 'stack' });
    game.effect({
      source: land,
      controller: 'A',
      applies: { kind: 'entersBattlefield', object: 'source' },
      change: { kind: 'entersTapped' },
      selfReplacement: true,
    });

    const next = runEvent(game.state, game.emitter, {
      kind: 'entersBattlefield',
      object: land,
      from: 'stack',
      tapped: false,
      counters: {},
    });
    const object = getObject(next, land);
    expect(object.zone).toBe('battlefield');
    expect(object.tapped).toBe(true);
  });

  it('brings a creature in with counters, and two such effects stack', () => {
    const game = build();
    const creature = game.put('A', { zone: 'stack', power: 1, toughness: 1 });
    const anthem = game.put('B');
    game.effect({
      source: creature,
      controller: 'A',
      applies: { kind: 'entersBattlefield', object: 'source' },
      change: { kind: 'entersWithCounters', counter: '+1/+1', amount: 2 },
      selfReplacement: true,
    });
    game.effect({
      source: anthem,
      controller: 'B',
      applies: { kind: 'entersBattlefield', object: 'any' },
      change: { kind: 'entersWithCounters', counter: '+1/+1', amount: 1 },
    });

    const next = runEvent(game.state, game.emitter, {
      kind: 'entersBattlefield',
      object: creature,
      from: 'stack',
      tapped: false,
      counters: {},
    });
    expect(getObject(next, creature).counters['+1/+1']).toBe(3);
  });
});

describe('the loop (CR 614.5, 616.1)', () => {
  /**
   * Without CR 614.5 this is an infinite loop: the effect's own output is another event
   * of exactly the kind it watches for.
   */
  it('never applies one effect twice to the same event', () => {
    const game = build();
    const source = game.put('A');
    game.effect({
      source,
      controller: 'A',
      applies: { kind: 'damageToPlayer', player: 'B' },
      change: { kind: 'modifyDamage', multiply: 2 },
    });

    expect(run(game, damageTo(source, 'B', 1)).players.B.life).toBe(18);
  });

  /**
   * Two effects apply to the same entry. Marked as self-replacement, the permanent's own
   * goes first on its own and nobody is asked; without the mark the two are simultaneous
   * and the controller has to choose between them (CR 616.1).
   */
  it('applies self-replacement first, with nobody asked to choose (CR 616.1a)', () => {
    const entering = (selfReplacement: boolean) => {
      const game = build();
      const creature = game.put('A', { zone: 'stack', power: 1, toughness: 1 });
      const other = game.put('B');
      game.effect({
        source: creature,
        controller: 'A',
        applies: { kind: 'entersBattlefield', object: 'source' },
        change: { kind: 'entersTapped' },
        ...(selfReplacement ? { selfReplacement: true } : {}),
      });
      game.effect({
        source: other,
        controller: 'B',
        applies: { kind: 'entersBattlefield', object: 'any' },
        change: { kind: 'entersWithCounters', counter: '+1/+1', amount: 1 },
      });
      return resolveReplacements(game.state, { kind: 'plain' }, [
        {
          kind: 'entersBattlefield',
          object: creature,
          from: 'stack',
          tapped: false,
          counters: {},
        },
      ]);
    };

    const withSelf = entering(true);
    expect(withSelf.kind).toBe('ready');
    if (withSelf.kind !== 'ready') return;
    expect(withSelf.events[0]).toMatchObject({ tapped: true, counters: { '+1/+1': 1 } });

    expect(entering(false).kind).toBe('waiting');
  });

  it('stops for a choice when two outside effects apply to the same event', () => {
    const game = build();
    const first = game.put('B');
    const second = game.put('B');
    const source = game.put('A');

    const a = game.effect({
      source: first,
      controller: 'B',
      applies: { kind: 'damageToPlayer', player: 'B' },
      change: { kind: 'preventDamage', amount: 2 },
    });
    const b = game.effect({
      source: second,
      controller: 'B',
      applies: { kind: 'damageToPlayer', player: 'B' },
      change: { kind: 'modifyDamage', multiply: 2 },
    });

    const paused = run(game, damageTo(source, 'B', 3));
    const decision = paused.pendingDecision;
    expect(decision?.kind).toBe('chooseReplacement');
    if (decision?.kind !== 'chooseReplacement') return;

    // The damaged player chooses (CR 616.1).
    expect(decision.player).toBe('B');
    expect([...decision.options].sort()).toEqual([a, b].sort());
    expect(paused.players.B.life).toBe(20);
    expect(paused.pendingReplacement).not.toBeNull();
  });

  it('gives a different answer depending on which replacement the player picks first', () => {
    const build2 = () => {
      const game = build();
      const first = game.put('B');
      const second = game.put('B');
      const source = game.put('A');
      const prevent = game.effect({
        source: first,
        controller: 'B',
        applies: { kind: 'damageToPlayer', player: 'B' },
        change: { kind: 'preventDamage', amount: 2 },
      });
      const double = game.effect({
        source: second,
        controller: 'B',
        applies: { kind: 'damageToPlayer', player: 'B' },
        change: { kind: 'modifyDamage', multiply: 2 },
      });
      return { game, source, prevent, double };
    };

    // Prevent 2 first, then double what is left: (3 - 2) * 2 = 2 damage.
    const preventing = build2();
    const afterPrevent = answer(
      run(preventing.game, damageTo(preventing.source, 'B', 3)),
      preventing.game.emitter,
      preventing.prevent,
    );
    expect(afterPrevent.players.B.life).toBe(18);

    // Double first, then prevent 2: 3 * 2 - 2 = 4 damage.
    const doubling = build2();
    const afterDouble = answer(
      run(doubling.game, damageTo(doubling.source, 'B', 3)),
      doubling.game.emitter,
      doubling.double,
    );
    expect(afterDouble.players.B.life).toBe(16);
  });

  it('refuses an answer that names an effect which does not apply', () => {
    const game = build();
    const source = game.put('A');
    game.effect({
      source,
      controller: 'B',
      applies: { kind: 'damageToPlayer', player: 'B' },
      change: { kind: 'preventDamage', amount: 2 },
    });
    game.effect({
      source,
      controller: 'B',
      applies: { kind: 'damageToPlayer', player: 'B' },
      change: { kind: 'modifyDamage', multiply: 2 },
    });

    const paused = run(game, damageTo(source, 'B', 3));
    expect(() => answer(paused, game.emitter, 999)).toThrow(UnknownReplacementError);
  });
});

describe('draws', () => {
  it('skips a draw entirely', () => {
    const game = build();
    const source = game.put('A');
    game.put('A', { zone: 'A:library' });
    game.effect({
      source,
      controller: 'A',
      applies: { kind: 'draw', player: 'A' },
      change: { kind: 'skip' },
    });

    const next = run(game, { kind: 'draw', player: 'A' });
    expect(objectsIn(next, playerZone('A', 'hand'))).toHaveLength(0);
    expect(next.players.A.drewFromEmptyLibrary).toBe(false);
  });

  it('draws normally when nothing replaces it', () => {
    const game = build();
    const top = game.put('A', { zone: 'A:library' });
    const next = run(game, { kind: 'draw', player: 'A' });
    expect(objectsIn(next, playerZone('A', 'hand'))).toEqual([top]);
  });
});

describe('in a real game', () => {
  /** A board where A's creature attacks B, stopped just before damage is dealt. */
  const attacking = (power: number, keywordSpec: Partial<Keywords> = {}) => {
    let state: GameState = createGameState({ rng: stateFromSeed('1'), onPlay: 'A' });
    state = { ...state, turn: 1, step: 'declareAttackers' };
    const emitter = createEventEmitter();

    const created = createObject(state, {
      definitionId: card,
      owner: 'A',
      zone: 'battlefield',
      power,
      toughness: power,
      keywords: keywords(keywordSpec),
    });
    state = declareAttackers(created.state, emitter, [
      { attacker: created.object.id, defender: { kind: 'player', player: 'B' } },
    ]);
    return { state, emitter, attacker: created.object.id };
  };

  it('prevents combat damage before any of it is marked', () => {
    const game = attacking(4);
    const shield = addReplacement(game.state, {
      source: game.attacker,
      controller: 'B',
      applies: { kind: 'damageToPlayer', player: 'B', combatOnly: true },
      change: { kind: 'preventDamage', amount: 3 },
      duration: { kind: 'untilEndOfTurn' },
    });

    const after = dealCombatDamage(shield.state, game.emitter, false);
    expect(after.players.B.life).toBe(19);
    expect(after.combat?.firstStrikeDone).toBe(false);
  });

  /**
   * Lifelink gains life as the damage is dealt (CR 702.15a), and that life gain is itself
   * an event a replacement can change — so the gain is run back through the pipeline.
   */
  it('doubles the life a lifelinker gains', () => {
    const game = attacking(3, { lifelink: true });
    const doubler = addReplacement(game.state, {
      source: game.attacker,
      controller: 'A',
      applies: { kind: 'lifeChange', player: 'A', direction: 'gain' },
      change: { kind: 'modifyLife', multiply: 2 },
      duration: { kind: 'permanent' },
    });

    const after = dealCombatDamage(doubler.state, game.emitter, false);
    expect(after.players.B.life).toBe(17);
    expect(after.players.A.life).toBe(26);
  });

  it('brings a resolving permanent onto the battlefield tapped', () => {
    let state: GameState = createGameState({ rng: stateFromSeed('1'), onPlay: 'A' });
    const emitter = createEventEmitter();

    const created = createObject(state, {
      definitionId: card,
      owner: 'A',
      zone: 'stack',
    });
    state = updateObject(created.state, created.object.id, {
      stack: { resolvesTo: 'battlefield', splitSecond: false, targets: [], colours: [] },
    });
    state = addReplacement(state, {
      source: created.object.id,
      controller: 'A',
      applies: { kind: 'entersBattlefield', object: 'source' },
      change: { kind: 'entersTapped' },
      duration: { kind: 'permanent' },
      selfReplacement: true,
    }).state;

    const resolved = resolveTopOfStack(state, emitter);
    const object = getObject(resolved, created.object.id);
    expect(object.zone).toBe('battlefield');
    expect(object.tapped).toBe(true);
    expect(object.summoningSick).toBe(true);
  });

  /**
   * The fuzzer in roadmap 1.13 answers every decision the engine can raise, so a game
   * that pauses on a replacement choice must still run to its end unattended.
   */
  it('runs a whole game to its end through a replacement choice', () => {
    let state: GameState = createGameState({
      rng: stateFromSeed('1'),
      onPlay: 'A',
      turnCap: 4,
    });
    for (const player of ['A', 'B'] as const) {
      for (let i = 0; i < 12; i += 1) {
        state = createObject(state, {
          definitionId: card,
          owner: player,
          zone: playerZone(player, 'library'),
        }).state;
      }
    }

    // Two effects that both want to replace A's draw, so the draw step stops and asks.
    const watcher = createObject(state, { definitionId: card, owner: 'A', zone: 'battlefield' });
    state = watcher.state;
    for (let i = 0; i < 2; i += 1) {
      state = addReplacement(state, {
        source: watcher.object.id,
        controller: 'A',
        applies: { kind: 'draw', player: 'A' },
        change: { kind: 'skip' },
        duration: { kind: 'permanent' },
        uses: 1,
      }).state;
    }

    const emitter = createEventEmitter();
    let current = startGame(state, emitter);

    // A is on the play and skips the first draw step (CR 103.7a), so the choice comes up
    // on B's turn... which A's effects ignore. Drive until A's own draw step asks.
    let sawChoice = false;
    for (let i = 0; i < 400 && !current.result; i += 1) {
      if (current.pendingDecision?.kind === 'chooseReplacement') {
        sawChoice = true;
        expect(current.pendingDecision.player).toBe('A');
        expect(current.pendingDecision.options).toHaveLength(2);
        break;
      }
      current = applyDecision(current, emitter, { kind: 'priority', action: { kind: 'pass' } });
    }
    expect(sawChoice).toBe(true);

    const finished = runUntilGameOver(current, emitter);
    expect(finished.result).not.toBeNull();
    expect(finished.pendingReplacement).toBeNull();
    // The chosen shield was used up; the other is still waiting.
    expect(finished.replacements).toHaveLength(1);
  });

  it('leaves the event alone when a matcher and a change disagree', () => {
    const game = build();
    const source = game.put('A');
    game.put('A', { zone: 'A:library' });
    game.effect({
      source,
      controller: 'A',
      // A damage change on a draw matcher is a malformed effect; it must not silently
      // do something else, and it must not stall the loop.
      applies: { kind: 'draw', player: 'A' },
      change: { kind: 'preventDamage', amount: 'all' },
    });

    const next = run(game, { kind: 'draw', player: 'A' });
    expect(objectsIn(next, playerZone('A', 'hand'))).toHaveLength(1);
  });
});
