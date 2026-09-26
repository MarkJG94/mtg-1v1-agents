import { asOracleId, type ObjectId, type PlayerId, playerZone } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { declareAttackers } from './combat.js';
import { createEventEmitter, type EventEmitter } from './events/emitter.js';
import { stateFromSeed } from './rng.js';
import { checkStateBasedActions } from './sba.js';
import { createGameState, type GameState } from './state/game-state.js';
import { createObject, objectsIn, updateObject, updatePlayer } from './state/update.js';
import {
  addDelayedTrigger,
  evaluateCondition,
  fireDelayedTriggers,
  queueTriggers,
  type TriggeredAbility,
  triggersFromAttack,
  triggersFromStep,
  triggersFromZoneChange,
  triggersInApnapOrder,
} from './triggers.js';
import { applyDecision, startGame } from './turn/turn.js';

const card = asOracleId('oracle-card');

const ability = (
  id: string,
  when: TriggeredAbility['when'],
  extra: Partial<TriggeredAbility> = {},
): TriggeredAbility => ({
  id,
  when,
  ...extra,
});

const build = () => {
  let state: GameState = createGameState({ rng: stateFromSeed('1'), onPlay: 'A' });
  const emitter = createEventEmitter();

  const put = (
    owner: PlayerId,
    triggers: readonly TriggeredAbility[],
    extra: { power?: number; toughness?: number; zone?: 'battlefield'; damage?: number } = {},
  ): ObjectId => {
    const created = createObject(state, {
      definitionId: card,
      owner,
      zone: extra.zone ?? 'battlefield',
      power: extra.power ?? 2,
      toughness: extra.toughness ?? 2,
      triggers,
    });
    state = created.state;
    if (extra.damage !== undefined) {
      state = updateObject(state, created.object.id, { damage: extra.damage });
    }
    return created.object.id;
  };

  return {
    put,
    emitter,
    get state() {
      return state;
    },
    set state(next: GameState) {
      state = next;
    },
  };
};

describe('detecting triggers', () => {
  it('fires a self-dies trigger', () => {
    const g = build();
    const id = g.put('A', [ability('death', { kind: 'selfDies' })]);
    const snapshot = g.state.objects.get(id);
    const fired = triggersFromZoneChange(g.state, id, snapshot as never, 'dies');
    expect(fired.map((t) => t.abilityId)).toEqual(['death']);
  });

  it('fires another-dies on a different creature', () => {
    const g = build();
    const watcher = g.put('A', [ability('watch', { kind: 'anotherDies' })]);
    const victim = g.put('B', []);
    const fired = triggersFromZoneChange(
      g.state,
      victim,
      g.state.objects.get(victim) as never,
      'dies',
    );
    expect(fired.map((t) => t.source)).toEqual([watcher]);
  });

  it('does not fire another-dies for the creature itself', () => {
    const g = build();
    const id = g.put('A', [ability('watch', { kind: 'anotherDies' })]);
    expect(triggersFromZoneChange(g.state, id, g.state.objects.get(id) as never, 'dies')).toEqual(
      [],
    );
  });

  it('fires enters-the-battlefield triggers', () => {
    const g = build();
    const id = g.put('A', [ability('etb', { kind: 'selfEntersBattlefield' })]);
    const fired = triggersFromZoneChange(g.state, id, g.state.objects.get(id) as never, 'enters');
    expect(fired.map((t) => t.abilityId)).toEqual(['etb']);
  });

  it('fires an attack trigger', () => {
    const g = build();
    const id = g.put('A', [ability('charge', { kind: 'selfAttacks' })]);
    expect(triggersFromAttack(g.state, id).map((t) => t.abilityId)).toEqual(['charge']);
  });

  it('fires an upkeep trigger for its controller’s turn', () => {
    const g = build();
    g.put('A', [ability('upkeep', { kind: 'beginningOfUpkeep', whose: 'self' })]);
    expect(triggersFromStep(g.state, 'upkeep').map((t) => t.abilityId)).toEqual(['upkeep']);
  });

  it('does not fire a "your upkeep" trigger on the opponent’s turn', () => {
    const g = build();
    g.put('B', [ability('upkeep', { kind: 'beginningOfUpkeep', whose: 'self' })]);
    // A is the active player, so B's "your upkeep" does not fire.
    expect(triggersFromStep(g.state, 'upkeep')).toEqual([]);
  });

  it('fires an "each upkeep" trigger whoever is active', () => {
    const g = build();
    g.put('B', [ability('upkeep', { kind: 'beginningOfUpkeep', whose: 'any' })]);
    expect(triggersFromStep(g.state, 'upkeep').map((t) => t.abilityId)).toEqual(['upkeep']);
  });

  it('does not fire an upkeep trigger in the end step', () => {
    const g = build();
    g.put('A', [ability('upkeep', { kind: 'beginningOfUpkeep', whose: 'any' })]);
    expect(triggersFromStep(g.state, 'end')).toEqual([]);
  });
});

