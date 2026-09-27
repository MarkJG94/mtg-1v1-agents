import type { BanState } from '@mtg/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { banState, cycleDetail, cycles, lookup, RUN, runDetail, stats } from '../test/fixtures.js';
import { type Call, fakeLive, fakeServer, inAct, renderWith } from '../test/harness.js';
import { RunPage } from './RunPage.js';

/** The run dashboard (docs/08 "Run dashboard"; roadmap 6.4). */

const base = `/api/runs/${RUN}`;

const server = (overrides: { bans?: BanState } = {}) => {
  let bans = overrides.bans ?? banState();
  return fakeServer({
    [`GET ${base}`]: () => ({ body: runDetail }),
    [`GET ${base}/cycles`]: (call) => {
      const offset = Number(new URL(call.path, 'http://x').searchParams.get('offset') ?? 0);
      return {
        body: { total: cycles.length, offset, limit: 500, cycles: cycles.slice(offset) },
      };
    },
    [`GET ${base}/stats`]: (call) => {
      const params = new URL(call.path, 'http://x').searchParams;
      const cycle = params.get('cycle');
      return {
        body: stats(params.get('agent') as 'A' | 'B', cycle === null ? null : Number(cycle)),
      };
    },
    [`GET ${base}/bans`]: () => ({ body: bans }),
    [`PUT ${base}/bans/goblin`]: (call) => {
      const { status, note } = call.body as { status: 'banned' | 'restricted'; note: string };
      bans = banState({
        history: [
          ...bans.history,
          {
            oracleId: 'goblin',
            action: status === 'banned' ? 'ban' : 'restrict',
            note,
            by: 'operator',
            at: '2026-01-02T00:00:00Z',
            appliedAfterGameId: null,
          },
        ],
      });
      return { status: 202, body: bans };
    },
    [`DELETE ${base}/bans/pyro`]: () => {
      bans = banState({ list: [] });
      return { status: 202, body: bans };
    },
    [`GET ${base}/cycles/2`]: () => ({ body: cycleDetail(2) }),
    'POST /api/cards/lookup': (call) => lookup(call.body),
    'GET /api/cards': () => ({
      body: {
        cards: [
          {
            oracleId: 'goblin',
            name: 'Goblin Guide',
            manaCost: '{R}',
            manaValue: 1,
            typeLine: 'Creature — Goblin Scout',
            colorIdentity: ['R'],
            support: 'supported',
          },
        ],
      },
    }),
  });
};

const count = (calls: readonly Call[], path: string) =>
  calls.filter((call) => call.method === 'GET' && call.path.startsWith(path)).length;

beforeEach(() => window.history.replaceState(null, '', `/runs/${RUN}`));
afterEach(() => vi.unstubAllGlobals());

