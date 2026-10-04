import { createStore } from 'zustand/vanilla';
import { type Speed, speeds } from './model.js';
import type { TickerLine } from './narrate.js';

/**
 * The transport (docs/08 "Game viewer"): where in the game the board is, and how it moves.
 *
 * A position is a count of events applied: 0 is before the game, `length` is all of it.
 * Stepping "by event" steps by what the ticker tells — a cast, an attack, a land — rather
 * than by every event in the log, most of which (a step starting, priority passing, a
 * land untapping) change nothing a person would notice; stepping by turn goes to where a
 * turn begins.
 *
 * A told event is shown with what followed it untold: "A casts Goblin Guide" with the
 * spell on the stack and the land that paid for it tapped. So a line's place is just
 * before the next line's event (or the end), and the line the board is at is the last
 * one told before its position.
 */

/** Where the board shows line `i`: up to the next told event, or the end. */
export const placeOf = (lines: readonly TickerLine[], i: number, length: number) =>
  lines[i + 1]?.index ?? length;

const indexAt = (lines: readonly TickerLine[], position: number) =>
  lines.findLastIndex((each) => each.index < position);

/** The ticker line the board is at: the last one told before the position. */
export const currentLine = (lines: readonly TickerLine[], position: number) =>
  lines[indexAt(lines, position)];

/** The next told event's place. */
export const nextLine = (lines: readonly TickerLine[], position: number, length: number) => {
  const next = lines.findIndex((each) => each.index >= position);
  return next === -1 ? length : placeOf(lines, next, length);
};

/** The told event before the current one's place; before the game from the first. */
export const previousLine = (lines: readonly TickerLine[], position: number) => {
  const current = indexAt(lines, position);
  return current <= 0 ? 0 : (lines[current]?.index ?? 0);
};

/** The next turn's start, or the end. */
export const nextTurn = (lines: readonly TickerLine[], position: number, length: number) => {
  const next = lines.findIndex((each) => each.kind === 'turn' && each.index >= position);
  return next === -1 ? length : placeOf(lines, next, length);
};

/** This turn's start, or the one before if the board is already there. */
export const previousTurn = (lines: readonly TickerLine[], position: number, length: number) => {
  const turnBefore = (before: number) =>
    lines.findLastIndex((each) => each.kind === 'turn' && each.index < before);
  const turn = turnBefore(position);
  if (turn === -1) return 0;
  const place = placeOf(lines, turn, length);
  if (place < position) return place;
  const earlier = turnBefore(lines[turn]?.index ?? 0);
  return earlier === -1 ? 0 : placeOf(lines, earlier, length);
};

export interface ViewerState {
  /** Events applied; while following a live game, the end, whatever this says. */
  readonly position: number;
  readonly playing: boolean;
  readonly speed: Speed;
  /** Show the hidden information the log holds: the hand docs/08 has face down. */
  readonly reveal: boolean;
  /** Text-only mode: no card art (docs/08 "Rendering"). */
  readonly images: boolean;
  /** The few animations docs/08 allows, which can be turned off. */
  readonly motion: boolean;
  /** A live game: keep the board at the newest event. */
  readonly following: boolean;
  seek(position: number): void;
  play(): void;
  pause(): void;
  setSpeed(speed: Speed): void;
  faster(): void;
  slower(): void;
  setReveal(reveal: boolean): void;
  setImages(images: boolean): void;
  setMotion(motion: boolean): void;
  follow(following: boolean): void;
}

/** One viewer's state; each viewer makes its own, so two on a page do not share a transport. */
export const createViewerStore = (options: { following?: boolean; playing?: boolean } = {}) =>
  createStore<ViewerState>()((set) => ({
    position: 0,
    playing: options.playing ?? false,
    speed: 1,
    reveal: false,
    images: true,
    motion: true,
    following: options.following ?? false,
    // Taking the transport in hand stops following the live edge.
    seek: (position) => set({ position: Math.max(0, position), following: false }),
    play: () => set({ playing: true, following: false }),
    pause: () => set({ playing: false, following: false }),
    setSpeed: (speed) => set({ speed }),
    faster: () =>
      set((state) => ({ speed: speeds[speeds.indexOf(state.speed) + 1] ?? state.speed })),
    slower: () =>
      set((state) => ({ speed: speeds[speeds.indexOf(state.speed) - 1] ?? state.speed })),
    setReveal: (reveal) => set({ reveal }),
    setImages: (images) => set({ images }),
    setMotion: (motion) => set({ motion }),
    follow: (following) => set({ following, playing: false }),
  }));

export type ViewerStore = ReturnType<typeof createViewerStore>;
