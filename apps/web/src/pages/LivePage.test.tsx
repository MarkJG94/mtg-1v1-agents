import type { GameEvent } from '@mtg/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gameEvents, gameLog, gameObjects, lookup, RUN, runDetail } from '../test/fixtures.js';
import { fakeLive, fakeServer, inAct, renderWith } from '../test/harness.js';
import { LivePage } from './LivePage.js';

/** A run's games as they are played (docs/08 "Game viewer", live mode; roadmap 6.5). */

const server = () =>
  fakeServer({
    [`GET /api/runs/${RUN}`]: () => ({ body: runDetail }),
    'POST /api/cards/lookup': (call) => lookup(call.body),
  });

const start = (seed: string, game: number, catchUp = false) => ({
  type: 'gameStart' as const,
  runId: RUN,
  seed,
  cycle: 2,
  match: 0,
  game,
  chosenBy: 'B' as const,
  decks: { A: gameLog.players.A.main, B: gameLog.players.B.main },
  generations: { A: 0, B: 0 },
  catchUp,
});

/** Events as the stream sends them, with the objects they name for the first time. */
const batch = (seed: string, events: readonly GameEvent[], named = new Set<number>()) => {
  const objects = gameObjects.filter((object) => {
    const mentioned = JSON.stringify(events).includes(`${object.id}`);
    if (!mentioned || named.has(object.id)) return false;
    named.add(object.id);
    return true;
  });
  return { type: 'gameEvents' as const, runId: RUN, seed, events: [...events], objects };
};

const end = (seed: string) => ({
  type: 'gameEnd' as const,
  runId: RUN,
  seed,
  onPlay: 'A' as const,
  winner: 'A' as const,
  reason: 'concede',
  turns: 3,
});

const watch = async (moveOnAfter = 0) => {
  server();
  const handle = fakeLive();
  renderWith(<LivePage runId={RUN} moveOnAfter={moveOnAfter} />, handle.live);
  inAct(() => handle.socket.open());
  await screen.findByText(/Waiting for the run’s next game/);
  return handle;
};

const position = () => screen.getByTestId('position').textContent;
const turnStep = () => screen.getByTestId('turn-step').textContent;
const turn2 = gameEvents.findIndex((event) => event.type === 'turnStart' && event.turn === 2);

afterEach(() => vi.unstubAllGlobals());

