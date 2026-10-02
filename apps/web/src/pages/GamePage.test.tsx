import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GAME, gameDetail, gameEvents, gameLog, lookup } from '../test/fixtures.js';
import { fakeLive, fakeServer, renderWith } from '../test/harness.js';
import { GamePage } from './GamePage.js';

/** A game's replay (docs/08 "Game viewer"; roadmap 6.5). */

const server = () =>
  fakeServer({
    [`GET /api/games/${GAME}`]: () => ({ body: gameDetail }),
    [`GET /api/games/${GAME}/log`]: () => ({ body: gameLog }),
    'POST /api/cards/lookup': (call) => lookup(call.body),
  });

const open = async () => {
  server();
  renderWith(<GamePage gameId={GAME} />, fakeLive().live);
  await screen.findByRole('region', { name: 'Transport' });
  // The cards' names arrive with the lookup.
  await screen.findAllByText(/Goblin Guide/);
};

const press = (key: string, options: { shiftKey?: boolean } = {}) =>
  fireEvent.keyDown(window, { key, ...options });
const position = () => screen.getByTestId('position').textContent;
const row = (name: string) => screen.getByRole('list', { name });
const ticker = () => screen.getByRole('region', { name: 'Ticker' });
const current = () =>
  within(ticker())
    .getAllByTestId('ticker-line')
    .find((line) => line.getAttribute('aria-current') === 'step')?.textContent;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the replay of a game', () => {
  it('opens before the first event, with where the game was played and how it ended', async () => {
    await open();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain(
      'A on the play · A won (concede) in 3 turns',
    );
    expect(position()).toContain(`event 0 of ${gameEvents.length}`);
    expect(screen.getByTestId('turn-step').textContent).toBe('Before the first turn');
    expect(screen.getByRole('link', { name: 'Cycle 2' }).getAttribute('href')).toBe(
      '/runs/run-1/cycles/2',
    );
  });

  it('steps by what the ticker tells, forward and back, with the board following', async () => {
    await open();
    const next = screen.getByRole('button', { name: 'Next event' });
    fireEvent.click(next); // B chooses A
    fireEvent.click(next); // A keeps
    fireEvent.click(next); // B keeps: the opening hands are dealt
    expect(
      within(row('A hand'))
        .getAllByRole('button')
        .map((chip) => chip.textContent),
    ).toEqual(['Goblin Guide', 'Lightning Bolt', 'Mountain']);
    fireEvent.click(next); // Turn 1
    fireEvent.click(next); // A plays Mountain
    expect(current()).toContain('A plays Mountain');
    expect(within(row('A lands')).getByRole('button').textContent).toBe('Mountain');
    fireEvent.click(next); // A casts Goblin Guide: on the stack, the land tapped for it
    const stack = screen.getByRole('region', { name: 'Stack' });
    expect(within(stack).getByRole('button').textContent).toContain('Goblin Guide');
    expect(within(row('A lands')).getByRole('button').getAttribute('aria-label')).toBe(
      'Mountain, tapped',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Previous event' }));
    expect(current()).toContain('A plays Mountain');
    expect(within(stack).queryByRole('button')).toBeNull();
  });

  it('steps by turn, and from inside a turn back to its start', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Next turn' }));
    expect(current()).toBe('Turn 1 — A');
    fireEvent.click(screen.getByRole('button', { name: 'Next turn' }));
    expect(current()).toBe('Turn 2 — B');
    expect(screen.getByTestId('turn-step').textContent).toContain('Turn 2 · B');
    fireEvent.click(screen.getByRole('button', { name: 'Next event' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous turn' }));
    expect(current()).toBe('Turn 2 — B');
    fireEvent.click(screen.getByRole('button', { name: 'Previous turn' }));
    expect(current()).toBe('Turn 1 — A');
  });

  it('shows combat, damage and life, and the end, as the game reaches them', async () => {
    await open();
    const attack = gameEvents.findIndex((event) => event.type === 'attack');
    fireEvent.change(screen.getByLabelText('Position'), { target: { value: String(attack + 1) } });
    expect(within(row('A creatures')).getByRole('button').getAttribute('aria-label')).toBe(
      'Goblin Guide, 2/2, attacking',
    );
    const shock = gameEvents.findIndex(
      (event) => event.type === 'damage' && event.target.kind === 'object',
    );
    fireEvent.change(screen.getByLabelText('Position'), { target: { value: String(shock + 1) } });
    expect(within(row('A creatures')).getByRole('button').getAttribute('aria-label')).toBe(
      'Goblin Guide, 2/2, 2 damage',
    );
    expect(screen.getByTestId('life-B').textContent).toBe('Life 18');
    fireEvent.click(screen.getByRole('button', { name: 'End' }));
    expect(within(row('A creatures')).queryByRole('button')).toBeNull();
    expect(screen.getByRole('button', { name: 'A graveyard: 3' })).toBeTruthy();
    expect(screen.getByTestId('life-B').textContent).toBe('Life 15');
    expect(screen.getByTestId('board').textContent).toContain('A wins · concede');
  });

  it('keeps B’s hand face down until hidden information is revealed', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Next turn' }));
    expect(within(row('B hand')).getAllByTestId('hidden-card')).toHaveLength(2);
    expect(within(row('B hand')).queryByRole('button')).toBeNull();
    expect(within(ticker()).queryByText('B draws Forest')).toBeNull();
    fireEvent.click(screen.getByLabelText('Reveal hidden information'));
    expect(
      within(row('B hand'))
        .getAllByRole('button')
        .map((chip) => chip.textContent),
    ).toEqual(['Shock', 'Pyroblast']);
    expect(within(ticker()).getByText('B draws Forest')).toBeTruthy();
  });

  it('shows a card’s image and oracle text on hover, and only the text with art off', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Next turn' }));
    const goblin = within(row('A hand')).getByRole('button', { name: 'Goblin Guide' });
    fireEvent.mouseEnter(goblin);
    const card = screen.getByTestId('hover-card');
    expect(within(card).getByTestId('oracle-text').textContent).toBe('Haste');
    expect(card.querySelector('img')?.getAttribute('src')).toBe('/img/goblin?size=normal');
    fireEvent.mouseLeave(goblin);
    expect(screen.queryByTestId('hover-card')).toBeNull();
    fireEvent.click(screen.getByLabelText('Card art'));
    fireEvent.focus(goblin);
    expect(screen.getByTestId('hover-card').querySelector('img')).toBeNull();
    expect(screen.getByTestId('oracle-text').textContent).toBe('Haste');
  });

  it('tells the game in the ticker with each decision’s evaluation, and goes where a line is clicked', async () => {
    await open();
    const scores = within(ticker()).getAllByTestId('score');
    expect(scores.map((score) => score.textContent)).toEqual(['+2.0', '+3.0', '−1.5']);
    fireEvent.click(within(ticker()).getByText('B casts Shock targeting Goblin Guide'));
    expect(current()).toBe('B casts Shock targeting Goblin Guide−1.5');
    expect(
      within(screen.getByRole('region', { name: 'Stack' })).getByRole('button').textContent,
    ).toBe('Shock');
  });

  it('plays at the chosen speed and stops at the end', async () => {
    await open();
    vi.useFakeTimers();
    fireEvent.change(screen.getByLabelText('Speed'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    // 800 ms a line at 1×, so 400 at 2×: one line a tick, each scheduled as it renders.
    const tick = (ms: number) =>
      act(async () => {
        vi.advanceTimersByTime(ms);
      });
    await tick(399);
    expect(current()).toBeUndefined();
    await tick(1);
    expect(current()).toBe('B chooses to draw, so A plays first');
    await tick(400);
    await tick(400);
    expect(current()).toBe('B keeps 2');
    for (let i = 0; i < 40; i += 1) await tick(400);
    expect(position()).toContain(`event ${gameEvents.length} of ${gameEvents.length}`);
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
  });

  it('answers the keyboard: space, arrows, shift-arrows, home and end', async () => {
    await open();
    press('ArrowRight');
    expect(current()).toBe('B chooses to draw, so A plays first');
    press('ArrowRight', { shiftKey: true });
    expect(current()).toBe('Turn 1 — A');
    press(']');
    expect(current()).toBe('Turn 2 — B');
    press('ArrowLeft');
    expect(current()).toContain('Goblin Guide deals 2 damage to B');
    press('End');
    expect(position()).toContain(`event ${gameEvents.length} of`);
    press('Home');
    expect(position()).toContain('event 0 of');
    press('h');
    expect(screen.getByLabelText<HTMLInputElement>('Reveal hidden information').checked).toBe(true);
    press('+');
    expect(screen.getByLabelText<HTMLSelectElement>('Speed').value).toBe('2');
  });

  it('keeps the keys working after a switch is clicked, and leaves the scrub bar its own', async () => {
    await open();
    const reveal = screen.getByLabelText('Reveal hidden information');
    reveal.focus();
    fireEvent.keyDown(reveal, { key: 'End' });
    expect(position()).toContain(`event ${gameEvents.length} of`);
    const scrub = screen.getByLabelText('Position');
    fireEvent.keyDown(scrub, { key: 'Home' });
    expect(position()).toContain(`event ${gameEvents.length} of`);
  });

  it('marks each turn on the scrub bar, and goes to it', async () => {
    await open();
    const turns = within(screen.getByRole('list', { name: 'Turns' })).getAllByRole('button');
    expect(turns.map((turn) => turn.getAttribute('aria-label'))).toEqual([
      'Turn 1',
      'Turn 2',
      'Turn 3',
    ]);
    fireEvent.click(turns[2] as HTMLElement);
    expect(current()).toBe('Turn 3 — A');
  });

  it('says so when the game kept no log', async () => {
    fakeServer({
      [`GET /api/games/${GAME}`]: () => ({ body: { ...gameDetail, hasLog: false } }),
      [`GET /api/games/${GAME}/log`]: () => ({
        status: 404,
        body: { error: { code: 'not_found', message: `the event log of game ${GAME} not found` } },
      }),
    });
    renderWith(<GamePage gameId={GAME} />, fakeLive().live);
    expect((await screen.findByRole('alert')).textContent).toContain('event log');
  });
});