describe('last known information (CR 603.10)', () => {
  it('a dies trigger remembers the creature as it was on the battlefield', () => {
    const g = build();
    const id = g.put('A', [ability('death', { kind: 'selfDies' })], { power: 4, toughness: 4 });
    const snapshot = g.state.objects.get(id);
    const fired = triggersFromZoneChange(g.state, id, snapshot as never, 'dies');
    expect(fired[0]?.lastKnown.power).toBe(4);
    expect(fired[0]?.lastKnown.zone).toBe('battlefield');
  });

  it('survives the creature actually leaving, through the SBA path', () => {
    const g = build();
    const id = g.put('A', [ability('death', { kind: 'selfDies' })], {
      power: 3,
      toughness: 3,
      damage: 3,
    });
    const after = checkStateBasedActions(g.state, g.emitter);

    expect(objectsIn(after, playerZone('A', 'graveyard'))).toEqual([id]);
    expect(after.pendingTriggers.map((t) => t.abilityId)).toEqual(['death']);
    // The queued trigger still knows what the creature was, not what it is now.
    expect(after.pendingTriggers[0]?.lastKnown.power).toBe(3);
    expect(after.pendingTriggers[0]?.lastKnown.zone).toBe('battlefield');
  });
});

describe('once each turn (CR 603.3)', () => {
  it('does not fire again once it has fired this turn', () => {
    const g = build();
    const id = g.put('A', [
      ability('once', { kind: 'beginningOfUpkeep', whose: 'any' }, { onceEachTurn: true }),
    ]);
    const first = triggersFromStep(g.state, 'upkeep');
    expect(first).toHaveLength(1);

    const queued = queueTriggers(g.state, first);
    expect(triggersFromStep(queued, 'upkeep')).toEqual([]);
    expect(queued.triggersFiredThisTurn).toEqual([`${id}:once`]);
  });

  it('fires every time when not limited', () => {
    const g = build();
    g.put('A', [ability('every', { kind: 'beginningOfUpkeep', whose: 'any' })]);
    const queued = queueTriggers(g.state, triggersFromStep(g.state, 'upkeep'));
    expect(triggersFromStep(queued, 'upkeep')).toHaveLength(1);
  });
});

describe('intervening-if conditions (CR 603.4)', () => {
  const instance = (controller: PlayerId, lastKnown: never) => ({ controller, lastKnown });

  it('always is true', () => {
    const g = build();
    const id = g.put('A', []);
    const object = g.state.objects.get(id) as never;
    expect(evaluateCondition(g.state, { kind: 'always' }, instance('A', object))).toBe(true);
  });

  it('checks the controller’s life', () => {
    const g = build();
    const id = g.put('A', []);
    const object = g.state.objects.get(id) as never;
    const low = updatePlayer(g.state, 'A', { life: 4 });
    expect(
      evaluateCondition(low, { kind: 'controllerLifeAtMost', amount: 5 }, instance('A', object)),
    ).toBe(true);
    expect(
      evaluateCondition(
        g.state,
        { kind: 'controllerLifeAtMost', amount: 5 },
        instance('A', object),
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        g.state,
        { kind: 'controllerLifeAtLeast', amount: 20 },
        instance('A', object),
      ),
    ).toBe(true);
  });

  it('checks how many permanents the controller has', () => {
    const g = build();
    const id = g.put('A', []);
    g.put('A', []);
    const object = g.state.objects.get(id) as never;
    expect(
      evaluateCondition(
        g.state,
        { kind: 'controllerControlsAtLeast', count: 2 },
        instance('A', object),
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        g.state,
        { kind: 'controllerControlsAtLeast', count: 3 },
        instance('A', object),
      ),
    ).toBe(false);
  });

  it('checks whether the source is tapped', () => {
    const g = build();
    const id = g.put('A', []);
    const tapped = updateObject(g.state, id, { tapped: true });
    const object = tapped.objects.get(id) as never;
    expect(evaluateCondition(tapped, { kind: 'sourceIsTapped' }, instance('A', object))).toBe(true);
  });
});

