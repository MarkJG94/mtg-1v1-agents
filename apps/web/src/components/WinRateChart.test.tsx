import { type CycleSummary, cycleSummarySchema } from '@mtg/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { endLabels, ticks, WinRateChart } from './WinRateChart.js';

/** The run dashboard's win-rate chart (docs/08 "Run dashboard"). */

const cycle = (number: number, a: number): CycleSummary =>
  cycleSummarySchema.parse({
    number,
    generations: { A: 0, B: 0 },
    matches: 10,
    tiebreakMatches: 0,
    winRate: { A: a, B: 1 - a },
    loser: a < 0.5 ? 'A' : 'B',
    decidedBy: 'winRate',
    change: null,
    unchanged: 'no change',
  });

const tickLabels = () => screen.getAllByTestId('cycle-tick').map((tick) => tick.textContent);

const labelY = (agent: 'A' | 'B') =>
  Number(screen.getByTestId(`end-label-${agent}`).getAttribute('y'));

describe('the cycle axis', () => {
  it('labels whole cycles only, however few there are', () => {
    expect(ticks(1, 2)).toEqual([1, 2]);
    expect(ticks(1, 3)).toEqual([1, 2, 3]);
    expect(ticks(4, 7)).toEqual([4, 5, 6, 7]);
    for (const [first, last] of [
      [1, 2],
      [1, 4],
      [3, 9],
      [1, 40],
      [17, 230],
    ] as const) {
      for (const tick of ticks(first, last)) expect(Number.isInteger(tick)).toBe(true);
    }
  });

  it('keeps about six labels across a long run, the first and last among them', () => {
    const many = ticks(1, 230);
    expect(many[0]).toBe(1);
    expect(many.at(-1)).toBe(230);
    expect(many.length).toBeLessThanOrEqual(7);
  });

  it('draws two cycles as 1 and 2, with nothing between', () => {
    render(<WinRateChart cycles={[cycle(1, 0.46), cycle(2, 0.46)]} bans={[]} />);
    expect(tickLabels()).toEqual(['1', '2']);
  });
});

describe('the end labels', () => {
  it('sit at their own lines when the lines are far apart', () => {
    expect(endLabels(40, 160)).toEqual({ A: 40, B: 160 });
  });

  it('move apart when the lines are close, the upper line’s label staying above', () => {
    // B's line above A's, eight points apart: the labels' order follows the lines.
    const close = endLabels(110, 100);
    expect(close.B).toBeLessThan(close.A);
    expect(close.A - close.B).toBeGreaterThanOrEqual(12);
    const flipped = endLabels(100, 110);
    expect(flipped.A).toBeLessThan(flipped.B);
    expect(flipped.B - flipped.A).toBeGreaterThanOrEqual(12);
  });

  it('stay inside the plot when both lines are at its edge', () => {
    const top = endLabels(12, 12);
    expect(Math.min(top.A, top.B)).toBeGreaterThanOrEqual(12);
    expect(Math.abs(top.A - top.B)).toBeGreaterThanOrEqual(12);
  });

  it('do not overlap on a chart at 46% against 54%', () => {
    render(<WinRateChart cycles={[cycle(1, 0.46), cycle(2, 0.46)]} bans={[]} />);
    // B won more, so its line and its label are the higher of the two.
    expect(labelY('B')).toBeLessThan(labelY('A'));
    expect(labelY('A') - labelY('B')).toBeGreaterThanOrEqual(12);
  });
});
