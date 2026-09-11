import type { GameEvent, GameEventPayload, ObjectId, PlayerId, ZoneName } from '@mtg/shared';
import type { Characteristics, GameObject, GameState, Zones } from './state.js';

/**
 * A Draft is a GameState being mutated inside one `step()` call. Top-level containers are
 * shallow-copied up front; individual GameObjects are copied on first write (`obj()`), so
 * successive states share unchanged objects. Never mutate a GameState directly.
 */
export interface Draft extends GameState {
  events: GameEvent[];
  dirty: Set<ObjectId>;
  charCache: Map<ObjectId, Characteristics> | null;
  /** Characteristics of every battlefield object computed together (layer system). */
  battlefieldChars: Map<ObjectId, Characteristics> | null;
}

function copyZones(z: Zones): Zones {
  return {
    library: z.library.slice(),
    hand: z.hand.slice(),
    battlefield: z.battlefield.slice(),
    graveyard: z.graveyard.slice(),
    exile: z.exile.slice(),
    command: z.command.slice(),
  };
}

export function beginDraft(state: GameState): Draft {
  return {
    ...state,
    players: {
      A: { ...state.players.A, pool: { ...state.players.A.pool } },
      B: { ...state.players.B, pool: { ...state.players.B.pool } },
    },
    objects: { ...state.objects },
    zones: { A: copyZones(state.zones.A), B: copyZones(state.zones.B) },
    stack: state.stack.slice(),
    effects: state.effects.slice(),
    delayedTriggers: state.delayedTriggers.slice(),
    pendingTriggers: state.pendingTriggers.slice(),
    frames: state.frames.slice(),
    combat: state.combat
      ? {
          ...state.combat,
          attackers: state.combat.attackers.map((a) => ({
            ...a,
            blockers: a.blockers.slice(),
            blockerOrder: a.blockerOrder.slice(),
          })),
          blockers: { ...state.combat.blockers },
          dealtFirstStrike: state.combat.dealtFirstStrike.slice(),
        }
      : null,
    turnFlags: {
      ...state.turnFlags,
      extraTurns: state.turnFlags.extraTurns.slice(),
      attackedThisTurn: state.turnFlags.attackedThisTurn.slice(),
      stateHashes: state.turnFlags.stateHashes.slice(),
    },
    events: [],
    dirty: new Set(),
    charCache: null,
    battlefieldChars: null,
  };
}

export function finishDraft(d: Draft): { state: GameState; events: GameEvent[] } {
  const { events, dirty: _dirty, charCache: _c, battlefieldChars: _b, ...state } = d;
  return { state, events };
}

/** Writable access to an object; clones it once per draft. */
export function obj(d: Draft, id: ObjectId): GameObject {
  const o = d.objects[id];
  if (!o) throw new Error(`No object ${id}`);
  if (d.dirty.has(id)) return o;
  const copy: GameObject = {
    ...o,
    counters: { ...o.counters },
    attachments: o.attachments.slice(),
    abilityActivationsThisTurn: { ...o.abilityActivationsThisTurn },
    chosen: { ...o.chosen },
  };
  d.objects[id] = copy;
  d.dirty.add(id);
  return copy;
}

export function getObj(d: GameState, id: ObjectId): GameObject {
  const o = d.objects[id];
  if (!o) throw new Error(`No object ${id}`);
  return o;
}

export function hasObj(d: GameState, id: ObjectId): boolean {
  return d.objects[id] !== undefined;
}

/** Bumps the version and clears characteristic caches. Call after any change that affects characteristics. */
export function invalidate(d: Draft): void {
  d.version++;
  d.charCache = null;
  d.battlefieldChars = null;
}

export function emit(d: Draft, payload: GameEventPayload): GameEvent {
  const ev: GameEvent = { seq: d.eventSeq++, turn: d.turn, step: d.step, ...payload };
  d.events.push(ev);
  return ev;
}

export function zone(d: Draft, player: PlayerId, name: Exclude<ZoneName, 'stack'>): ObjectId[] {
  return d.zones[player][name];
}

export function nextTimestamp(d: Draft): number {
  return ++d.timestamp;
}

export function bothPlayers(d: GameState): [PlayerId, PlayerId] {
  return [d.activePlayer, d.activePlayer === 'A' ? 'B' : 'A'];
}

export function battlefield(d: GameState): ObjectId[] {
  return [...d.zones.A.battlefield, ...d.zones.B.battlefield];
}
