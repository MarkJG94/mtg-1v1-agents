import { type WsServerMessage, type WsSubscription, wsServerMessageSchema } from '@mtg/shared';

/**
 * The one WebSocket the app keeps to `/ws` (docs/08 "a single WebSocket client with
 * subscription reference counting"; docs/07 "WebSocket"). Components subscribe to what
 * they show; the server hears `subscribe` when the first of them asks for a subscription
 * and `unsubscribe` when the last lets go. That matters beyond tidiness: the server only
 * streams a run's games while somebody is subscribed to them.
 *
 * The socket reconnects on its own, backing off to ten seconds, and subscribes again to
 * everything still wanted. Messages it cannot read are dropped, not thrown: a newer server
 * may send kinds this build does not know.
 */

/** As much of a WebSocket as the client uses, so tests can hand it a fake. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;
export type Listener = (message: WsServerMessage) => void;

const OPEN = 1;

export const subscriptionKey = (subscription: WsSubscription): string =>
  subscription.to === 'runs' ? 'runs' : `${subscription.to}:${subscription.runId}`;

/** Whether a message belongs to a subscription: the server sends it once for all of them. */
export const belongsTo = (subscription: WsSubscription, message: WsServerMessage): boolean => {
  switch (subscription.to) {
    case 'runs':
      return message.type === 'runStatus' || message.type === 'unsupportedCard';
    case 'run':
      return (
        (message.type === 'runStatus' ||
          message.type === 'cycleFinished' ||
          message.type === 'deckChanged' ||
          message.type === 'banApplied') &&
        message.runId === subscription.runId
      );
    case 'game':
      return (
        (message.type === 'gameStart' ||
          message.type === 'gameEvents' ||
          message.type === 'gameEnd') &&
        message.runId === subscription.runId
      );
  }
};

const wire = (subscribe: boolean, subscription: WsSubscription): string =>
  JSON.stringify({
    [subscribe ? 'subscribe' : 'unsubscribe']: subscription.to,
    ...(subscription.to === 'runs' ? {} : { runId: subscription.runId }),
  });

export interface LiveSocketOptions {
  readonly url: string;
  readonly create?: SocketFactory;
  /** The wait before reconnect attempt `n` (from 0). */
  readonly backoffMs?: (attempt: number) => number;
}

export class LiveSocket {
  private socket: SocketLike | null = null;
  private readonly wanted = new Map<
    string,
    { subscription: WsSubscription; listeners: Set<Listener> }
  >();
  private readonly statusListeners = new Set<(connected: boolean) => void>();
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private connectedNow = false;
  private readonly create: SocketFactory;
  private readonly backoffMs: (attempt: number) => number;

  constructor(private readonly options: LiveSocketOptions) {
    this.create = options.create ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.backoffMs = options.backoffMs ?? ((attempt) => Math.min(10_000, 500 * 2 ** attempt));
  }

  get connected(): boolean {
    return this.connectedNow;
  }

  /** Connects now rather than at the first subscription, so `connected` means something. */
  start(): void {
    this.ensureSocket();
  }

  /** Listens to a subscription; the returned function stops, and may be called twice. */
  subscribe(subscription: WsSubscription, listener: Listener): () => void {
    const key = subscriptionKey(subscription);
    let entry = this.wanted.get(key);
    if (entry === undefined) {
      entry = { subscription, listeners: new Set() };
      this.wanted.set(key, entry);
      this.send(wire(true, subscription));
    }
    // One registration per call, so the same function subscribed twice is let go twice.
    const own: Listener = (message) => listener(message);
    entry.listeners.add(own);
    this.ensureSocket();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.wanted.get(key);
      if (current === undefined) return;
      current.listeners.delete(own);
      if (current.listeners.size === 0) {
        this.wanted.delete(key);
        this.send(wire(false, subscription));
      }
    };
  }

  onStatus(listener: (connected: boolean) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.socket?.close();
    this.socket = null;
    this.setConnected(false);
  }

  private send(text: string): void {
    // Before the socket opens nothing is sent: `onopen` subscribes to all that is wanted.
    if (this.socket !== null && this.socket.readyState === OPEN) this.socket.send(text);
  }

  private ensureSocket(): void {
    if (this.closed || this.socket !== null || this.timer !== null) return;
    this.connect();
  }

  private connect(): void {
    this.timer = null;
    const socket = this.create(this.options.url);
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempts = 0;
      this.setConnected(true);
      for (const { subscription } of this.wanted.values()) socket.send(wire(true, subscription));
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket || typeof event.data !== 'string') return;
      let json: unknown;
      try {
        json = JSON.parse(event.data);
      } catch {
        return;
      }
      const parsed = wsServerMessageSchema.safeParse(json);
      if (!parsed.success) return;
      this.dispatch(parsed.data);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.setConnected(false);
      if (this.closed) return;
      const wait = this.backoffMs(this.attempts);
      this.attempts += 1;
      this.timer = setTimeout(() => this.connect(), wait);
    };
    socket.onerror = () => {
      // A close follows an error; reconnecting is its business.
    };
  }

  private dispatch(message: WsServerMessage): void {
    // Copied first: a listener may subscribe or let go while being told.
    const targets: Listener[] = [];
    for (const { subscription, listeners } of this.wanted.values()) {
      if (belongsTo(subscription, message)) targets.push(...listeners);
    }
    for (const listener of targets) listener(message);
  }

  private setConnected(connected: boolean): void {
    if (this.connectedNow === connected) return;
    this.connectedNow = connected;
    for (const listener of this.statusListeners) listener(connected);
  }
}

/** Where the app's socket connects: `/ws` on the page's own host, which Vite proxies in dev. */
export const socketUrl = (location: Pick<Location, 'protocol' | 'host'>): string =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
