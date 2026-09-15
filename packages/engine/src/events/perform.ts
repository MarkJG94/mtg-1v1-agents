import { kindOfZone, type ObjectId, type PlayerId, playerZone } from '@mtg/shared';
import {
  type EventBatch,
  resolveReplacements,
  resumeReplacements,
  UnknownReplacementError,
} from '../replacement.js';
import type { GameState } from '../state/game-state.js';
import { withCounters } from '../state/object.js';
import {
  getObject,
  moveObject,
  objectsIn,
  updateObject,
  updateObjects,
  updatePlayer,
  updateState,
} from '../state/update.js';
import { queueTriggers, triggersFromZoneChange } from '../triggers.js';
import type { EventEmitter } from './emitter.js';
import type { DamageEvent, LifeEvent, RulesEvent } from './rules-event.js';

/**
 * Performing rules events, once replacement effects have had their say.
 *
 * `runBatch` is the only way the engine makes something happen: it proposes a list of
 * events, `resolveReplacements` rewrites them (CR 614–616), and what survives is applied
 * here. When a player has to choose between two applicable replacements the batch stops
 * mid-flight and the game waits on a `chooseReplacement` decision; `resumeBatch` picks it
 * back up. The paused batch is plain data on the state, so a replay reproduces it exactly.
 *
 * Damage within one batch is dealt simultaneously (CR 510.2). That is what makes two
 * creatures trade rather than the first one dying before it can hit back, and it is why
 * this applies every damage event as a single update instead of looping.
 */

/** Propose a batch of events. Returns a paused state if a player must choose. */
export const runBatch = (
  state: GameState,
  emitter: EventEmitter,
  batch: EventBatch,
  events: readonly RulesEvent[],
): GameState => {
  const result = resolveReplacements(state, batch, events);
  if (result.kind === 'waiting') return result.state;
  return performEvents(result.state, emitter, batch, result.events);
};

/** Propose a single event. */
export const runEvent = (state: GameState, emitter: EventEmitter, event: RulesEvent): GameState =>
  runBatch(state, emitter, { kind: 'plain' }, [event]);

/** Continue the paused batch with the replacement effect the player chose. */
export const resumeBatch = (state: GameState, emitter: EventEmitter, chosen: number): GameState => {
  const progress = state.pendingReplacement;
  if (!progress) throw new UnknownReplacementError('no replacement batch is paused');

  const cleared = updateState(state, { pendingReplacement: null });
  const result = resumeReplacements(cleared, progress, chosen);
  if (result.kind === 'waiting') return result.state;
  return performEvents(result.state, emitter, progress.batch, result.events);
};

// --- Applying ---

/**
 * Apply every event in a batch.
 *
 * Damage first and all at once; everything else in order. Lifelink is not a trigger — the
 * life is gained as the damage is dealt (CR 702.15a) — but it is itself a life-gain event
 * that replacement effects may change, so the gains go back through the pipeline as a
 * batch of their own once the damage has landed.
 */
export const performEvents = (
  state: GameState,
  emitter: EventEmitter,
  batch: EventBatch,
  events: readonly RulesEvent[],
): GameState => {
  const damage = events.filter((event): event is DamageEvent => event.kind === 'damage');

  let next = damage.length > 0 ? applyDamage(state, emitter, damage) : state;

  for (const event of events) {
    if (event.kind === 'damage') continue;
    next = applyOne(next, emitter, event);
  }

  if (batch.kind === 'combatDamage' && batch.firstStrike && next.combat) {
    next = updateState(next, { combat: { ...next.combat, firstStrikeDone: true } });
  }

  const lifelink = lifelinkGains(damage);
  return lifelink.length > 0 ? runBatch(next, emitter, { kind: 'plain' }, lifelink) : next;
};

const lifelinkGains = (damage: readonly DamageEvent[]): readonly LifeEvent[] => {
  const byPlayer = new Map<PlayerId, number>();
  for (const event of damage) {
    if (!event.lifelink || event.amount <= 0) continue;
    byPlayer.set(event.controller, (byPlayer.get(event.controller) ?? 0) + event.amount);
  }
  return [...byPlayer].map(([player, amount]) => ({ kind: 'gainLife', player, amount }) as const);
};

/** All the damage in one batch, marked and deducted together (CR 510.2). */
const applyDamage = (
  state: GameState,
  emitter: EventEmitter,
  events: readonly DamageEvent[],
): GameState => {
  const damageByObject = new Map<ObjectId, number>();
  const deathtouched = new Set<ObjectId>();
  const lifeLossByPlayer = new Map<PlayerId, number>();

  for (const event of events) {
    if (event.amount <= 0) continue;
    if (event.target.kind === 'object') {
      const id = event.target.object;
      damageByObject.set(id, (damageByObject.get(id) ?? 0) + event.amount);
      // Remembered so the state-based action can destroy it even when the damage is not
      // lethal on its own (CR 702.2b).
      if (event.deathtouch) deathtouched.add(id);
    } else {
      const player = event.target.player;
      lifeLossByPlayer.set(player, (lifeLossByPlayer.get(player) ?? 0) + event.amount);
    }
  }

  let next = updateObjects(
    state,
    [...damageByObject]
      .filter(([id]) => state.objects.has(id))
      .map(
        ([id, amount]) =>
          [
            id,
            {
              damage: getObject(state, id).damage + amount,
              ...(deathtouched.has(id) ? { deathtouched: true } : {}),
            },
          ] as const,
      ),
  );

  for (const event of events) {
    if (event.amount <= 0) continue;
    emitter.emit(next, {
      type: 'damage',
      source: event.source,
      target: event.target,
      amount: event.amount,
      combat: event.combat,
      ...(event.deathtouch ? { deathtouch: true } : {}),
    });
  }

  for (const [player, amount] of lifeLossByPlayer) {
    const from = next.players[player].life;
    next = updatePlayer(next, player, { life: from - amount });
    emitter.emit(next, {
      type: 'lifeChange',
      player,
      from,
      to: from - amount,
      reason: 'damage',
    });
  }

  return next;
};

