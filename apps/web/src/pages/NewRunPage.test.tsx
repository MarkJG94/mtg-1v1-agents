import type { ResolvedCard, SeedDeckPreview } from '@mtg/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Call, fakeLive, fakeServer, renderWith } from '../test/harness.js';
import { defaultSettings, NewRunPage } from './NewRunPage.js';

/** The new-run form (docs/08 "New run"; roadmap 6.3). */

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const preview = (seed: string): SeedDeckPreview => ({
  seed,
  colours: ['R'],
  lands: 20,
  nonbasicLands: 0,
  main: [
    {
      oracleId: ID(1),
      name: 'Mountain',
      count: 20,
      typeLine: 'Basic Land — Mountain',
      manaValue: 0,
      support: 'supported',
    },
    {
      oracleId: ID(2),
      name: 'Lightning Bolt',
      count: 40,
      typeLine: 'Instant',
      manaValue: 1,
      support: 'supported',
    },
  ],
  side: [
    {
      oracleId: ID(3),
      name: 'Pyroblast',
      count: 15,
      typeLine: 'Instant',
      manaValue: 1,
      support: 'supported',
    },
  ],
  rerolled: [],
});

const catalogue: Record<string, ResolvedCard> = {
  mountain: { query: '', oracleId: ID(1), name: 'Mountain', support: 'supported' },
  'lightning bolt': { query: '', oracleId: ID(2), name: 'Lightning Bolt', support: 'supported' },
  pyroblast: { query: '', oracleId: ID(3), name: 'Pyroblast', support: 'supported' },
  'black lotus': { query: '', oracleId: ID(4), name: 'Black Lotus', support: 'unsupported' },
};

const resolve = (call: Call) => {
  const { names } = call.body as { names: string[] };
  return {
    body: {
      cards: names
        .map(
          (name) =>
            ({ ...catalogue[name.toLowerCase()], query: name }) as ResolvedCard & {
              query: string;
            },
        )
        .map((card, index) =>
          card.oracleId === undefined
            ? { query: names[index] ?? '', oracleId: null, name: null, support: null }
            : card,
        ),
    },
  };
};

const created = {
  id: 'new-run',
  name: 'x',
  status: 'created',
  seed: '1',
  agentLevel: 'search',
  createdAt: '2026-01-01T00:00:00Z',
  forkedFrom: null,
  cycles: 0,
  currentCycle: null,
  playing: false,
  winRates: [],
  lastChange: null,
};

const server = () =>
  fakeServer({
    'POST /api/seed-decks': (call) => {
      const { settings } = call.body as { settings: { seed?: string } };
      return { body: preview(settings.seed ?? '424242') };
    },
    'POST /api/cards/resolve': resolve,
    'POST /api/runs': () => ({ status: 201, body: created }),
  });

const bodyOf = (calls: readonly Call[], path: string) =>
  calls.filter((call) => call.method === 'POST' && call.path === path).at(-1)?.body as
    | Record<string, unknown>
    | undefined;

const createButton = () => screen.getByRole('button', { name: 'Create run' });

beforeEach(() => window.history.replaceState(null, '', '/runs/new'));
afterEach(() => vi.unstubAllGlobals());