describe('watching a run live', () => {
  it('asks for the run’s games, and waits for one', async () => {
    const handle = await watch();
    expect(handle.socket.sent).toContainEqual({ subscribe: 'game', runId: RUN });
  });

  it('plays a game from its start at the viewer’s speed, however far ahead the stream is', async () => {
    const handle = await watch();
    inAct(() => handle.socket.deliver(start('g1', 1)));
    inAct(() => handle.socket.deliver(batch('g1', gameEvents)));
    inAct(() => handle.socket.deliver(end('g1')));
    // The whole game is here, and the board is at its start, playing.
    expect(position()).toContain(`event 0 of ${gameEvents.length}`);
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
    await waitFor(() => expect(position()).not.toContain(`event 0 of`), { timeout: 2_000 });
    expect(position()).not.toContain(`event ${gameEvents.length} of`);
  });

  it('follows the game’s edge on asking, naming its cards from the stream', async () => {
    const handle = await watch();
    const named = new Set<number>();
    inAct(() => handle.socket.deliver(start('g1', 1)));
    expect(screen.getByTestId('live-game').textContent).toContain('cycle 2 · match 1 · game 1');
    fireEvent.click(screen.getByRole('button', { name: 'Go live' }));
    inAct(() => handle.socket.deliver(batch('g1', gameEvents.slice(0, turn2), named)));
    expect(position()).toContain(`event ${turn2} of ${turn2} · in play`);
    expect(turnStep()).toContain('Turn 1 · A');
    await screen.findByRole('button', { name: 'Goblin Guide, 2/2' });
    inAct(() => handle.socket.deliver(batch('g1', gameEvents.slice(turn2), named)));
    expect(turnStep()).toContain('Turn 3 · A');
    inAct(() => handle.socket.deliver(end('g1')));
    expect(screen.getByTestId('live-game').textContent).toContain('A won');
    expect(position()).not.toContain('in play');
  });

  it('stops following when the transport is taken in hand, and goes live again on asking', async () => {
    const handle = await watch();
    const named = new Set<number>();
    inAct(() => handle.socket.deliver(start('g1', 1)));
    inAct(() => handle.socket.deliver(batch('g1', gameEvents.slice(0, turn2), named)));
    fireEvent.click(screen.getByRole('button', { name: 'Go live' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous turn' }));
    const held = position();
    inAct(() => handle.socket.deliver(batch('g1', gameEvents.slice(turn2), named)));
    expect(position()).toBe(held?.replace(`of ${turn2}`, `of ${gameEvents.length}`));
    expect(turnStep()).toContain('Turn 1');
    fireEvent.click(screen.getByRole('button', { name: 'Go live' }));
    expect(turnStep()).toContain('Turn 3');
    expect(screen.getByRole('button', { name: '● Live' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('stays with a game until it is played through, then holds its result before moving on', async () => {
    const handle = await watch(300);
    inAct(() => handle.socket.deliver(start('g1', 1)));
    inAct(() => handle.socket.deliver(batch('g1', gameEvents.slice(0, 5))));
    inAct(() => handle.socket.deliver(end('g1')));
    // More games start, more than the page keeps, while the first is still being watched.
    for (let game = 2; game <= 11; game += 1) {
      inAct(() => handle.socket.deliver(start(`g${game}`, game)));
      inAct(() => handle.socket.deliver(batch(`g${game}`, gameEvents.slice(0, 3))));
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.getByTestId('live-game').textContent).toContain('game 1');
    expect(position()).toContain('of 5');

    // Played through, its result stays a moment, and then the newest game is shown.
    fireEvent.click(screen.getByRole('button', { name: 'End' }));
    expect(screen.getByTestId('live-game').textContent).toContain('game 1 · A won');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(screen.getByTestId('live-game').textContent).toContain('game 1 · A won');
    await waitFor(() => expect(screen.getByTestId('live-game').textContent).toContain('game 11'));
    expect(position()).toContain('event 0 of 3');
  });

  it('does not move on from a game taken back before its end', async () => {
    const handle = await watch(100);
    inAct(() => handle.socket.deliver(start('g1', 1)));
    inAct(() => handle.socket.deliver(batch('g1', gameEvents.slice(0, 5))));
    inAct(() => handle.socket.deliver(end('g1')));
    inAct(() => handle.socket.deliver(start('g2', 2)));
    fireEvent.click(screen.getByRole('button', { name: 'End' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.getByTestId('live-game').textContent).toContain('game 1');
  });

  it('waits on a finished game for the next to start, and watches that at once', async () => {
    const handle = await watch();
    inAct(() => handle.socket.deliver(start('g1', 1)));
    inAct(() => handle.socket.deliver(batch('g1', gameEvents.slice(0, 5))));
    inAct(() => handle.socket.deliver(end('g1')));
    fireEvent.click(screen.getByRole('button', { name: 'End' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByTestId('live-game').textContent).toContain('game 1');
    inAct(() => handle.socket.deliver(start('g2', 2)));
    expect(screen.getByTestId('live-game').textContent).toContain('game 2');
  });

  it('moves on to the newest game once one is watched through, unless one is pinned', async () => {
    const handle = await watch();
    inAct(() => handle.socket.deliver(start('g1', 1)));
    inAct(() => handle.socket.deliver(batch('g1', gameEvents.slice(0, 5))));
    inAct(() => handle.socket.deliver(end('g1')));
    inAct(() => handle.socket.deliver(start('g2', 2)));
    fireEvent.click(screen.getByRole('button', { name: 'End' }));
    await waitFor(() => expect(screen.getByTestId('live-game').textContent).toContain('game 2'));

    fireEvent.click(screen.getByLabelText('Pin this game'));
    inAct(() => handle.socket.deliver(start('g3', 3)));
    inAct(() => handle.socket.deliver(batch('g3', gameEvents.slice(0, 5))));
    expect(screen.getByTestId('live-game').textContent).toContain('game 2');
    expect(screen.getByTestId('newer-games').textContent).toBe('1 newer game since');

    // An earlier game can be gone back to and watched again.
    fireEvent.change(screen.getByLabelText('Recent games'), { target: { value: 'g1' } });
    expect(screen.getByTestId('live-game').textContent).toContain('game 1');
    expect(position()).toContain('of 5');

    fireEvent.click(screen.getByLabelText('Pin this game'));
    expect(screen.getByTestId('live-game').textContent).toContain('game 3');
  });

  it('keeps a pinned game however many games come after it', async () => {
    const handle = await watch();
    inAct(() => handle.socket.deliver(start('g1', 1)));
    inAct(() => handle.socket.deliver(batch('g1', gameEvents.slice(0, 5))));
    fireEvent.click(screen.getByLabelText('Pin this game'));
    for (let game = 2; game <= 21; game += 1) {
      inAct(() => handle.socket.deliver(start(`g${game}`, game)));
      inAct(() => handle.socket.deliver(end(`g${game}`)));
    }
    expect(screen.getByTestId('live-game').textContent).toContain('game 1');
    expect(position()).toContain('of 5');
    expect(screen.getByTestId('newer-games').textContent).toBe('20 newer games since');
  });

  it('starts a game afresh when caught up on it mid-game', async () => {
    const handle = await watch();
    inAct(() => handle.socket.deliver(start('g1', 1)));
    inAct(() => handle.socket.deliver(batch('g1', gameEvents.slice(0, 5))));
    // Reconnected: the hub sends the start and everything so far again.
    inAct(() => handle.socket.deliver(start('g1', 1, true)));
    inAct(() => handle.socket.deliver(batch('g1', gameEvents.slice(0, 8))));
    expect(position()).toContain('of 8');
    expect(
      within(screen.getByRole('region', { name: 'Ticker' })).getAllByTestId('ticker-line')[0]
        ?.textContent,
    ).toBe('B chooses to draw, so A plays first');
    expect(screen.queryByLabelText('Recent games')).toBeNull();
  });

  it('ignores the events of a game it was never told had started', async () => {
    const handle = await watch();
    inAct(() => handle.socket.deliver(batch('elsewhere', gameEvents.slice(0, 5))));
    expect(screen.getByText(/Waiting for the run’s next game/)).toBeTruthy();
  });
});
