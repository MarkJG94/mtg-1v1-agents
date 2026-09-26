import {
  type DeckGeneration,
  type GameEvent,
  type WsServerMessage,
  type WsSubscription,
  wsClientMessageSchema,
} from '@mtg/shared';
import type { Queries } from './db/queries.js';
import type { Supervisor, SupervisorEvent } from './workers/supervisor.js';

/**
 * The WebSocket hub (docs/07 "WebSocket `/ws`"; roadmap 6.2): each client subscribes to
 * the list of runs, to a run, or to a run's live game, and is sent what the supervisor
 * reports as it happens — a run's status after every match, each cycle as it finishes, each
 * deck change and ban as it takes effect, and a watched game's start, events and end.
 *
 * **Live games are best effort.** A run's games are streamed only while someone subscribes
 * to them, so an unwatched run pays nothing; the worker batches their events every ~50 ms;
 * a viewer who joins mid-game is sent the game's start and every event so far; and a
 * viewer whose socket has fallen behind is skipped until the next game rather than waited
 * for — the simulation never waits for a viewer.
 */

/** The part of the supervisor the hub uses. */
export type HubSupervisor = Pick<Supervisor, 'on' | 'watch' | 'isActive'>;

/** The part of a WebSocket the hub uses, so a test can hand it a fake. */
export interface HubSocket {
  send(data: string): void;
  readonly bufferedAmount: number;
  on(event: 'message', listener: (data: unknown) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
}

interface Client {
  readonly socket: HubSocket;
  runs: boolean;
  readonly run: Set<string>;
  readonly game: Set<string>;
  /** Runs whose live game this client fell behind on: nothing more until the next game. */
  readonly lagging: Set<string>;
}

interface LiveGame {
  readonly start: Extract<WsServerMessage, { type: 'gameStart' }>;
  readonly events: GameEvent[];
}

/** Bytes a socket may have waiting before a live game skips it. */
const MAX_BUFFERED = 4 * 1024 * 1024;
/** How far back a run's pace is measured. */
const PACE_WINDOW_MS = 60_000;

export interface HubOptions {
  readonly version: string;
  readonly clock?: () => number;
  readonly maxBuffered?: number;
}

export class Hub {
  private readonly clients = new Set<Client>();
  private readonly live = new Map<string, LiveGame>();
  /** Each run's recent matches, for its pace: when each was saved and its games. */
  private readonly pace = new Map<string, { at: number; games: number }[]>();
  private readonly clock: () => number;
  private readonly maxBuffered: number;
  private readonly stop: () => void;

  constructor(
    private readonly supervisor: HubSupervisor,
    private readonly queries: Queries,
    private readonly options: HubOptions,
  ) {
    this.clock = options.clock ?? Date.now;
    this.maxBuffered = options.maxBuffered ?? MAX_BUFFERED;
    this.stop = supervisor.on((event) => this.relay(event));
  }

  /** How many clients are connected, for health and tests. */
  get connected(): number {
    return this.clients.size;
  }

  connect(socket: HubSocket): void {
    const client: Client = {
      socket,
      runs: false,
      run: new Set(),
      game: new Set(),
      lagging: new Set(),
    };
    this.clients.add(client);
    socket.on('message', (data) => this.receive(client, data));
    socket.on('close', () => {
      this.clients.delete(client);
      for (const runId of client.game) this.rewatch(runId);
    });
    this.send(client, { type: 'hello', version: this.options.version });
  }

  close(): void {
    this.stop();
  }

  // --- From clients ---

  private receive(client: Client, data: unknown): void {
    let json: unknown;
    try {
      json = JSON.parse(String(data));
    } catch {
      this.send(client, { type: 'error', message: 'a message is JSON' });
      return;
    }
    const parsed = wsClientMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.send(client, {
        type: 'error',
        message: parsed.error.issues.map((issue) => issue.message).join('; '),
      });
      return;
    }
    const { subscribe, subscription } = parsed.data;
    if (subscribe) this.subscribe(client, subscription);
    else this.unsubscribe(client, subscription);
  }

  private subscribe(client: Client, subscription: WsSubscription): void {
    if (subscription.to === 'runs') {
      client.runs = true;
      for (const run of this.queries.runs()) this.sendStatus(client, run.id);
      return;
    }
    const { runId } = subscription;
    if (this.queries.run(runId) === null) {
      this.send(client, { type: 'error', message: `no run ${runId}` });
      return;
    }
    if (subscription.to === 'run') {
      client.run.add(runId);
      this.sendStatus(client, runId);
      return;
    }
    client.game.add(runId);
    client.lagging.delete(runId);
    this.rewatch(runId);
    // Joining mid-game: the start, then everything so far.
    const game = this.live.get(runId);
    if (game !== undefined) {
      this.send(client, { ...game.start, catchUp: true });
      if (game.events.length > 0) {
        this.send(client, {
          type: 'gameEvents',
          runId,
          seed: game.start.seed,
          events: [...game.events],
        });
      }
    }
  }

  private unsubscribe(client: Client, subscription: WsSubscription): void {
    if (subscription.to === 'runs') client.runs = false;
    else if (subscription.to === 'run') client.run.delete(subscription.runId);
    else {
      client.game.delete(subscription.runId);
      this.rewatch(subscription.runId);
    }
  }

  /** Tells the supervisor whether anyone is watching a run's games now. */
  private rewatch(runId: string): void {
    const watching = [...this.clients].some((client) => client.game.has(runId));
    this.supervisor.watch(runId, watching);
  }

  // --- From the supervisor ---