describe('delayed triggers (CR 603.7)', () => {
  const delayed = (id: string, once = true) => ({
    abilityId: id,
    source: 1 as ObjectId,
    controller: 'A' as PlayerId,
    when: { kind: 'beginningOfEndStep', whose: 'any' } as const,
    once,
  });

  it('waits until its step arrives', () => {
    const g = build();
    const armed = addDelayedTrigger(g.state, delayed('later'));
    expect(fireDelayedTriggers(armed, 'upkeep').fired).toEqual([]);
    expect(fireDelayedTriggers(armed, 'upkeep').remaining).toHaveLength(1);
  });

  it('fires in its step and is then gone', () => {
    const g = build();
    const armed = addDelayedTrigger(g.state, delayed('later'));
    const { fired, remaining } = fireDelayedTriggers(armed, 'end');
    expect(fired.map((t) => t.abilityId)).toEqual(['later']);
    expect(remaining).toEqual([]);
  });

  it('a repeating delayed trigger stays armed', () => {
    const g = build();
    const armed = addDelayedTrigger(g.state, delayed('recurring', false));
    const { fired, remaining } = fireDelayedTriggers(armed, 'end');
    expect(fired).toHaveLength(1);
    expect(remaining).toHaveLength(1);
  });

  it('fires even though its source has left the game', () => {
    const g = build();
    const armed = addDelayedTrigger(g.state, delayed('orphan'));
    const { fired } = fireDelayedTriggers(armed, 'end');
    expect(fired[0]?.controller).toBe('A');
  });
});

describe('APNAP ordering (CR 603.3b)', () => {
  it('separates the active player’s triggers from the opponent’s', () => {
    const g = build();
    const mine = g.put('A', [ability('mine', { kind: 'beginningOfUpkeep', whose: 'any' })]);
    const theirs = g.put('B', [ability('theirs', { kind: 'beginningOfUpkeep', whose: 'any' })]);
    const queued = queueTriggers(g.state, triggersFromStep(g.state, 'upkeep'));

    const { active, nonActive } = triggersInApnapOrder(queued);
    expect(active.map((t) => t.source)).toEqual([mine]);
    expect(nonActive.map((t) => t.source)).toEqual([theirs]);
  });
});