describe('the new-run form', () => {
  it('starts from docs/05’s defaults, read from the settings schema', () => {
    const defaults = defaultSettings();
    expect(defaults).toMatchObject({
      matchesPerCycle: 100,
      tieMargin: 0.04,
      tiebreakMatches: 30,
      agentLevel: 'search',
      seedDeckLands: 24,
      legalityFilter: 'vintage',
    });
    expect(defaults).not.toHaveProperty('seed');
    renderWith(<NewRunPage />, fakeLive().live);
    expect((screen.getByLabelText('Matches per cycle') as HTMLInputElement).value).toBe('100');
    expect((screen.getByLabelText('Agent level') as HTMLSelectElement).value).toBe('search');
  });

  it('will not create a run without a name, or with settings out of range', () => {
    server();
    renderWith(<NewRunPage />, fakeLive().live);
    expect(createButton().hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('blockers').textContent).toContain('the run needs a name');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Mono red' } });
    expect(createButton().hasAttribute('disabled')).toBe(false);
    fireEvent.change(screen.getByLabelText('Tie margin'), { target: { value: '0.9' } });
    expect(createButton().hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('blockers').textContent).toMatch(/tieMargin/);
  });

  it('holds an explicit colour choice to three (decision D17)', () => {
    renderWith(<NewRunPage />, fakeLive().live);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x' } });
    for (const colour of ['W', 'U', 'B'])
      fireEvent.click(screen.getByRole('button', { name: colour }));
    expect(createButton().hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'R' }));
    expect(screen.getByTestId('blockers').textContent).toContain('at most 3 colours');
  });

  it('rolls a preview of the 75, fills in its seed, and makes the run with that seed', async () => {
    const { calls } = server();
    renderWith(<NewRunPage />, fakeLive().live);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Mono red' } });
    fireEvent.click(screen.getByRole('button', { name: 'Roll' }));

    const shown = await screen.findByTestId('preview');
    expect(bodyOf(calls, '/api/seed-decks')).toMatchObject({
      settings: { matchesPerCycle: 100, seedDeck: 'constrainedRandom' },
      bans: [],
    });
    expect(bodyOf(calls, '/api/seed-decks')?.settings).not.toHaveProperty('seed');
    expect((screen.getByLabelText('Seed (empty for a random one)') as HTMLInputElement).value).toBe(
      '424242',
    );
    const main = within(shown).getByRole('list', { name: 'Main' });
    const tiles = within(main).getAllByTestId('card-tile');
    // Cheapest first, lands last.
    expect(tiles.map((tile) => within(tile).getByRole('img').getAttribute('alt'))).toEqual([
      'Lightning Bolt',
      'Mountain',
    ]);
    expect(
      within(tiles[0] as HTMLElement)
        .getByRole('img')
        .getAttribute('src'),
    ).toBe(`/img/${ID(2)}?size=small`);
    expect(within(shown).getByText('Main · 60')).toBeTruthy();
    expect(within(shown).getByText('Sideboard · 15')).toBeTruthy();
    expect(within(shown).getAllByText('supported')).toHaveLength(3);

    fireEvent.click(createButton());
    await waitFor(() => expect(window.location.pathname).toBe('/runs/new-run'));
    const body = bodyOf(calls, '/api/runs');
    expect(body).toMatchObject({ name: 'Mono red', settings: { seed: '424242' }, bans: [] });
    expect(body).not.toHaveProperty('seedDeck');
  });

  it('previews a seed typed in, rolls a new one on request, and warns when the preview is stale', async () => {
    const { calls } = server();
    renderWith(<NewRunPage />, fakeLive().live);
    const seed = screen.getByLabelText('Seed (empty for a random one)');
    fireEvent.change(seed, { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: 'Roll' }));
    await screen.findByText('99');
    expect(bodyOf(calls, '/api/seed-decks')).toMatchObject({ settings: { seed: '99' } });
    expect(screen.queryByRole('status')).toBeNull();

    fireEvent.change(screen.getByLabelText('Lands'), { target: { value: '17' } });
    expect(screen.getByRole('status').textContent).toMatch(/the run will get a different deck/);
    fireEvent.change(screen.getByLabelText('Lands'), { target: { value: '24' } });
    expect(screen.queryByRole('status')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Roll a new seed' }));
    await waitFor(() => expect((seed as HTMLInputElement).value).toBe('424242'));
    expect(bodyOf(calls, '/api/seed-decks')?.settings).not.toHaveProperty('seed');
  });

  it('shows a card as text when its image does not load', async () => {
    server();
    renderWith(<NewRunPage />, fakeLive().live);
    fireEvent.click(screen.getByRole('button', { name: 'Roll' }));
    const shown = await screen.findByTestId('preview');
    const image = within(shown).getByAltText('Pyroblast');
    fireEvent.error(image);
    expect(within(shown).queryByAltText('Pyroblast')).toBeNull();
    expect(within(shown).getAllByText('Instant · 1').length).toBeGreaterThan(0);
  });

  it('checks a pasted list card by card, and makes the run with that 75', async () => {
    const { calls } = server();
    renderWith(<NewRunPage />, fakeLive().live);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Pasted' } });
    fireEvent.click(screen.getByLabelText('Paste a decklist'));
    const list = screen.getByLabelText(/^Decklist/);
    fireEvent.change(list, {
      target: { value: '20 Mountain\n40 Lightning Bolt\n\n14 Pyroblast\n1 Black Lotus\n1 Nope' },
    });

    // The counts are known at once; the cards once the server has answered.
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Problems' }))
          .getAllByRole('listitem')
          .map((item) => item.textContent),
      ).toEqual([
        'line 5: Black Lotus cannot be played yet (its script is unsupported)',
        'line 6: no card is named “Nope”',
        'the sideboard has 16 cards, not 15',
      ]),
    );
    expect(bodyOf(calls, '/api/cards/resolve')).toEqual({
      names: ['Mountain', 'Lightning Bolt', 'Pyroblast', 'Black Lotus', 'Nope'],
      script: true,
    });
    expect(createButton().hasAttribute('disabled')).toBe(true);

    fireEvent.change(list, { target: { value: '20 Mountain\n40 lightning bolt\n\n15 Pyroblast' } });
    await screen.findByText('The 75 is ready.');
    // A name already asked about, in another case, is not asked about again — given the
    // time to be, past the wait before asking.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(calls.filter((call) => call.path === '/api/cards/resolve')).toHaveLength(1);
    expect(screen.getByTestId('paste-counts').textContent).toBe('Main 60/60 · Sideboard 15/15');

    fireEvent.click(createButton());
    await waitFor(() => expect(window.location.pathname).toBe('/runs/new-run'));
    expect(bodyOf(calls, '/api/runs')).toMatchObject({
      settings: { seedDeck: 'fixed' },
      seedDeck: {
        main: [
          { oracleId: ID(1), count: 20 },
          { oracleId: ID(2), count: 40 },
        ],
        side: [{ oracleId: ID(3), count: 15 }],
      },
    });
  });

  it('bans pasted names, sends the list with the roll and the run, and holds a pasted deck to it', async () => {
    const { calls } = server();
    renderWith(<NewRunPage />, fakeLive().live);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Banned' } });
    fireEvent.change(screen.getByLabelText('Or paste names, one a line, to ban'), {
      target: { value: '4 Pyroblast\nNope' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add pasted names' }));
    const bans = await screen.findByRole('table', { name: 'Ban list' });
    expect(within(bans).getByText('Pyroblast')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('No card is named “Nope”.');
    expect(bodyOf(calls, '/api/cards/resolve')).toEqual({
      names: ['Pyroblast', 'Nope'],
      script: false,
    });

    fireEvent.change(screen.getByLabelText('Status of Pyroblast'), {
      target: { value: 'restricted' },
    });
    fireEvent.change(screen.getByLabelText('Note on Pyroblast'), { target: { value: 'too good' } });
    fireEvent.click(screen.getByRole('button', { name: 'Roll' }));
    await screen.findByTestId('preview');
    expect(bodyOf(calls, '/api/seed-decks')?.bans).toEqual([
      { oracleId: ID(3), status: 'restricted', note: 'too good' },
    ]);

    fireEvent.click(screen.getByLabelText('Paste a decklist'));
    fireEvent.change(screen.getByLabelText(/^Decklist/), {
      target: { value: '20 Mountain\n40 Lightning Bolt\n\n15 Pyroblast' },
    });
    await waitFor(() =>
      expect(screen.getByRole('list', { name: 'Problems' }).textContent).toBe(
        'Pyroblast is restricted to one copy, and the deck has 15',
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove Pyroblast' }));
    await screen.findByText('The 75 is ready.');
    fireEvent.click(createButton());
    await waitFor(() => expect(window.location.pathname).toBe('/runs/new-run'));
    expect(bodyOf(calls, '/api/runs')?.bans).toEqual([]);
  });

  it('shows why the server refused the run', async () => {
    fakeServer({
      'POST /api/runs': () => ({
        status: 503,
        body: { error: { code: 'no_card_data', message: 'no Scryfall data has been fetched' } },
      }),
    });
    renderWith(<NewRunPage />, fakeLive().live);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x' } });
    fireEvent.click(createButton());
    expect((await screen.findByRole('alert')).textContent).toBe(
      'no Scryfall data has been fetched (no_card_data)',
    );
    expect(window.location.pathname).toBe('/runs/new');
  });
});