describe('the run dashboard', () => {
  it('charts both agents over every cycle, with its changes and its bans', async () => {
    server();
    renderWith(<RunPage runId={RUN} />, fakeLive().live);
    const chart = await screen.findByRole('img', { name: /Win rates over 3 cycles/ });
    expect(chart.getAttribute('aria-label')).toBe('Win rates over 3 cycles; latest A 55%, B 45%');
    expect(screen.getByTestId('line-A').getAttribute('points')?.split(' ')).toHaveLength(3);
    // One change, on A's line at cycle 2; one ban, in effect from cycle 2.
    const changes = screen.getAllByTestId('change-mark');
    expect(changes).toHaveLength(1);
    expect(changes[0]?.getAttribute('fill')).toBe('#1b8fd0');
    await waitFor(() => expect(screen.getAllByTestId('ban-mark')).toHaveLength(1));
    expect(screen.getByTestId('ban-mark').textContent).toBe(
      'restrict Pyroblast — in effect from cycle 2',
    );
  });

  it('reads a cycle’s numbers from the chart by keyboard', async () => {
    server();
    renderWith(<RunPage runId={RUN} />, fakeLive().live);
    const slider = await screen.findByRole('slider', { name: 'Cycle' });
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toContain('Cycle 2');
    expect(tip.textContent).toContain('35%');
    expect(tip.textContent).toContain('Cut 4 Shock for 4 Chain Lightning');
    // The ban that took effect in cycle 2 is read there, and only there.
    await waitFor(() =>
      expect(screen.getByRole('tooltip').textContent).toContain(
        'restrict Pyroblast — in effect from cycle 2',
      ),
    );
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(screen.getByRole('tooltip').textContent).toContain('Cycle 1');
    expect(screen.getByRole('tooltip').textContent).not.toContain('Pyroblast');
  });

  it('shows each deck grouped by type, with each card’s Δ as a signed chip', async () => {
    server();
    renderWith(<RunPage runId={RUN} />, fakeLive().live);
    const deckA = await screen.findByRole('region', { name: "Agent A's deck" });
    await waitFor(() => expect(within(deckA).getByText('Creature · 4')).toBeTruthy());
    expect(within(deckA).getByText('Land · 48')).toBeTruthy();
    expect(within(deckA).getByText('Instant · 4')).toBeTruthy();
    expect(within(deckA).getByText('Sorcery · 4')).toBeTruthy();
    const bolt = within(deckA).getByTestId('deck-card-bolt');
    await waitFor(() => expect(within(bolt).getByTestId('delta').textContent).toBe('▲+4.2'));
    expect(
      within(within(deckA).getByTestId('deck-card-chain')).getByTestId('delta').textContent,
    ).toBe('▼−8.7');
    // B's own statistics, not A's.
    const deckB = screen.getByRole('region', { name: "Agent B's deck" });
    expect(
      within(within(deckB).getByTestId('deck-card-bolt')).getByTestId('delta').textContent,
    ).toBe('▲+1.0');
    expect(within(deckA).getByRole('img', { name: /Mana curve: 0 at 0, 12 at 1/ })).toBeTruthy();
  });

  it('shows a card’s image and full statistics on hover, the weighted counts rounded', async () => {
    server();
    renderWith(<RunPage runId={RUN} />, fakeLive().live);
    const deckA = await screen.findByRole('region', { name: "Agent A's deck" });
    const row = await within(deckA).findByTestId('deck-card-goblin');
    await waitFor(() => expect(within(row).queryByTestId('delta')).not.toBeNull());
    fireEvent.mouseEnter(within(row).getByRole('button'));
    const inspector = within(row).getByTestId('card-inspector');
    expect(inspector.textContent).toContain('Goblin Guide');
    expect(inspector.textContent).toContain('≈13 of ≈30');
    expect(inspector.textContent).toContain('62%');
    expect(inspector.querySelector('img')?.getAttribute('src')).toBe('/img/goblin?size=normal');
    fireEvent.mouseLeave(within(row).getByRole('button'));
    expect(within(row).queryByTestId('card-inspector')).toBeNull();
  });

  it('lists every cycle newest first, and opens a change’s diff', async () => {
    const { calls } = server();
    renderWith(<RunPage runId={RUN} />, fakeLive().live);
    const timeline = await screen.findByRole('table', { name: 'Timeline' });
    await waitFor(() =>
      expect(
        within(timeline)
          .getAllByRole('row')
          .slice(1)
          .map((row) => row.dataset.testid),
      ).toEqual(['cycle-3', 'cycle-2', 'cycle-1']),
    );
    expect(
      within(screen.getByTestId('cycle-3')).getByText(/nothing the engine can play/),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId('cycle-2')).getByRole('link', { name: '2' }).getAttribute('href'),
    ).toBe(`/runs/${RUN}/cycles/2`);
    fireEvent.click(within(screen.getByTestId('cycle-2')).getByRole('button', { name: 'Diff' }));
    const diff = await screen.findByRole('list', { name: "Cycle 2's change" });
    await waitFor(() =>
      expect(diff.textContent).toBe('− 4 Shock (main)+ 4 Chain Lightning (main)'),
    );
    expect(count(calls, `${base}/cycles/2`)).toBe(1);
  });

  it('follows the run live: its pace, a finished cycle, a changed deck, an applied ban', async () => {
    const { calls } = server();
    const handle = fakeLive();
    const view = renderWith(<RunPage runId={RUN} />, handle.live);
    await screen.findByRole('table', { name: 'Timeline' });
    inAct(() => handle.socket.open());
    expect(handle.socket.sent).toContainEqual({ subscribe: 'run', runId: RUN });

    inAct(() =>
      handle.socket.deliver({
        type: 'runStatus',
        runId: RUN,
        name: 'Mono red mirror',
        status: 'running',
        playing: true,
        cycle: 4,
        matchesDone: 3,
        matchesPlanned: 10,
        gamesPerSecond: 12.34,
        etaSeconds: 20,
      }),
    );
    expect(screen.getByTestId('pace').textContent).toBe('12.3 games/s');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('3');

    const statsBefore = count(calls, `${base}/stats`);
    const runBefore = calls.filter((call) => call.path === base).length;
    inAct(() =>
      handle.socket.deliver({
        type: 'cycleFinished',
        runId: RUN,
        cycle: {
          ...cycles[0],
          number: 4,
          change: { agent: 'B', generation: 1, shape: 'replace', reason: 'B cut a card' },
          unchanged: null,
        } as (typeof cycles)[number],
      }),
    );
    expect(await screen.findByTestId('cycle-4')).toBeTruthy();
    expect(screen.getByTestId('line-A').getAttribute('points')?.split(' ')).toHaveLength(4);
    // B's change is marked on B's line, in B's colour.
    expect(screen.getAllByTestId('change-mark').map((mark) => mark.getAttribute('fill'))).toEqual([
      '#1b8fd0',
      '#e8672a',
    ]);
    const [x, y] =
      screen.getByTestId('line-B').getAttribute('points')?.split(' ')[3]?.split(',') ?? [];
    const mark = screen.getAllByTestId('change-mark')[1];
    expect(Number(mark?.getAttribute('cx'))).toBeCloseTo(Number(x));
    expect(Number(mark?.getAttribute('cy'))).toBeCloseTo(Number(y));
    await waitFor(() => expect(count(calls, `${base}/stats`)).toBe(statsBefore + 2));
    expect(calls.filter((call) => call.path === base).length).toBe(runBefore + 1);

    const bansBefore = count(calls, `${base}/bans`);
    inAct(() =>
      handle.socket.deliver({
        type: 'banApplied',
        runId: RUN,
        event: {
          oracleId: 'bolt',
          action: 'ban',
          note: '',
          by: 'operator',
          at: 't',
          appliedAfterGameId: '7:cycle-4:match-3:game-1',
        },
      }),
    );
    await waitFor(() => expect(count(calls, `${base}/bans`)).toBe(bansBefore + 1));

    view.unmount();
    expect(handle.socket.sent.at(-1)).toEqual({ unsubscribe: 'run', runId: RUN });
  });
});