describe('triggers through the game loop', () => {
  const gameWith = (triggers: readonly TriggeredAbility[], owner: PlayerId = 'A') => {
    let state = createGameState({ rng: stateFromSeed('1'), onPlay: 'A' });
    for (const player of ['A', 'B'] as const) {
      for (let i = 0; i < 20; i += 1) {
        state = createObject(state, {
          definitionId: card,
          owner: player,
          zone: playerZone(player, 'library'),
        }).state;
      }
    }
    const created = createObject(state, {
      definitionId: card,
      owner,
      zone: 'battlefield',
      power: 2,
      toughness: 2,
      triggers,
    });
    return { state: created.state, id: created.object.id, emitter: createEventEmitter() };
  };

  const pass = (state: GameState, emitter: EventEmitter): GameState =>
    applyDecision(state, emitter, { kind: 'priority', action: { kind: 'pass' } });

  it('puts an upkeep trigger on the stack before anyone gets priority', () => {
    const { state, emitter } = gameWith([
      ability('upkeep', { kind: 'beginningOfUpkeep', whose: 'any' }),
    ]);
    const started = startGame(state, emitter);

    expect(started.step).toBe('upkeep');
    expect(objectsIn(started, 'stack')).toHaveLength(1);
    expect(started.pendingTriggers).toEqual([]);
    expect(emitter.events.some((event) => event.type === 'trigger')).toBe(true);
  });

  it('the ability resolves and ceases to exist rather than going to a graveyard', () => {
    const { state, emitter } = gameWith([
      ability('upkeep', { kind: 'beginningOfUpkeep', whose: 'any' }),
    ]);
    let current = startGame(state, emitter);
    current = pass(pass(current, emitter), emitter);

    expect(objectsIn(current, 'stack')).toEqual([]);
    expect(objectsIn(current, playerZone('A', 'graveyard'))).toEqual([]);
  });

  it('skips a trigger whose intervening-if is false (CR 603.4)', () => {
    const { state, emitter } = gameWith([
      ability(
        'desperate',
        { kind: 'beginningOfUpkeep', whose: 'any' },
        { interveningIf: { kind: 'controllerLifeAtMost', amount: 5 } },
      ),
    ]);
    const started = startGame(state, emitter);
    // At 20 life the condition is false, so it never reaches the stack.
    expect(objectsIn(started, 'stack')).toEqual([]);
    expect(started.pendingTriggers).toEqual([]);
  });

  it('puts the same trigger on the stack when the condition holds', () => {
    const { state, emitter } = gameWith([
      ability(
        'desperate',
        { kind: 'beginningOfUpkeep', whose: 'any' },
        { interveningIf: { kind: 'controllerLifeAtMost', amount: 5 } },
      ),
    ]);
    const started = startGame(updatePlayer(state, 'A', { life: 3 }), emitter);
    expect(objectsIn(started, 'stack')).toHaveLength(1);
  });

  it('asks the controller to order two of their own triggers', () => {
    const { state, emitter } = gameWith([
      ability('first', { kind: 'beginningOfUpkeep', whose: 'any' }),
      ability('second', { kind: 'beginningOfUpkeep', whose: 'any' }),
    ]);
    const started = startGame(state, emitter);

    expect(started.pendingDecision).toMatchObject({
      kind: 'orderTriggers',
      player: 'A',
      triggers: ['first', 'second'],
    });

    const ordered = applyDecision(started, emitter, {
      kind: 'orderTriggers',
      order: ['second', 'first'],
    });
    expect(objectsIn(ordered, 'stack')).toHaveLength(2);
    expect(ordered.pendingTriggers).toEqual([]);
  });

  it('rejects an order that names an unqueued trigger', () => {
    const { state, emitter } = gameWith([
      ability('first', { kind: 'beginningOfUpkeep', whose: 'any' }),
      ability('second', { kind: 'beginningOfUpkeep', whose: 'any' }),
    ]);
    const started = startGame(state, emitter);
    expect(() =>
      applyDecision(started, emitter, { kind: 'orderTriggers', order: ['first', 'third'] }),
    ).toThrow(/no queued trigger/);
  });

  it('fires an attack trigger when attackers are declared', () => {
    const { state, id, emitter } = gameWith([ability('charge', { kind: 'selfAttacks' })]);
    let current = startGame(state, emitter);
    while (current.pendingDecision?.kind !== 'declareAttackers') current = pass(current, emitter);

    const attacked = applyDecision(current, emitter, {
      kind: 'declareAttackers',
      attackers: [{ attacker: id, defender: { kind: 'player', player: 'B' } }],
    });
    expect(objectsIn(attacked, 'stack')).toHaveLength(1);
  });

  it('clears the once-each-turn record at the start of a turn', () => {
    const { state, emitter } = gameWith([
      ability('once', { kind: 'beginningOfUpkeep', whose: 'any' }, { onceEachTurn: true }),
    ]);
    let current = startGame(state, emitter);
    expect(current.triggersFiredThisTurn).toEqual([expect.stringContaining(':once')]);

    // Answer whatever comes up until the turn rolls over.
    const startingTurn = current.turn;
    for (let i = 0; i < 200 && current.turn === startingTurn && !current.result; i += 1) {
      const decision = current.pendingDecision;
      if (decision?.kind === 'declareAttackers') {
        current = applyDecision(current, emitter, { kind: 'declareAttackers', attackers: [] });
      } else if (decision?.kind === 'declareBlockers') {
        current = applyDecision(current, emitter, { kind: 'declareBlockers', blocks: [] });
      } else {
        current = pass(current, emitter);
      }
    }

    // A new turn: the record was cleared and the ability fired again for the new upkeep.
    expect(current.turn).toBe(startingTurn + 1);
    expect(current.triggersFiredThisTurn).toEqual([expect.stringContaining(':once')]);
  });
});

describe('declareAttackers queues the trigger', () => {
  it('queues rather than resolving immediately', () => {
    const g = build();
    const id = g.put('A', [ability('charge', { kind: 'selfAttacks' })]);
    const attacked = declareAttackers(
      { ...g.state, turn: 1, step: 'declareAttackers' },
      g.emitter,
      [{ attacker: id, defender: { kind: 'player', player: 'B' } }],
    );
    expect(attacked.pendingTriggers.map((t) => t.abilityId)).toEqual(['charge']);
    expect(objectsIn(attacked, 'stack')).toEqual([]);
  });
});
