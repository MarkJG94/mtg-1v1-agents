import type { RunSummary, WsServerMessage, WsSubscription } from '@mtg/shared';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from 'react';
import { create } from 'zustand';
import { type LiveSocket, subscriptionKey } from './socket.js';

/** The app's socket, handed down so a test can give the tree its own. */
const SocketContext = createContext<LiveSocket | null>(null);

export const SocketProvider = ({
  socket,
  children,
}: {
  socket: LiveSocket;
  children: ReactNode;
}) => <SocketContext.Provider value={socket}>{children}</SocketContext.Provider>;

const useSocket = (): LiveSocket => {
  const socket = useContext(SocketContext);
  if (socket === null) throw new Error('useSocket outside a SocketProvider');
  return socket;
};

/**
 * Listens to a subscription for as long as the component is mounted, or until
 * `subscription` changes; `null` subscribes to nothing. The listener may change every
 * render without resubscribing.
 */
export const useSubscription = (
  subscription: WsSubscription | null,
  listener: (message: WsServerMessage) => void,
): void => {
  const socket = useSocket();
  const latest = useRef(listener);
  latest.current = listener;
  const key = subscription === null ? null : subscriptionKey(subscription);
  // The key stands for the subscription: a new object with the same key is the same one.
  useEffect(() => {
    if (subscription === null) return;
    return socket.subscribe(subscription, (message) => latest.current(message));
  }, [socket, key]);
};

export const useConnected = (): boolean => {
  const socket = useSocket();
  return useSyncExternalStore(
    (onChange) => socket.onStatus(onChange),
    () => socket.connected,
  );
};

// --- The runs store (docs/08 "Zustand stores for the run list") ---

export type RunStatusMessage = Extract<WsServerMessage, { type: 'runStatus' }>;

export interface LiveStatus extends RunStatusMessage {
  /** When it arrived, in ms since the epoch: against a fetch's time, whichever is newer wins. */
  readonly receivedAt: number;
}

interface RunsStore {
  readonly live: Readonly<Record<string, LiveStatus>>;
  apply(message: RunStatusMessage, at?: number): void;
}

export const useRunsStore = create<RunsStore>()((set) => ({
  live: {},
  apply: (message, at = Date.now()) =>
    set((store) => ({ live: { ...store.live, [message.runId]: { ...message, receivedAt: at } } })),
}));

/** A row of the runs table: the fetched summary with what the socket has said since. */
export interface RunRow extends RunSummary {
  /** The cycle in progress, or the last finished; `null` before the first. */
  readonly cycle: number | null;
  readonly gamesPerSecond: number | null;
  readonly etaSeconds: number | null;
  readonly matchesDone: number | null;
  readonly matchesPlanned: number | null;
}

/**
 * The summary as fetched at `fetchedAt`, brought up to date by a `runStatus` received
 * after it. A status older than the fetch — a run paused while it waited for a worker
 * sends none — does not overrule it, though its pace still shows.
 */
export const mergeRun = (summary: RunSummary, fetchedAt: number, live?: LiveStatus): RunRow => {
  const fetchedCycle = summary.currentCycle ?? (summary.cycles > 0 ? summary.cycles : null);
  const pace = {
    gamesPerSecond: live?.gamesPerSecond ?? null,
    etaSeconds: live?.etaSeconds ?? null,
    matchesDone: live?.matchesDone ?? null,
    matchesPlanned: live?.matchesPlanned ?? null,
  };
  if (live === undefined || live.receivedAt < fetchedAt) {
    return { ...summary, cycle: fetchedCycle, ...pace };
  }
  return { ...summary, status: live.status, playing: live.playing, cycle: live.cycle, ...pace };
};

/**
 * Whether a status says something the fetched list does not know — a cycle it has not
 * counted, or a new status — so the list (its sparkline, its last change) is fetched again.
 */
export const outdates = (message: RunStatusMessage, summary: RunSummary | undefined): boolean => {
  if (summary === undefined) return true;
  if (message.status !== summary.status) return true;
  const known = summary.currentCycle ?? summary.cycles;
  return message.cycle !== null && message.cycle !== known;
};
