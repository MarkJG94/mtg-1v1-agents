import { cardDetailSchema, coverageSchema } from '@mtg/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cards, summaryOf } from '../test/fixtures.js';
import { fakeLive, fakeServer, inAct, renderWith } from '../test/harness.js';
import { CardsPage } from './CardsPage.js';

/** Cards & coverage (docs/08 page 6; roadmap 6.6). */

const parser = {
  quick: false,
  measuredAt: '2026-10-01T03:00:00.000Z',
  counts: {
    cards: 1000,
    supported: 109,
    partial: 800,
    unsupported: 81,
    unscripted: 10,
    withoutRulesText: 20,
    supportedWithText: 89,
    sentences: 4000,
    sentencesClaimed: 800,
    sentencesFallout: 300,
  },
  patterns: [
    {
      pattern: 'enchant creature',
      count: 90,
      finishes: 0,
      example: { card: 'Aura', sentence: 'Enchant creature' },
    },
    {
      pattern: 'at the beginning of your upkeep',
      count: 70,
      finishes: 30,
      example: { card: 'Thopter Assembly', sentence: 'At the beginning of your upkeep, …' },
    },
  ],
};

const coverage = (withReport = true) =>
  coverageSchema.parse({
    cards: 1200,
    scripted: { supported: 131, partial: 827, unsupported: 24 },
    mostRequested: [
      {
        oracleId: 'pyro',
        name: 'Pyroblast',
        requests: 7,
        lastReason: 'auto script is partial',
        failing: 'Destroy target permanent if it’s blue.',
      },
      {
        oracleId: 'odd',
        name: 'Odd Card',
        requests: 2,
        lastReason: 'auto script is unsupported',
        failing: null,
      },
    ],
    parser: withReport ? parser : null,
  });

const pyroblast = cardDetailSchema.parse({
  ...summaryOf(cards.pyro),
  support: 'partial',
  oracleText: cards.pyro.oracleText,
  power: null,
  toughness: null,
  loyalty: null,
  keywords: [],
  script: {
    status: 'partial',
    source: 'auto',
    reasons: [{ check: 'coverage', message: 'sentence 1 is not claimed by any ability' }],
    updatedAt: '2026-10-01T03:00:00.000Z',
  },
  stats: { runs: 2, games: 40, gamesDrawn: 10, winsDrawn: 6, gamesNotDrawn: 30, winsNotDrawn: 12 },
  unsupportedRequests: 7,
  sentences: [
    { text: 'Choose one —', claimed: true },
    { text: 'Destroy target permanent if it’s blue.', claimed: false },
  ],
});

const server = (options: { report?: boolean } = {}) => {
  let scripted = 0;
  const handle = fakeServer({
    'GET /api/coverage': () => ({ body: coverage(options.report ?? true) }),
    'GET /api/cards/pyro': () => ({ body: pyroblast }),
    'POST /api/cards/pyro/script': () => {
      scripted += 1;
      return {
        body: { oracleId: 'pyro', status: 'supported', source: 'auto', reasons: [] },
      };
    },
    'GET /api/cards': (call) => {
      const q = new URL(call.path, 'http://x').searchParams.get('q') ?? '';
      const found = Object.values(cards)
        .filter((card) => card.name.toLowerCase().includes(q.toLowerCase()))
        .map(summaryOf);
      return { body: { cards: found } };
    },
  });
  return { ...handle, scripted: () => scripted };
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the coverage totals', () => {
  it('say how much of Scryfall the parser scripts, split by verdict, and what this server has', async () => {
    server();
    renderWith(<CardsPage oracleId={null} />, fakeLive().live);
    expect((await screen.findByTestId('supported-share')).textContent).toBe('10.9%');
    expect(screen.getAllByTestId('share').map((share) => share.textContent)).toEqual([
      '✓supported109 (10.9%)',
      '◐partial800 (80.0%)',
      '✕unsupported81 (8.1%)',
      '?unscripted10 (1.0%)',
    ]);
    const totals = screen.getByRole('region', { name: 'Coverage' });
    expect(totals.textContent).toContain(
      '800 of 4,000 sentences read (20.0%) · measured 01/10/2026',
    );
    expect(screen.getByTestId('cache-totals').textContent).toBe(
      'This server has scripted 982 of its 1,200 cards: 131 supported, 827 partial, 24 unsupported.',
    );
  });

  it('give no date for a report that does not say when it was measured', async () => {
    fakeServer({
      'GET /api/coverage': () => ({
        body: { ...coverage(), parser: { ...parser, measuredAt: null } },
      }),
    });
    renderWith(<CardsPage oracleId={null} />, fakeLive().live);
    const totals = await screen.findByRole('region', { name: 'Coverage' });
    await waitFor(() => expect(totals.textContent).toContain('sentences read (20.0%)'));
    expect(totals.textContent).not.toContain('measured');
  });

  it('say where the report comes from when the server has none', async () => {
    server({ report: false });
    renderWith(<CardsPage oracleId={null} />, fakeLive().live);
    expect((await screen.findByTestId('no-report')).textContent).toContain('pnpm cards:coverage');
    expect(screen.queryByRole('table', { name: 'Failing patterns' })).toBeNull();
  });
});