describe('the ban console', () => {
  it('shows the list, the legalisations it caused, and the trail', async () => {
    server();
    renderWith(<RunPage runId={RUN} />, fakeLive().live);
    const console = await screen.findByRole('region', { name: 'Ban console' });
    expect((await within(console).findByRole('list', { name: 'Ban list' })).textContent).toContain(
      'Pyroblast restricted',
    );
    const legalised = within(console).getByRole('list', {
      name: "Agent B's legalisation in cycle 2",
    });
    await waitFor(() =>
      expect(legalised.textContent).toBe('− 14 Pyroblast (side)+ 14 Forest (side)'),
    );
    expect(within(console).getByRole('list', { name: 'Ban history' }).textContent).toContain(
      'in effect from cycle 2',
    );
  });

  it('says which agent a ban would catch before it is made, then makes it with its note', async () => {
    const { calls } = server();
    renderWith(<RunPage runId={RUN} />, fakeLive().live);
    const console = await screen.findByRole('region', { name: 'Ban console' });
    fireEvent.change(within(console).getByLabelText('Search any card'), {
      target: { value: 'goblin' },
    });
    fireEvent.click(await within(console).findByRole('button', { name: /Goblin Guide/ }));
    expect(within(console).getByTestId('ban-effect').textContent).toBe(
      'Agent A holds 4 and must cut to 0; Agent B holds 4 and must cut to 0',
    );
    fireEvent.click(within(console).getByLabelText('restricted'));
    expect(within(console).getByTestId('ban-effect').textContent).toBe(
      'Agent A holds 4 and must cut to 1; Agent B holds 4 and must cut to 1',
    );
    fireEvent.change(within(console).getByLabelText('Note'), { target: { value: 'too fast' } });
    fireEvent.click(within(console).getByRole('button', { name: 'Restrict' }));

    await waitFor(() =>
      expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({
        status: 'restricted',
        note: 'too fast',
      }),
    );
    // Pending on a run no worker is playing: it waits for the run's next cycle.
    expect((await within(console).findByRole('status')).textContent).toContain(
      'takes effect when the run next plays',
    );
  });

  it('says an edit on a run being played takes effect after the game in progress, and unbans', async () => {
    const { calls } = server({
      bans: banState({
        playing: true,
        history: [
          {
            oracleId: 'pyro',
            action: 'ban',
            note: '',
            by: 'operator',
            at: 't',
            appliedAfterGameId: null,
          },
        ],
      }),
    });
    renderWith(<RunPage runId={RUN} />, fakeLive().live);
    const console = await screen.findByRole('region', { name: 'Ban console' });
    // The run was fetched idle; the ban state, answered since, says a worker has it now.
    expect((await within(console).findByRole('status')).textContent).toContain(
      'takes effect after the game in progress',
    );
    fireEvent.click(within(console).getByRole('button', { name: 'Unban Pyroblast' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'DELETE')).toBe(true));
    await waitFor(() =>
      expect(within(console).getByText('Nothing banned or restricted.')).toBeTruthy(),
    );
  });
});
