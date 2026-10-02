import {
  type EventLogObject,
  type GameEvent,
  type GameEventBody,
  type ObjectId,
  objectsNamedBy,
} from '@mtg/shared';
import type { GameState } from '../state/game-state.js';
import type { GameObject } from '../state/object.js';

/**
 * Collects the events a game produces (docs/02 "Event log").
 *
 * The engine itself stays pure — `step(state, decision)` returns the events it
 * produced — but `seq` has to be monotonic across a whole game, not per step, so the
 * counter lives with the driver rather than in `GameState`. A driver creates one
 * emitter per game, hands it to each step, and drains it.
 *
 * `turn` and `step` are stamped from the state at emission time, so callers pass only
 * the body and cannot get the envelope wrong.
 *
 * It also records what each object is the first time an event names it (docs/06
 * `objects`). The state at the end of a game cannot say: an ability on the stack and a
 * token that left the battlefield have ceased to exist by then (CR 113.7, 111.7).
 */
export interface EventEmitter {
  /** Stamp and record an event. Returns the stamped event. */
  emit(state: GameState, body: GameEventBody): GameEvent;
  /** Everything recorded so far, oldest first. */
  readonly events: readonly GameEvent[];
  /** Take the recorded events and reset the buffer, keeping the sequence counter. */
  drain(): GameEvent[];
  /** The `seq` the next event will get. */
  readonly nextSeq: number;
  /** What every object an event has named is, in the order they were first named. */
  readonly objects: readonly EventLogObject[];
}

export interface EventEmitterOptions {
  /** Resume numbering from here; defaults to 0. */
  readonly startSeq?: number;
  /**
   * Called for each event as it is emitted, for live streaming to the UI, with what each
   * object the event names for the first time is. It must not throw and must not mutate
   * either.
   */
  readonly onEvent?: (event: GameEvent, introduced: readonly EventLogObject[]) => void;
}

/** What an object is, for a reader with neither the engine nor the card in hand. */
export const identityOf = (object: GameObject): EventLogObject => ({
  id: object.id,
  oracleId: object.definitionId,
  owner: object.owner,
  ...(object.token
    ? {
        token: true,
        ...(object.name === null ? {} : { name: object.name }),
        power: object.power,
        toughness: object.toughness,
      }
    : {}),
  ...(object.stack?.isAbility === true ? { ability: true } : {}),
});

export const createEventEmitter = (options: EventEmitterOptions = {}): EventEmitter => {
  const onEvent = options.onEvent;
  let seq = options.startSeq ?? 0;
  let buffer: GameEvent[] = [];
  const known = new Set<ObjectId>();
  const objects: EventLogObject[] = [];

  /** Identities for the objects this event names that no event has named before. */
  const introduce = (state: GameState, body: GameEventBody): EventLogObject[] => {
    const introduced: EventLogObject[] = [];
    for (const id of objectsNamedBy(body)) {
      if (known.has(id)) continue;
      const object = state.objects.get(id);
      if (object === undefined) continue;
      known.add(id);
      introduced.push(identityOf(object));
    }
    objects.push(...introduced);
    return introduced;
  };

  if (!Number.isInteger(seq) || seq < 0) {
    throw new RangeError(`startSeq must be a non-negative integer, got ${seq}`);
  }

  return {
    emit(state, body) {
      const event = { seq, turn: state.turn, step: state.step, ...body } as GameEvent;
      seq += 1;
      buffer.push(event);
      const introduced = introduce(state, body);
      onEvent?.(event, introduced);
      return event;
    },
    get events() {
      return buffer;
    },
    get objects() {
      return objects;
    },
    drain() {
      const drained = buffer;
      buffer = [];
      return drained;
    },
    get nextSeq() {
      return seq;
    },
  };
};

/** An emitter that records nothing, for search lookahead where events are waste. */
export const nullEventEmitter = (): EventEmitter => {
  let seq = 0;
  return {
    emit(state, body) {
      const event = { seq, turn: state.turn, step: state.step, ...body } as GameEvent;
      seq += 1;
      return event;
    },
    events: [],
    objects: [],
    drain: () => [],
    get nextSeq() {
      return seq;
    },
  };
};