describe('the most-requested cards', () => {
  it('list each with how often it was asked for and the sentence that stopped it', async () => {
    server();
    renderWith(<CardsPage oracleId={null} />, fakeLive().live);
    const rows = await screen.findAllByTestId('requested-row');
    expect(rows.map((row) => row.querySelector('td')?.textContent)).toEqual([
      'Pyroblast',
      'Odd Card',
    ]);
    expect(within(rows[0] as HTMLElement).getByTestId('unread').textContent).toBe(
      '✕ Not read: Destroy target permanent if it’s blue.',
    );
    // With no unread sentence to show, the reason it was refused.
    expect(rows[1]?.textContent).toContain('auto script is unsupported');
    expect(
      within(rows[0] as HTMLElement)
        .getByRole('link')
        .getAttribute('href'),
    ).toBe('/cards/pyro');
  });

  it('scripts a card again on asking, says how it came out, and asks for the totals again', async () => {
    const handle = server();
    renderWith(<CardsPage oracleId={null} />, fakeLive().live);
    const rows = await screen.findAllByTestId('requested-row');
    const before = handle.calls.filter((call) => call.path === '/api/coverage').length;
    fireEvent.click(within(rows[0] as HTMLElement).getByRole('button', { name: 'Try to script' }));
    expect((await screen.findByTestId('script-result')).textContent).toBe('✓supported');
    expect(handle.scripted()).toBe(1);
    await waitFor(() =>
      expect(handle.calls.filter((call) => call.path === '/api/coverage').length).toBe(before + 1),
    );
  });

  it('are asked for again when a run asks for a card it cannot have', async () => {
    const handle = server();
    const live = fakeLive();
    renderWith(<CardsPage oracleId={null} />, live.live);
    await screen.findAllByTestId('requested-row');
    inAct(() => live.socket.open());
    expect(live.socket.sent).toContainEqual({ subscribe: 'runs' });
    const before = handle.calls.filter((call) => call.path === '/api/coverage').length;
    inAct(() =>
      live.socket.deliver({
        type: 'unsupportedCard',
        runId: 'run-1',
        oracleId: 'odd',
        name: 'Odd Card',
        reason: 'auto script is unsupported',
      }),
    );
    await waitFor(() =>
      expect(handle.calls.filter((call) => call.path === '/api/coverage').length).toBe(before + 1),
    );
  });
});

it('ranks the templates to teach by the cards they would finish', async () => {
  server();
  renderWith(<CardsPage oracleId={null} />, fakeLive().live);
  const rows = await screen.findAllByTestId('pattern-row');
  expect(rows.map((row) => row.querySelector('code')?.textContent)).toEqual([
    'at the beginning of your upkeep',
    'enchant creature',
  ]);
});

describe('a card', () => {
  it('shows its rules text a sentence at a time, read or not, with its verdict and record', async () => {
    server();
    renderWith(<CardsPage oracleId="pyro" />, fakeLive().live);
    const panel = await screen.findByTestId('card-panel');
    expect(
      within(panel)
        .getAllByTestId('sentence')
        .map((sentence) => [sentence.textContent, sentence.getAttribute('data-claimed')]),
    ).toEqual([
      ['✓ Read: Choose one —', 'true'],
      ['✕ Not read: Destroy target permanent if it’s blue.', 'false'],
    ]);
    expect(panel.textContent).toContain('auto script');
    expect(panel.textContent).toContain('Why: 1 finding');
    const record = within(panel).getByTestId('card-record');
    expect(record.textContent).toContain('2 runs, ≈40 games');
    expect(record.textContent).toContain('Won when drawn60.0%');
    expect(record.textContent).toContain('Won when not40.0%');
  });

  it('is found by a search, and opened from it', async () => {
    const handle = server();
    renderWith(<CardsPage oracleId={null} />, fakeLive().live);
    fireEvent.change(screen.getByLabelText('Search every card'), { target: { value: 'light' } });
    // Asked for once the typing stops, a quarter of a second on.
    const results = await screen.findByRole('list', { name: 'Search results' }, { timeout: 2_000 });
    await waitFor(() =>
      expect(
        within(results)
          .getAllByRole('button')
          .map((button) => button.textContent),
      ).toEqual(['Lightning BoltInstant✓supported', 'Chain LightningSorcery✓supported']),
    );
    expect(handle.calls.some((call) => call.path === '/api/cards?q=light&limit=20')).toBe(true);
    fireEvent.click(within(results).getAllByRole('button')[0] as HTMLElement);
    expect(window.location.pathname).toBe('/cards/bolt');
  });

  it('does not search on one letter', async () => {
    const handle = server();
    renderWith(<CardsPage oracleId={null} />, fakeLive().live);
    fireEvent.change(screen.getByLabelText('Search every card'), { target: { value: 'l' } });
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(handle.calls.some((call) => call.path.startsWith('/api/cards?'))).toBe(false);
  });
});
