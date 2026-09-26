import type { RunSummary } from '@mtg/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeLive, fakeServer, inAct, renderWith } from '../test/harness.js';
import { actionsFor, RunsPage } from './RunsPage.js';

/** The runs list (docs/08 "Runs"; roadmap 6.3). */

const run = (overrides: Partial<RunSummary> = {}): RunSummary => ({
  id: 'r1',
  name: 'First run',
  status: 'paused',
  seed: '7',
  agentLevel: 'search',
  createdAt: '2026-01-01T00:00:00Z',
  forkedFrom: null,
  cycles: 3,
  currentCycle: null,
  playing: false,
  winRates: [0.4, 0.5, 0.75],
  lastChange: 'Cut Shock for Lightning Bolt — Shock was dead in hand',
  ...overrides,
});

const runs = [
  run(),
  run({ id: 'r2', name: 'Stopped run', status: 'stopped', winRates: [], lastChange: null }),
];

beforeEach(() => window.history.replaceState(null, '', '/'));
afterEach(() => vi.unstubAllGlobals());

const listCalls = (calls: { method: string; path: string }[]) =>
  calls.filter((call) => call.method === 'GET' && call.path === '/api/runs').length;

describe('the runs list', () => {
  it('shows each run’s status, cycle, sparkline and last change', async () => {
    fakeServer({ 'GET /api/runs': () => ({ body: { runs } }) });
    const { live } = fakeLive();
    renderWith(<RunsPage />, live);

    const first = await screen.findByTestId('run-r1');
    expect(within(first).getByRole('link', { name: 'First run' }).getAttribute('href')).toBe(
      '/runs/r1',
    );
    expect(within(first).getByText('paused')).toBeTruthy();
    expect(within(first).getByRole('img').getAttribute('aria-label')).toBe(
      "A's win rate over the last 3 cycles, latest 75%",
    );
    expect(within(first).getByText(/Cut Shock for Lightning Bolt/)).toBeTruthy();
    expect(within(first).getByRole('link', { name: 'Export' }).getAttribute('href')).toBe(
      '/api/runs/r1/export',
    );
    const second = screen.getByTestId('run-r2');
    expect(within(second).queryByRole('img')).toBeNull();
    expect(within(second).queryByRole('button', { name: 'start' })).toBeNull();
  });

  it('offers the actions a status allows: a stopped run cannot start again (docs/07 409)', () => {
    expect(actionsFor('created')).toEqual(['start', 'stop']);
    expect(actionsFor('paused')).toEqual(['start', 'stop']);
    expect(actionsFor('running')).toEqual(['pause', 'stop']);
    expect(actionsFor('stopped')).toEqual([]);
  });

  it('subscribes to runs while shown, and shows the live pace and progress', async () => {
    const server = fakeServer({ 'GET /api/runs': () => ({ body: { runs } }) });
    const handle = fakeLive();
    const view = renderWith(<RunsPage />, handle.live);
    await screen.findByTestId('run-r1');
    inAct(() => handle.socket.open());
    expect(handle.socket.sent).toEqual([{ subscribe: 'runs' }]);
    const fetched = listCalls(server.calls);

    inAct(() =>
      handle.socket.deliver({
        type: 'runStatus',
        runId: 'r1',
        name: 'First run',
        status: 'running',
        playing: true,
        cycle: 4,
        matchesDone: 6,
        matchesPlanned: 100,
        gamesPerSecond: 4.25,
        etaSeconds: 1500,
      }),
    );
    const row = screen.getByTestId('run-r1');
    expect(within(row).getByTestId('games-per-second').textContent).toBe('4.3');
    expect(within(row).getByText('running')).toBeTruthy();
    expect(within(row).getByText('6/100 matches · 25 min left')).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'pause' })).toBeTruthy();
    // A new cycle and a new status: the list (sparkline, last change) is fetched again.
    await waitFor(() => expect(listCalls(server.calls)).toBe(fetched + 1));

    view.unmount();
    expect(handle.socket.sent.at(-1)).toEqual({ unsubscribe: 'runs' });
  });

  it('does not fetch the list again for a status it already knows', async () => {
    const running = run({ status: 'running', playing: true, currentCycle: 4 });
    const server = fakeServer({ 'GET /api/runs': () => ({ body: { runs: [running] } }) });
    const handle = fakeLive();
    renderWith(<RunsPage />, handle.live);
    await screen.findByTestId('run-r1');
    inAct(() => handle.socket.open());
    const fetched = listCalls(server.calls);
    inAct(() =>
      handle.socket.deliver({
        type: 'runStatus',
        runId: 'r1',
        name: 'First run',
        status: 'running',
        playing: true,
        cycle: 4,
        matchesDone: 7,
        matchesPlanned: 100,
        gamesPerSecond: 20,
        etaSeconds: 30,
      }),
    );
    expect(within(screen.getByTestId('run-r1')).getByTestId('games-per-second').textContent).toBe(
      '20',
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(listCalls(server.calls)).toBe(fetched);
  });

  it('starts, pauses and stops through the API, and fetches the list after', async () => {
    const server = fakeServer({
      'GET /api/runs': () => ({ body: { runs } }),
      'POST /api/runs/r1/start': () => ({ body: run({ status: 'running' }) }),
    });
    renderWith(<RunsPage />, fakeLive().live);
    const row = await screen.findByTestId('run-r1');
    const fetched = listCalls(server.calls);
    fireEvent.click(within(row).getByRole('button', { name: 'start' }));
    await waitFor(() => expect(listCalls(server.calls)).toBe(fetched + 1));
    expect(
      server.calls.some((call) => call.method === 'POST' && call.path === '/api/runs/r1/start'),
    ).toBe(true);
  });

  it('shows the server’s refusal of an action', async () => {
    fakeServer({
      'GET /api/runs': () => ({ body: { runs } }),
      'POST /api/runs/r1/stop': () => ({
        status: 409,
        body: { error: { code: 'conflict', message: 'run r1 is already stopping' } },
      }),
    });
    renderWith(<RunsPage />, fakeLive().live);
    const row = await screen.findByTestId('run-r1');
    fireEvent.click(within(row).getByRole('button', { name: 'stop' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'run r1 is already stopping (conflict)',
    );
  });

  it('forks at a cycle it asks for, and goes to the new run', async () => {
    const server = fakeServer({
      'GET /api/runs': () => ({ body: { runs } }),
      'POST /api/runs/r1/fork': () => ({ status: 201, body: run({ id: 'r3', name: 'Fork' }) }),
    });
    renderWith(<RunsPage />, fakeLive().live);
    const row = await screen.findByTestId('run-r1');
    fireEvent.click(within(row).getByRole('button', { name: 'Fork' }));
    const cycle = screen.getByLabelText('After cycle (0–3)');
    expect((cycle as HTMLInputElement).value).toBe('3');
    fireEvent.change(cycle, { target: { value: '4' } });
    const form = cycle.closest('form');
    if (form === null) throw new Error('no fork form');
    const submit = within(form).getByRole('button', { name: 'Fork' });
    expect(submit.hasAttribute('disabled')).toBe(true); // cycle 4 is not finished
    fireEvent.change(cycle, { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Branch' } });
    expect(submit.hasAttribute('disabled')).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(window.location.pathname).toBe('/runs/r3'));
    expect(server.calls.find((call) => call.path === '/api/runs/r1/fork')?.body).toEqual({
      cycle: 2,
      name: 'Branch',
    });
  });

  it('imports a bundle from a file, and says so when the file is not one', async () => {
    const server = fakeServer({
      'GET /api/runs': () => ({ body: { runs } }),
      'POST /api/runs/import': () => ({ status: 201, body: run({ id: 'r9' }) }),
    });
    renderWith(<RunsPage />, fakeLive().live);
    await screen.findByTestId('run-r1');
    const input = screen.getByLabelText("Import a run's export bundle");

    fireEvent.change(input, {
      target: { files: [new File(['{ nope'], 'broken.json', { type: 'application/json' })] },
    });
    expect((await screen.findByRole('alert')).textContent).toBe(
      'broken.json is not a JSON export bundle',
    );
    expect(server.calls.some((call) => call.path === '/api/runs/import')).toBe(false);

    const bundle = { format: 'mtg-1v1-run', version: 1 };
    fireEvent.change(input, {
      target: { files: [new File([JSON.stringify(bundle)], 'run.json')] },
    });
    await waitFor(() => expect(window.location.pathname).toBe('/runs/r9'));
    expect(server.calls.find((call) => call.path === '/api/runs/import')?.body).toEqual(bundle);
  });

  it('rejects a response that breaks the contract rather than showing half a row', async () => {
    fakeServer({ 'GET /api/runs': () => ({ body: { runs: [{ id: 'r1', name: 'x' }] } }) });
    renderWith(<RunsPage />, fakeLive().live);
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not load the runs/);
  });
});
