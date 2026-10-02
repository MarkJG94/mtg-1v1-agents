import { describe, expect, it } from 'vitest';
import { scoreScale } from './GameViewer.js';
import type { TickerLine } from './narrate.js';
import {
  createViewerStore,
  currentLine,
  nextLine,
  nextTurn,
  placeOf,
  previousLine,
  previousTurn,
} from './transport.js';

/** The transport's stepping (docs/08 "Game viewer"): by told event and by turn. */

const line = (index: number, kind: TickerLine['kind'] = 'event'): TickerLine => ({
  index,
  turn: 1,
  kind,
  player: null,
  text: `line ${index}`,
});
// 30 events; told at 2, a turn at 5, told at 9 and 12, a turn at 20, told at 25.
const lines = [line(2), line(5, 'turn'), line(9), line(12), line(20, 'turn'), line(25)];
const length = 30;

// Each line's place, where the board shows it: up to the next line's event.
const places = [5, 9, 12, 20, 25, 30];

it('shows a told event with what followed it untold, up to the next', () => {
  expect(lines.map((_, i) => placeOf(lines, i, length))).toEqual(places);
});

describe('stepping by event', () => {
  it('goes to the next told event’s place, skipping the untold ones between', () => {
    expect(nextLine(lines, 0, length)).toBe(5);
    expect(nextLine(lines, 5, length)).toBe(9);
    expect(nextLine(lines, 9, length)).toBe(12);
    expect(nextLine(lines, 25, length)).toBe(length);
    expect(nextLine(lines, 28, length)).toBe(length);
  });

  it('goes back to the place of the told event before the current one', () => {
    expect(previousLine(lines, 12)).toBe(9);
    expect(previousLine(lines, 9)).toBe(5);
    expect(previousLine(lines, 5)).toBe(0);
    // Part way through a line, back to the one before it.
    expect(previousLine(lines, 15)).toBe(12);
  });

  it('is undone by stepping back', () => {
    for (const place of [0, ...places.slice(0, -1)]) {
      expect(previousLine(lines, nextLine(lines, place, length))).toBe(place);
    }
  });
});

describe('stepping by turn', () => {
  it('goes to where the next turn begins, or the end', () => {
    expect(nextTurn(lines, 0, length)).toBe(9);
    expect(nextTurn(lines, 9, length)).toBe(25);
    expect(nextTurn(lines, 25, length)).toBe(length);
  });

  it('goes back to this turn’s start, and from there to the turn before', () => {
    expect(previousTurn(lines, 28, length)).toBe(25);
    expect(previousTurn(lines, 25, length)).toBe(9);
    expect(previousTurn(lines, 9, length)).toBe(0);
  });
});

it('says which told event the board is at', () => {
  expect(currentLine(lines, 0)).toBeUndefined();
  expect(currentLine(lines, 3)?.index).toBe(2);
  expect(currentLine(lines, 12)?.index).toBe(9);
  expect(currentLine(lines, 13)?.index).toBe(12);
});

describe('the viewer’s state', () => {
  it('stops following a live game when the transport is taken in hand', () => {
    const store = createViewerStore({ following: true });
    store.getState().seek(4);
    expect(store.getState()).toMatchObject({ position: 4, following: false });
    store.getState().follow(true);
    expect(store.getState().following).toBe(true);
    store.getState().play();
    expect(store.getState()).toMatchObject({ playing: true, following: false });
  });

  it('changes speed a step at a time, within 0.25× to 8×', () => {
    const store = createViewerStore();
    store.getState().slower();
    store.getState().slower();
    store.getState().slower();
    expect(store.getState().speed).toBe(0.25);
    for (let i = 0; i < 9; i += 1) store.getState().faster();
    expect(store.getState().speed).toBe(8);
  });
});

describe('the ticker’s evaluation bars', () => {
  const scored = (scores: number[]) =>
    scores.map((score, index): TickerLine => ({ ...line(index), score }));

  it('are scaled so that one huge score does not flatten the rest', () => {
    // Nine ordinary evaluations and one won position.
    expect(scoreScale(scored([1, -2, 3, -4, 5, 6, -7, 8, 9, 1000]))).toBe(9);
    expect(scoreScale(scored([]))).toBe(1);
    expect(scoreScale(scored([0.2, -0.1]))).toBe(1);
  });
});