  private relay(event: SupervisorEvent): void {
    switch (event.type) {
      case 'runStarted':
      case 'runHalted':
      case 'runFailed':
        this.status(event.runId);
        return;
      case 'matchSaved': {
        const recent = (this.pace.get(event.runId) ?? []).filter(
          (entry) => entry.at >= this.clock() - PACE_WINDOW_MS,
        );
        recent.push({ at: this.clock(), games: event.match.match.games.length });
        this.pace.set(event.runId, recent);
        this.status(event.runId);
        return;
      }
      case 'cycleFinished': {
        const cycle = this.queries.lastCycle(event.runId);
        if (cycle !== null) {
          this.broadcast((client) => client.run.has(event.runId), {
            type: 'cycleFinished',
            runId: event.runId,
            cycle,
          });
        }
        this.status(event.runId);
        return;
      }
      case 'deckChanged':
        for (const generation of event.generations) {
          this.broadcast(
            (client) => client.run.has(event.runId),
            deckChanged(event.runId, generation),
          );
        }
        return;
      case 'banApplied':
        this.broadcast((client) => client.run.has(event.runId), {
          type: 'banApplied',
          runId: event.runId,
          event: { ...event.event },
        });
        return;
      case 'unsupportedCard': {
        const runId = event.request.runId ?? null;
        const name = this.queries.names([event.request.oracleId]).get(event.request.oracleId);
        this.broadcast((client) => client.runs || (runId !== null && client.run.has(runId)), {
          type: 'unsupportedCard',
          runId,
          oracleId: event.request.oracleId,
          name: name ?? null,
          reason: event.request.reason,
        });
        return;
      }
      case 'gameStart': {
        const { game } = event;
        const start: LiveGame['start'] = {
          type: 'gameStart',
          runId: event.runId,
          seed: game.seed,
          cycle: game.cycle ?? null,
          match: game.match ?? null,
          game: game.game,
          chosenBy: game.chooser,
          decks: { A: [...game.decks.A], B: [...game.decks.B] },
          generations: { ...game.generations },
          catchUp: false,
        };
        this.live.set(event.runId, { start, events: [] });
        for (const client of this.clients) client.lagging.delete(event.runId);
        this.broadcast((client) => client.game.has(event.runId), start);
        return;
      }
      case 'gameEvents': {
        const game = this.live.get(event.runId);
        if (game === undefined) return;
        game.events.push(...event.events);
        const message = JSON.stringify({
          type: 'gameEvents',
          runId: event.runId,
          seed: game.start.seed,
          events: [...event.events],
        } satisfies WsServerMessage);
        for (const client of this.clients) {
          if (!client.game.has(event.runId) || client.lagging.has(event.runId)) continue;
          // Behind: skip it until the next game rather than hold the run up.
          if (client.socket.bufferedAmount > this.maxBuffered) {
            client.lagging.add(event.runId);
            continue;
          }
          client.socket.send(message);
        }
        return;
      }
      case 'gameEnd': {
        this.live.delete(event.runId);
        const { game } = event;
        this.broadcast((client) => client.game.has(event.runId), {
          type: 'gameEnd',
          runId: event.runId,
          seed: game.seed,
          onPlay: game.onPlay,
          winner: game.result?.winner ?? null,
          reason: game.result?.reason ?? null,
          turns: game.result?.turn ?? null,
        });
        return;
      }
    }
  }

  // --- Sending ---

  private send(client: Client, message: WsServerMessage): void {
    client.socket.send(JSON.stringify(message));
  }

  private broadcast(to: (client: Client) => boolean, message: WsServerMessage): void {
    const text = JSON.stringify(message);
    for (const client of this.clients) if (to(client)) client.socket.send(text);
  }

  private status(runId: string): void {
    const message = this.statusOf(runId);
    if (message === null) return;
    this.broadcast((client) => client.runs || client.run.has(runId), message);
  }

  private sendStatus(client: Client, runId: string): void {
    const message = this.statusOf(runId);
    if (message !== null) this.send(client, message);
  }

  /** docs/07 `runStatus`: status, cycle, matches done and planned, games a second, ETA. */
  private statusOf(runId: string): Extract<WsServerMessage, { type: 'runStatus' }> | null {
    const run = this.queries.run(runId);
    if (run === null) return null;
    const progress = this.queries.progress(runId);
    const now = this.clock();
    const recent = (this.pace.get(runId) ?? []).filter((entry) => entry.at >= now - PACE_WINDOW_MS);
    const playing = this.supervisor.isActive(runId);
    let gamesPerSecond = 0;
    let etaSeconds: number | null = null;
    const first = recent[0];
    if (playing && first !== undefined && recent.length >= 2) {
      const seconds = Math.max((now - first.at) / 1000, 0.001);
      // The first match's games were played before the window began.
      const games = recent.slice(1).reduce((sum, entry) => sum + entry.games, 0);
      gamesPerSecond = games / seconds;
      const matchesPerSecond = (recent.length - 1) / seconds;
      const left = Math.max(0, progress.planned - progress.done);
      etaSeconds = matchesPerSecond > 0 ? left / matchesPerSecond : null;
    }
    return {
      type: 'runStatus',
      runId,
      name: run.name,
      status: run.status,
      playing,
      cycle: progress.cycle,
      matchesDone: progress.done,
      matchesPlanned: progress.planned,
      gamesPerSecond,
      etaSeconds,
    };
  }
}

/** docs/07 `deckChanged`: the generation, why, and what went out and came in. */
const deckChanged = (
  runId: string,
  generation: DeckGeneration,
): Extract<WsServerMessage, { type: 'deckChanged' }> => ({
  type: 'deckChanged',
  runId,
  agent: generation.agent,
  generation: generation.generation,
  cause: generation.cause,
  reason: generation.change?.reason ?? null,
  diff:
    generation.change === null
      ? { removed: [], added: [] }
      : { removed: [{ ...generation.change.remove }], added: [{ ...generation.change.add }] },
});
