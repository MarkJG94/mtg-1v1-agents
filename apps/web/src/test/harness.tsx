import type { WsServerMessage } from '@mtg/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import { SocketProvider, useRunsStore } from '../live.js';
import { LiveSocket, type SocketLike } from '../socket.js';

/** A WebSocket the test drives: it opens, delivers and closes when told to. */
export class FakeSocket implements SocketLike {
  readyState = 0;
  readonly sent: unknown[] = [];
  closed = false;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('sent before the socket opened');
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.closed = true;
    this.drop();
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  deliver(message: WsServerMessage | string): void {
    this.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) });
  }

  drop(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
}

/** A LiveSocket over fakes, with every socket it made. */
export const fakeLive = (options: { backoffMs?: (attempt: number) => number } = {}) => {
  const sockets: FakeSocket[] = [];
  const live = new LiveSocket({
    url: 'ws://test/ws',
    create: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    ...(options.backoffMs === undefined ? {} : { backoffMs: options.backoffMs }),
  });
  return {
    live,
    sockets,
    get socket(): FakeSocket {
      const last = sockets.at(-1);
      if (last === undefined) throw new Error('no socket made yet');
      return last;
    },
  };
};

export interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

type Handler = (
  call: Call,
) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>;

/**
 * `fetch` answered from a table of `'METHOD /path'` handlers (the query string is part of
 * the path); anything else is a 404 in docs/07's shape. Every call is recorded.
 */
export const fakeServer = (routes: Record<string, Handler>) => {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    const call: Call = {
      method,
      path: input,
      body: init?.body === undefined ? undefined : JSON.parse(init.body),
    };
    calls.push(call);
    const handler = routes[`${method} ${input}`] ?? routes[`${method} ${input.split('?')[0]}`];
    const answer =
      handler === undefined
        ? { status: 404, body: { error: { code: 'not_found', message: `no route ${input}` } } }
        : await handler(call);
    const status = answer.status ?? 200;
    return new Response(JSON.stringify(answer.body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetch: fetchMock };
};

/** Renders a page with a fresh query client, the given socket, and an empty runs store. */
export const renderWith = (ui: ReactNode, live: LiveSocket) => {
  useRunsStore.setState({ live: {} });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SocketProvider socket={live}>{ui}</SocketProvider>
    </QueryClientProvider>,
  );
};

/** Runs a socket event inside React's act, so what it sets is rendered before the next line. */
export const inAct = (effect: () => void) => act(effect);
