import type { RunSummary } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { type LiveStatus, mergeRun, outdates, type RunStatusMessage } from './live.js';

/** The runs list kept live by `runStatus` (docs/07 "WebSocket"; docs/08 "Runs"). */

const summary: RunSummary = {
  id: 'r1',
  name: 'one',
  status: 'paused',
  seed: '1',
  agentLevel: 'search',
  createdAt: '2026-01-01T00:00:00Z',
  forkedFrom: null,
  cycles: 4,
  currentCycle: null,
  playing: false,
  winRates: [0.5, 0.6],
  lastChange: 'Cut X for Y',
};

const status = (overrides: Partial<RunStatusMessage> = {}): RunStatusMessage => ({
  type: 'runStatus',
  runId: 'r1',
  name: 'one',
  status: 'running',
  playing: true,
  cycle: 5,
  matchesDone: 3,
  matchesPlanned: 10,
  gamesPerSecond: 12.5,
  etaSeconds: 40,
  ...overrides,
});

const received = (at: number, overrides: Partial<RunStatusMessage> = {}): LiveStatus => ({
  ...status(overrides),
  receivedAt: at,
});

describe('merging a status into the fetched list', () => {
  it('shows the fetched run as it is when nothing has been heard', () => {
    const row = mergeRun(summary, 100);
    expect(row).toMatchObject({ status: 'paused', playing: false, cycle: 4, gamesPerSecond: null });
    expect(mergeRun({ ...summary, cycles: 0 }, 100).cycle).toBeNull();
    expect(mergeRun({ ...summary, currentCycle: 5 }, 100).cycle).toBe(5);
  });

  it('takes a newer status over the fetch', () => {
    const row = mergeRun(summary, 100, received(200));
    expect(row).toMatchObject({
      status: 'running',
      playing: true,
      cycle: 5,
      gamesPerSecond: 12.5,
      matchesDone: 3,
      etaSeconds: 40,
    });
    // What only the fetch knows stays.
    expect(row.winRates).toEqual([0.5, 0.6]);
    expect(row.lastChange).toBe('Cut X for Y');
  });

  it('keeps a fetch newer than the status: a paused queued run sends none', () => {
    const row = mergeRun(summary, 300, received(200));
    expect(row).toMatchObject({ status: 'paused', playing: false, cycle: 4 });
    expect(row.gamesPerSecond).toBe(12.5);
  });
});

describe('when a status outdates the list', () => {
  it('does for a run the list lacks, a new status, or a cycle it has not counted', () => {
    expect(outdates(status(), undefined)).toBe(true);
    expect(outdates(status({ status: 'running' }), { ...summary, status: 'paused' })).toBe(true);
    const running = { ...summary, status: 'running' as const, currentCycle: 5 };
    expect(outdates(status({ cycle: 5 }), running)).toBe(false);
    expect(outdates(status({ cycle: 6 }), running)).toBe(true);
    const between = { ...summary, status: 'running' as const, currentCycle: null, cycles: 5 };
    expect(outdates(status({ cycle: 5 }), between)).toBe(false);
    expect(outdates(status({ cycle: null }), between)).toBe(false);
  });
});