const applyOne = (state: GameState, emitter: EventEmitter, event: RulesEvent): GameState => {
  switch (event.kind) {
    case 'damage':
      return applyDamage(state, emitter, [event]);
    case 'draw':
      return applyDraw(state, emitter, event.player);
    case 'moveZone':
      return applyMoveZone(state, emitter, event);
    case 'entersBattlefield':
      return applyEnters(state, emitter, event);
    case 'gainLife':
    case 'loseLife':
      return applyLife(state, emitter, event);
    case 'addCounters':
      return applyCounters(state, emitter, event);
  }
};

/**
 * Draw one card. A player who tries to draw from an empty library does not lose on the
 * spot: they are flagged and lose the next time state-based actions are checked
 * (CR 120.3, 704.5b).
 */
const applyDraw = (state: GameState, emitter: EventEmitter, player: PlayerId): GameState => {
  const library = objectsIn(state, playerZone(player, 'library'));
  const top = library[0];
  if (top === undefined) {
    return state.players[player].drewFromEmptyLibrary
      ? state
      : updatePlayer(state, player, { drewFromEmptyLibrary: true });
  }

  const drawn = moveObject(state, top, playerZone(player, 'hand'));
  emitter.emit(drawn, { type: 'draw', player, object: top });
  return drawn;
};

const applyMoveZone = (
  state: GameState,
  emitter: EventEmitter,
  event: Extract<RulesEvent, { kind: 'moveZone' }>,
): GameState => {
  const object = state.objects.get(event.object);
  if (!object) return state;

  // A creature leaving the battlefield for a graveyard dies, and its own dies trigger has
  // to remember it as it last was on the battlefield (CR 603.10).
  const dies = object.zone === 'battlefield' && kindOfZone(event.to) === 'graveyard';
  const fired = dies ? triggersFromZoneChange(state, event.object, object, 'dies') : [];

  const moved = moveObject(state, event.object, event.to);
  emitter.emit(moved, {
    type: 'moveZone',
    object: event.object,
    from: object.zone,
    to: event.to,
    cause: event.cause,
  });

  return fired.length > 0 ? queueTriggers(moved, fired) : moved;
};

const applyEnters = (
  state: GameState,
  emitter: EventEmitter,
  event: Extract<RulesEvent, { kind: 'entersBattlefield' }>,
): GameState => {
  const object = state.objects.get(event.object);
  if (!object) return state;

  const moved = moveObject(state, event.object, 'battlefield');
  emitter.emit(moved, {
    type: 'moveZone',
    object: event.object,
    from: object.zone,
    to: 'battlefield',
    cause: 'resolve',
  });

  // A permanent has summoning sickness until its controller's next turn begins
  // (CR 302.6); "as it enters" replacements decide the rest of how it arrives.
  let counters = object.counters;
  for (const [counter, amount] of Object.entries(event.counters)) {
    if (amount > 0) counters = withCounters({ ...object, counters }, counter, amount).counters;
  }

  const entered = updateObject(moved, event.object, {
    summoningSick: true,
    tapped: event.tapped,
    counters,
  });

  if (event.tapped) emitter.emit(entered, { type: 'tap', object: event.object });
  for (const [counter, amount] of Object.entries(event.counters)) {
    if (amount > 0) {
      emitter.emit(entered, {
        type: 'counterChange',
        object: event.object,
        counter,
        from: object.counters[counter] ?? 0,
        to: amount,
      });
    }
  }

  return queueTriggers(
    entered,
    triggersFromZoneChange(entered, event.object, getObject(entered, event.object), 'enters'),
  );
};

const applyLife = (state: GameState, emitter: EventEmitter, event: LifeEvent): GameState => {
  if (event.amount <= 0) return state;
  const from = state.players[event.player].life;
  const to = event.kind === 'gainLife' ? from + event.amount : from - event.amount;
  const next = updatePlayer(state, event.player, { life: to });
  emitter.emit(next, {
    type: 'lifeChange',
    player: event.player,
    from,
    to,
    reason: event.kind === 'gainLife' ? 'gain' : 'loss',
  });
  return next;
};

const applyCounters = (
  state: GameState,
  emitter: EventEmitter,
  event: Extract<RulesEvent, { kind: 'addCounters' }>,
): GameState => {
  const object = state.objects.get(event.object);
  if (!object || event.amount === 0) return state;

  const from = object.counters[event.counter] ?? 0;
  const to = Math.max(0, from + event.amount);
  const next = updateObject(state, event.object, {
    counters: withCounters(object, event.counter, to).counters,
  });
  emitter.emit(next, {
    type: 'counterChange',
    object: event.object,
    counter: event.counter,
    from,
    to,
  });
  return next;
};
