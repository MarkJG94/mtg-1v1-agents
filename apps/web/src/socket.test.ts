import type { WsServerMessage } from '@mtg/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { belongsTo, socketUrl } from './socket.js';
import { fakeLive } from './test/harness.js';

/** The one WebSocket client (docs/08 "a single WebSocket client with subscription reference counting"). */

const status = (runId: string): WsServerMessage => ({
  type: 'runStatus',
  runId,
  name: runId,
  status: 'running',
  playing: true,
  cycle: 1,
  matchesDone: 0,
  matchesPlanned: 10,
  gamesPerSecond: 0,
  etaSeconds: null,
});

afterEach(() => vi.useRealTimers());

describe('the live socket', () => {
  it('subscribes once for many listeners, and lets go when the last one does', () => {
    const f = fakeLive();
    const { live } = f;
    const first = live.subscribe({ to: 'run', runId: 'r1' }, () => {});
    const second = live.subscribe({ to: 'run', runId: 'r1' }, () => {});
    f.socket.open();
    expect(f.socket.sent).toEqual([{ subscribe: 'run', runId: 'r1' }]);

    first();
    first(); // letting go twice is letting go once
    expect(f.socket.sent).toHaveLength(1);
    second();
    expect(f.socket.sent).toEqual([
      { subscribe: 'run', runId: 'r1' },
      { unsubscribe: 'run', runId: 'r1' },
    ]);

    const third = live.subscribe({ to: 'run', runId: 'r1' }, () => {});
    expect(f.socket.sent.at(-1)).toEqual({ subscribe: 'run', runId: 'r1' });
    third();
  });

  it('counts the same listener subscribed twice as two', () => {
    const f = fakeLive();
    const { live } = f;
    const listener = () => {};
    const a = live.subscribe({ to: 'runs' }, listener);
    const b = live.subscribe({ to: 'runs' }, listener);
    f.socket.open();
    a();
    expect(f.socket.sent).toEqual([{ subscribe: 'runs' }]);
    b();
    expect(f.socket.sent).toEqual([{ subscribe: 'runs' }, { unsubscribe: 'runs' }]);
  });

  it('sends nothing before it opens, then subscribes to what is wanted by then', () => {
    const { live, sockets } = fakeLive();
    const gone = live.subscribe({ to: 'game', runId: 'r1' }, () => {});
    live.subscribe({ to: 'runs' }, () => {});
    gone();
    expect(sockets).toHaveLength(1);
    sockets[0]?.open();
    expect(sockets[0]?.sent).toEqual([{ subscribe: 'runs' }]);
  });

  it('hands each message to the listeners whose subscription it belongs to', () => {
    const f = fakeLive();
    const { live } = f;
    const all: string[] = [];
    const one: string[] = [];
    const other: string[] = [];
    live.subscribe({ to: 'runs' }, (message) => all.push(message.type));
    live.subscribe({ to: 'run', runId: 'r1' }, (message) => one.push(message.type));
    live.subscribe({ to: 'run', runId: 'r2' }, (message) => other.push(message.type));
    f.socket.open();
    f.socket.deliver(status('r1'));
    f.socket.deliver({
      type: 'banApplied',
      runId: 'r1',
      event: {
        oracleId: 'x',
        action: 'ban',
        note: '',
        by: 'op',
        at: 't',
        appliedAfterGameId: null,
      },
    });
    expect(all).toEqual(['runStatus']);
    expect(one).toEqual(['runStatus', 'banApplied']);
    expect(other).toEqual([]);
  });

  it('connects when started, with nothing to subscribe to yet, and once only', () => {
    const { live, sockets } = fakeLive();
    live.start();
    live.start();
    expect(sockets).toHaveLength(1);
    sockets[0]?.open();
    expect(live.connected).toBe(true);
    expect(sockets[0]?.sent).toEqual([]);
    live.subscribe({ to: 'runs' }, () => {});
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.sent).toEqual([{ subscribe: 'runs' }]);
  });

  it('drops what it cannot read rather than throwing', () => {
    const f = fakeLive();
    const { live } = f;
    const heard: unknown[] = [];
    live.subscribe({ to: 'runs' }, (message) => heard.push(message));
    f.socket.open();
    f.socket.deliver('not json');
    f.socket.deliver(JSON.stringify({ type: 'runStatus', runId: 'r1' })); // fields missing
    f.socket.deliver(JSON.stringify({ type: 'fromTheFuture', runId: 'r1' }));
    f.socket.deliver(status('r1'));
    expect(heard).toHaveLength(1);
  });

  it('reconnects with backoff and subscribes again to everything still wanted', () => {
    vi.useFakeTimers();
    const { live, sockets } = fakeLive({ backoffMs: (attempt) => 1000 * (attempt + 1) });
    const states: boolean[] = [];
    live.onStatus((connected) => states.push(connected));
    live.subscribe({ to: 'runs' }, () => {});
    live.subscribe({ to: 'game', runId: 'r9' }, () => {});
    sockets[0]?.open();
    sockets[0]?.drop();
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);

    // A second failure waits longer; a success resets the count.
    sockets[1]?.drop();
    vi.advanceTimersByTime(1999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    sockets[2]?.open();
    expect(sockets[2]?.sent).toEqual([{ subscribe: 'runs' }, { subscribe: 'game', runId: 'r9' }]);
    expect(states).toEqual([true, false, true]);
    expect(live.connected).toBe(true);

    sockets[2]?.drop();
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(4); // back to the first wait
    sockets[3]?.open();

    live.close();
    expect(sockets[3]?.closed).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(4);
  });

  it('ignores a replaced socket still talking', () => {
    vi.useFakeTimers();
    const { live, sockets } = fakeLive({ backoffMs: () => 10 });
    const heard: unknown[] = [];
    live.subscribe({ to: 'runs' }, (message) => heard.push(message));
    sockets[0]?.open();
    sockets[0]?.drop();
    vi.advanceTimersByTime(10);
    sockets[1]?.open();
    sockets[0]?.deliver(status('r1'));
    expect(heard).toEqual([]);
  });
});

describe('what belongs to a subscription', () => {
  it('routes game messages only to the game subscription of their run', () => {
    const start = {
      type: 'gameEnd',
      runId: 'r1',
      seed: 's',
      onPlay: 'A',
      winner: 'A',
      reason: null,
      turns: 5,
    } as const;
    expect(belongsTo({ to: 'game', runId: 'r1' }, start)).toBe(true);
    expect(belongsTo({ to: 'game', runId: 'r2' }, start)).toBe(false);
    expect(belongsTo({ to: 'run', runId: 'r1' }, start)).toBe(false);
    expect(belongsTo({ to: 'runs' }, start)).toBe(false);
  });

  it('connects to /ws on the page’s own host, securely when the page is', () => {
    expect(socketUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/ws');
    expect(socketUrl({ protocol: 'https:', host: 'example.org' })).toBe('wss://example.org/ws');
  });
});
