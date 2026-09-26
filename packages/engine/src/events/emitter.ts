import type { GameEvent, GameEventBody } from '@mtg/shared';
import type { GameState } from '../state/game-state.js';

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
}

export interface EventEmitterOptions {
  /** Resume numbering from here; defaults to 0. */
  readonly startSeq?: number;
  /**
   * Called for each event as it is emitted, for live streaming to the UI. It must not
   * throw and must not mutate the event.
   */
  readonly onEvent?: (event: GameEvent) => void;
}

export const createEventEmitter = (options: EventEmitterOptions = {}): EventEmitter => {
  const onEvent = options.onEvent;
  let seq = options.startSeq ?? 0;
  let buffer: GameEvent[] = [];

  if (!Number.isInteger(seq) || seq < 0) {
    throw new RangeError(`startSeq must be a non-negative integer, got ${seq}`);
  }

  return {
    emit(state, body) {
      const event = { seq, turn: state.turn, step: state.step, ...body } as GameEvent;
      seq += 1;
      buffer.push(event);
      onEvent?.(event);
      return event;
    },
    get events() {
      return buffer;
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
    drain: () => [],
    get nextSeq() {
      return seq;
    },
  };
};
