import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cycleDetail, lookup, RUN, stats } from '../test/fixtures.js';
import { fakeLive, fakeServer, renderWith } from '../test/harness.js';
import { CyclePage } from './CyclePage.js';

/** A cycle in full (docs/08 "Cycle detail"; roadmap 6.4). */

const base = `/api/runs/${RUN}`;

const server = () =>
  fakeServer({
    [`GET ${base}/cycles/2`]: () => ({ body: cycleDetail(2) }),
    [`GET ${base}/cycles/1`]: () => ({ body: cycleDetail(1) }),
    [`GET ${base}/stats`]: (call) => {
      const params = new URL(call.path, 'http://x').searchParams;
      return { body: stats(params.get('agent') as 'A' | 'B', Number(params.get('cycle'))) };
    },
    'POST /api/cards/lookup': (call) => lookup(call.body),
  });

const names = () =>
  screen.getAllByTestId('stats-row').map((row) => row.querySelector('td')?.textContent);

afterEach(() => vi.unstubAllGlobals());

describe('the cycle page', () => {
  it('shows the change with its evidence: the cut, the shortlist and the trial', async () => {
    server();
    renderWith(<CyclePage runId={RUN} cycle={2} />, fakeLive().live);
    expect((await screen.findByTestId('cycle-result')).textContent).toContain(
      'A 35% · B 65% · A lost',
    );
    const change = await screen.findByRole('list', { name: 'The change' });
    await waitFor(() =>
      expect(change.textContent).toBe('− 4 Shock (main)+ 4 Chain Lightning (main)'),
    );
    const candidates = screen.getByRole('table', { name: 'Candidates' });
    const rows = within(candidates).getAllByRole('row').slice(1);
    expect(rows[0]?.textContent).toContain('Chain Lightning(chosen)');
    expect(rows[0]?.textContent).toContain('50% over 4');
    expect(rows[1]?.textContent).toContain('Pyroblast');
  });

  it('says why nothing changed when nothing did', async () => {
    server();
    renderWith(<CyclePage runId={RUN} cycle={1} />, fakeLive().live);
    expect(await screen.findByText(/nothing the engine can play replaces Shock/)).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Candidates' })).toBeNull();
  });

  it('opens on whichever agent lost the cycle', async () => {
    const { calls } = server();
    renderWith(<CyclePage runId={RUN} cycle={1} />, fakeLive().live);
    await waitFor(() => expect(screen.getAllByTestId('stats-row')).toHaveLength(5));
    // B lost cycle 1.
    expect(calls.filter((call) => call.path.includes('/stats')).map((call) => call.path)).toEqual([
      `${base}/stats?agent=B&cycle=1`,
    ]);
  });

  it('tables the loser’s cards for the cycle, sortable and filterable, and the other agent’s on asking', async () => {
    const { calls } = server();
    renderWith(<CyclePage runId={RUN} cycle={2} />, fakeLive().live);
    await waitFor(() => expect(screen.getAllByTestId('stats-row')).toHaveLength(5));
    // The loser first (A lost cycle 2), for that cycle, worst Δ first.
    expect(calls.find((call) => call.path.includes('/stats'))?.path).toBe(
      `${base}/stats?agent=A&cycle=2`,
    );
    expect(names()).toEqual([
      'Chain Lightning',
      'Pyroblast',
      'Mountain',
      'Lightning Bolt',
      'Goblin Guide',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Δ ▲' }));
    expect(names()[0]).toBe('Goblin Guide');
    fireEvent.click(screen.getByRole('button', { name: 'Card' }));
    expect(names()).toEqual([
      'Chain Lightning',
      'Goblin Guide',
      'Lightning Bolt',
      'Mountain',
      'Pyroblast',
    ]);

    fireEvent.change(screen.getByLabelText('Zone'), { target: { value: 'side' } });
    expect(names()).toEqual(['Pyroblast']);
    fireEvent.change(screen.getByLabelText('Zone'), { target: { value: 'main' } });
    expect(names()).not.toContain('Pyroblast');

    fireEvent.click(screen.getByRole('button', { name: 'Agent B' }));
    await waitFor(() =>
      expect(calls.some((call) => call.path === `${base}/stats?agent=B&cycle=2`)).toBe(true),
    );
  });
});
