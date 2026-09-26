import { existsSync } from 'node:fs';
import { MessageChannel, type MessagePort, type Worker } from 'node:worker_threads';
import type { CardProjection, Resolution, UnsupportedRequest } from '@mtg/cards';
import type {
  BanEvent,
  CycleRecord,
  Deck75,
  DeckGeneration,
  GameEvent,
  RunSettings,
  RunStatus,
} from '@mtg/shared';
import type { BanRequest, LiveGameEnd, LiveGameStart, RunSnapshot, StoredMatch } from '@mtg/sim';
import type { OpenDatabase } from '../db/open.js';
import { SqliteRunStore } from '../db/run-store.js';
import { SqliteScriptStore } from '../db/script-store.js';
import { RemoteError, serve } from './rpc.js';
import type { ScriptAnswer, ScriptWrite } from './script-protocol.js';
import type { ScriptWorkerData } from './script-worker.js';
import type {
  ControlMessage,
  CreateJob,
  JobResult,
  LiveMessage,
  RolledDeck,
  RollJob,
  SimJob,
  SimWorkerData,
} from './sim-protocol.js';
import { spawnWorker } from './spawn.js';

/**
 * The worker pool, seen from the API process (docs/01 "Processes"; roadmap 5.7).
 *
 * - **Up to `workers` simulation workers**, each running one job at a time: making a run,
 *   or driving one until it is paused or stopped. A run started while every worker is busy
 *   waits its turn, first come first served. Workers are started when first needed and kept.
 * - **One scripting worker**, which every simulation worker and the API itself ask for
 *   cards.
 * - **Every write happens here.** A simulation worker has no database; its run store is
 *   this process's `SqliteRunStore`, served over a port. The scripting worker reads the
 *   script cache through a read-only connection and posts its writes here.
 *
 * Pausing or stopping a run is a status written here, which the worker reads after every
 * match (docs/05 "Run lifecycle"): the match in progress is finished and saved first. A
 * ban asked for while a run is on a worker goes to that worker, which puts it into effect
 * after the game in progress; one asked for otherwise goes on the trail as pending.
 */

export interface SupervisorOptions {
  readonly database: OpenDatabase;
  /** How many simulation workers there may be (`SIM_WORKERS`). */
  readonly workers: number;
  /** Scryfall's projections as JSONL (`pnpm fetch:scryfall`). */
  readonly cardsPath: string;
  /** Where the hand scripts are. */
  readonly handScriptsDir: string;
  /** Skip the resolver's slow check that plays each new card (tests). */
  readonly skipSmokeTest?: boolean;
  readonly now?: () => string;
}

/** What happened, for the WebSocket hub (docs/07) to pass on. */
export type SupervisorEvent =
  | { readonly type: 'runStarted'; readonly runId: string }
  | { readonly type: 'matchSaved'; readonly runId: string; readonly match: StoredMatch }
  | {
      readonly type: 'deckChanged';
      readonly runId: string;
      readonly generations: readonly DeckGeneration[];
    }
  | { readonly type: 'cycleFinished'; readonly runId: string; readonly record: CycleRecord }
  | {
      readonly type: 'runHalted';
      readonly runId: string;
      readonly status: RunStatus;
      readonly played: number;
    }
  | { readonly type: 'runFailed'; readonly runId: string; readonly message: string }
  | { readonly type: 'unsupportedCard'; readonly request: UnsupportedRequest }
  /** A ban edit that has just taken effect, found by its game stamp appearing on the trail. */
  | { readonly type: 'banApplied'; readonly runId: string; readonly event: BanEvent }
  /** A watched game (see `watch`), as its worker streams it. */
  | { readonly type: 'gameStart'; readonly runId: string; readonly game: LiveGameStart }
  | {
      readonly type: 'gameEvents';
      readonly runId: string;
      readonly events: readonly GameEvent[];
    }
  | { readonly type: 'gameEnd'; readonly runId: string; readonly game: LiveGameEnd };

export interface NewRun {
  readonly id: string;
  readonly name: string;
  readonly settings: RunSettings;
  readonly seedDeck?: Deck75;
  readonly bans?: readonly BanEvent[];
}

export class SupervisorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupervisorError';
  }
}

/** The scripting worker has stopped: no card can be scripted, so no deck rolled or run played. */
export class ScriptingStoppedError extends Error {
  constructor(reason: string) {
    super(`the scripting worker has stopped: ${reason}`);
    this.name = 'ScriptingStoppedError';
  }
}

interface Slot {
  readonly worker: Worker;
  job: Queued | null;
}

type Queued =
  | { readonly kind: 'drive'; readonly runId: string; readonly cycles?: number }
  | {
      readonly kind: 'create';
      readonly run: NewRun;
      readonly settle: (result: Promise<RunSnapshot>) => void;
    }
  | {
      readonly kind: 'roll';
      readonly settings: RunSettings;
      readonly bans: readonly BanEvent[];
      readonly settle: (result: Promise<RolledDeck>) => void;
    };

interface Active {
  readonly slot: Slot;
  readonly control: MessagePort;
  readonly idle: Promise<void>;
  readonly settle: () => void;
}

export class Supervisor {
  readonly store: SqliteRunStore;
  readonly scripts: SqliteScriptStore;
  private readonly now: () => string;
  private readonly scriptWorker: Worker;
  private readonly apiScripts: MessagePort;
  private readonly slots: Slot[] = [];
  private readonly queue: Queued[] = [];
  private readonly active = new Map<string, Active>();
  private readonly listeners = new Set<(event: SupervisorEvent) => void>();
  private readonly scriptAnswers = new Map<number, (answer: ScriptAnswer) => void>();
  /** Runs whose games someone is watching (`watch`). */
  private readonly watched = new Set<string>();
  /** Each run's ban edits already in effect, to tell which a write has just applied. */
  private readonly applied = new Map<string, Set<string>>();
  private nextJob = 0;
  private nextScript = 0;
  private closed = false;
  /** Why the scripting worker stopped, once it has: everything that needs it fails at once. */
  private scriptingStopped: string | null = null;

  constructor(private readonly options: SupervisorOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    // Said here, at boot, rather than by every request timing out on a worker that died.
    if (!existsSync(options.handScriptsDir)) {
      throw new SupervisorError(
        `no card scripts at ${options.handScriptsDir} (CARD_SCRIPTS_DIR); the scripting worker needs them`,
      );
    }
    this.store = new SqliteRunStore(options.database, this.now);
    this.scripts = new SqliteScriptStore(options.database.db);
    this.scriptWorker = spawnWorker('script-worker', {
      databasePath: options.database.sqlite.name,
      handScriptsDir: options.handScriptsDir,
      skipSmokeTest: options.skipSmokeTest ?? false,
    } satisfies ScriptWorkerData);
    this.scriptWorker.on('message', (message: ScriptWrite) => {
      if ('put' in message) this.scripts.put(message.put);
      else {
        this.scripts.logUnsupported(message.unsupported);
        this.emit({ type: 'unsupportedCard', request: message.unsupported });
      }
    });
    this.scriptWorker.on('error', (error) => this.scriptingStop(error.message));
    this.scriptWorker.on('exit', (code) => {
      if (!this.closed) this.scriptingStop(`it exited with code ${code}`);
    });
    this.scriptWorker.unref();
    const { port1, port2 } = new MessageChannel();
    this.scriptWorker.postMessage({ connect: port2 }, [port2]);
    port1.on('message', (answer: ScriptAnswer) => {
      this.scriptAnswers.get(answer.id)?.(answer);
      this.scriptAnswers.delete(answer.id);
    });
    port1.unref();
    this.apiScripts = port1;
  }

  /** Listens to what happens; returns a function that stops listening. */
  on(listener: (event: SupervisorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** How busy the pool is, for `/api/health`. */
  get load(): { workers: number; busy: number; queued: number } {
    return {
      workers: this.slots.length,
      busy: this.slots.filter((slot) => slot.job !== null).length,
      queued: this.queue.length,
    };
  }

  /** Whether a run is on a worker now. */
  isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  // --- Runs ---

  /** Makes a run on a worker — the seed deck is rolled and scripted there — and stores it. */
  create(run: NewRun): Promise<RunSnapshot> {
    return new Promise<RunSnapshot>((resolve, reject) => {
      this.enqueue({
        kind: 'create',
        run,
        settle: (result) => {
          result.then(resolve, reject);
        },
      });
    });
  }

  /**
   * Rolls the seed deck a run with these settings would be made with, on a worker, and
   * makes nothing: the new-run form's preview (docs/08). `bans` are the list in effect.
   */
  roll(settings: RunSettings, bans: readonly BanEvent[] = []): Promise<RolledDeck> {
    return new Promise<RolledDeck>((resolve, reject) => {
      this.enqueue({
        kind: 'roll',
        settings,
        bans,
        settle: (result) => {
          result.then(resolve, reject);
        },
      });
    });
  }

  /**
   * Sets a run playing: `running`, and on a worker as soon as one is free. `cycles` bounds
   * this stint, after which the run is paused; without it the run plays until paused or
   * stopped.
   */
  async start(runId: string, options: { readonly cycles?: number } = {}): Promise<void> {
    const status = await this.store.status(runId);
    if (status === null) throw new SupervisorError(`no run ${runId}`);
    if (status === 'stopped') throw new SupervisorError(`run ${runId} is stopped`);
    if (status !== 'running') await this.store.setStatus(runId, 'running');
    if (this.active.has(runId) || this.queued(runId)) return;
    this.enqueue({
      kind: 'drive',
      runId,
      ...(options.cycles === undefined ? {} : { cycles: options.cycles }),
    });
  }

  /** Pauses a run after the match in progress, or before it starts if it is waiting. */
  pause(runId: string): Promise<void> {
    return this.halt(runId, 'paused');
  }

  /** Stops a run for good, after the match in progress. */
  stop(runId: string): Promise<void> {
    return this.halt(runId, 'stopped');
  }

  /** Resolves once the run is on no worker and waiting for none. */
  async idle(runId: string): Promise<void> {
    while (this.active.has(runId) || this.queued(runId)) {
      await (this.active.get(runId)?.idle ?? new Promise((resolve) => setTimeout(resolve, 10)));
    }
  }

  /** At boot: every run left `running` — by a crash or a restart — plays on from its checkpoint. */
  async resumeRunning(): Promise<string[]> {
    const running = (await this.store.list()).filter((run) => run.status === 'running');
    for (const run of running) await this.start(run.id);
    return running.map((run) => run.id);
  }

  /**
   * Asks for a ban edit (docs/05 "Bans and restrictions"). On a worker, it takes effect after
   * the game in progress; otherwise it is kept as pending and takes effect as the run's next
   * cycle starts.
   */
  async requestBan(runId: string, request: BanRequest): Promise<void> {
    const active = this.active.get(runId);
    if (active !== undefined) {
      active.control.postMessage({ ban: request } satisfies ControlMessage);
      return;
    }
    const snapshot = await this.store.load(runId);
    if (snapshot === null) throw new SupervisorError(`no run ${runId}`);
    await this.store.saveBans(runId, [
      ...snapshot.bans,
      {
        oracleId: request.oracleId,
        action: request.action,
        note: request.note ?? '',
        by: request.by,
        at: request.at,
        appliedAfterGameId: null,
      },
    ]);
  }

  /**
   * Whether anyone is watching a run's games. A run on a worker streams its games only while
   * watched, and only from the next game to start; a run that starts later is told as it
   * starts. The simulation never waits for a viewer (docs/07).
   */
  watch(runId: string, watching: boolean): void {
    if (watching) this.watched.add(runId);
    else this.watched.delete(runId);
    this.active.get(runId)?.control.postMessage({ watch: watching } satisfies ControlMessage);
  }

  /**
   * Scripts a card on the scripting worker, for the API; `force` scripts it afresh rather
   * than answering from the cache (`POST /api/cards/:id/script`).
   */
  resolveCard(
    card: CardProjection,
    options: { readonly force?: boolean } = {},
  ): Promise<Resolution> {
    if (this.scriptingStopped !== null) {
      return Promise.reject(new ScriptingStoppedError(this.scriptingStopped));
    }
    const id = this.nextScript++;
    return new Promise((resolve, reject) => {
      this.scriptAnswers.set(id, (answer) => {
        if ('error' in answer) reject(new Error(answer.error));
        else resolve(answer.resolution);
      });
      this.apiScripts.postMessage({
        id,
        card,
        request: { context: 'api' },
        ...(options.force === true ? { force: true } : {}),
      });
    });
  }

  /**
   * Ends every worker. A run on one is left `running` at its last checkpoint, which is what
   * `resumeRunning` picks up; nothing is lost but the match in progress.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.queue.length = 0;
    for (const active of this.active.values()) active.settle();
    this.active.clear();
    await Promise.all([
      ...this.slots.map((slot) => slot.worker.terminate()),
      this.scriptWorker.terminate(),
    ]);
    this.apiScripts.close();
  }

  // --- Plumbing ---

  private emit(event: SupervisorEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private queued(runId: string): boolean {
    return this.queue.some((job) => job.kind === 'drive' && job.runId === runId);
  }

  private async halt(runId: string, status: 'paused' | 'stopped'): Promise<void> {
    const current = await this.store.status(runId);
    if (current === null) throw new SupervisorError(`no run ${runId}`);
    if (current === 'stopped') return;
    await this.store.setStatus(runId, status);
    const waiting = this.queue.findIndex((job) => job.kind === 'drive' && job.runId === runId);
    if (waiting >= 0) this.queue.splice(waiting, 1);
  }

  private enqueue(job: Queued): void {
    if (this.closed) throw new SupervisorError('the supervisor is closed');
    if (this.scriptingStopped !== null) {
      const error = new ScriptingStoppedError(this.scriptingStopped);
      switch (job.kind) {
        case 'drive':
          throw error;
        case 'create':
          job.settle(Promise.reject(error));
          return;
        case 'roll':
          job.settle(Promise.reject(error));
          return;
      }
    }
    this.queue.push(job);
    this.pump();
  }

  /**
   * Without the scripting worker no card can be scripted, so nothing else can go on: the
   * API's requests waiting on it fail, and so do the runs on workers — a simulation worker
   * waiting on it would otherwise wait out its timeout for every card.
   */
  private scriptingStop(reason: string): void {
    if (this.scriptingStopped !== null) return;
    this.scriptingStopped = reason;
    for (const [id, answer] of this.scriptAnswers) {
      answer({ id, error: new ScriptingStoppedError(reason).message });
    }
    this.scriptAnswers.clear();
    for (const runId of this.active.keys()) {
      this.emit({ type: 'runFailed', runId, message: `scripting worker: ${reason}` });
    }
  }

  /** Hands waiting jobs to free workers, starting workers up to the limit. */
  private pump(): void {
    while (this.queue.length > 0) {
      let slot = this.slots.find((each) => each.job === null);
      if (slot === undefined && this.slots.length < this.options.workers) slot = this.spawn();
      if (slot === undefined) return;
      const job = this.queue.shift() as Queued;
      this.assign(slot, job);
    }
  }

  private spawn(): Slot {
    const store = new MessageChannel();
    const scripts = new MessageChannel();
    const live = new MessageChannel();
    this.scriptWorker.postMessage({ connect: scripts.port1 }, [scripts.port1]);
    const worker = spawnWorker(
      'sim-worker',
      {
        cardsPath: this.options.cardsPath,
        storePort: store.port2,
        scriptPort: scripts.port2,
        livePort: live.port2,
      } satisfies SimWorkerData,
      [store.port2, scripts.port2, live.port2],
    );
    live.port1.on('message', (message: LiveMessage) => this.streamed(message));
    live.port1.unref();
    const slot: Slot = { worker, job: null };
    serve(store.port1, this.store, (method, args) => this.written(method, args));
    worker.on('message', (result: JobResult) => this.finished(slot, result));
    worker.on('error', (error) => this.lost(slot, error));
    worker.on('exit', (code) => {
      if (!this.closed && slot.job !== null) this.lost(slot, new Error(`exited with ${code}`));
    });
    this.slots.push(slot);
    return slot;
  }

  private assign(slot: Slot, job: Queued): void {
    slot.job = job;
    const id = this.nextJob++;
    if (job.kind === 'roll') {
      const message: RollJob = {
        job: id,
        kind: 'roll',
        settings: job.settings,
        bans: job.bans,
      };
      slot.worker.postMessage(message);
      return;
    }
    if (job.kind === 'create') {
      const { run } = job;
      const message: CreateJob = {
        job: id,
        kind: 'create',
        id: run.id,
        name: run.name,
        settings: run.settings,
        createdAt: this.now(),
        ...(run.seedDeck === undefined ? {} : { seedDeck: run.seedDeck }),
        ...(run.bans === undefined ? {} : { bans: run.bans }),
      };
      slot.worker.postMessage(message);
      return;
    }
    const control = new MessageChannel();
    let settle = () => {};
    const idle = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.active.set(job.runId, { slot, control: control.port1, idle, settle });
    const message: SimJob = {
      job: id,
      kind: 'drive',
      runId: job.runId,
      ...(job.cycles === undefined ? {} : { cycles: job.cycles }),
      control: control.port2,
    };
    slot.worker.postMessage(message, [control.port2]);
    if (this.watched.has(job.runId)) {
      control.port1.postMessage({ watch: true } satisfies ControlMessage);
    }
    this.applied.set(job.runId, appliedKeys(this.store.trail(job.runId)));
    this.emit({ type: 'runStarted', runId: job.runId });
  }

  /** Told of every write a worker made through the store, once it is made. */
  private written(method: string, args: readonly unknown[]): void {
    const runId = args[0] as string;
    if (method === 'saveMatch') {
      this.bansWritten(runId, args[3] as readonly BanEvent[]);
      this.emit({ type: 'matchSaved', runId, match: args[1] as StoredMatch });
      this.changed(runId, args[2] as readonly DeckGeneration[]);
    } else if (method === 'saveGenerations') {
      this.bansWritten(runId, args[2] as readonly BanEvent[]);
      this.changed(runId, args[1] as readonly DeckGeneration[]);
    } else if (method === 'finishCycle') {
      this.bansWritten(runId, args[3] as readonly BanEvent[]);
      this.emit({ type: 'cycleFinished', runId, record: args[1] as CycleRecord });
      this.changed(runId, args[2] as readonly DeckGeneration[]);
    }
  }

  /** docs/07 `banApplied`: every edit the written trail has in effect that it did not before. */
  private bansWritten(runId: string, trail: readonly BanEvent[]): void {
    const known = this.applied.get(runId) ?? new Set<string>();
    for (const event of trail) {
      if (event.appliedAfterGameId === null) continue;
      const key = keyOf(event);
      if (known.has(key)) continue;
      known.add(key);
      this.emit({ type: 'banApplied', runId, event });
    }
    this.applied.set(runId, known);
  }

  private streamed(message: LiveMessage): void {
    const { runId } = message;
    if ('start' in message) this.emit({ type: 'gameStart', runId, game: message.start });
    else if ('events' in message) this.emit({ type: 'gameEvents', runId, events: message.events });
    else this.emit({ type: 'gameEnd', runId, game: message.end });
  }

  private changed(runId: string, generations: readonly DeckGeneration[]): void {
    if (generations.length > 0) this.emit({ type: 'deckChanged', runId, generations });
  }

  private finished(slot: Slot, result: JobResult): void {
    const job = slot.job;
    slot.job = null;
    if (job === null) return;
    const failure = () =>
      'failed' in result
        ? new RemoteError(result.failed.name, result.failed.message)
        : new Error(`a ${job.kind} job did not do it`);
    if (job.kind === 'create') {
      job.settle('created' in result ? Promise.resolve(result.created) : Promise.reject(failure()));
    } else if (job.kind === 'roll') {
      job.settle('rolled' in result ? Promise.resolve(result.rolled) : Promise.reject(failure()));
    } else {
      void this.ended(job.runId, result);
    }
    this.pump();
  }

  private async ended(runId: string, result: JobResult): Promise<void> {
    const active = this.active.get(runId);
    this.active.delete(runId);
    active?.control.close();
    if ('failed' in result) {
      await this.failed(runId, result.failed.message);
    } else if ('drove' in result) {
      if (result.drove.status === 'running') {
        // It played the cycles it was started for: the stint is over, and the run waits.
        await this.store.setStatus(runId, 'paused');
        this.emit({ type: 'runHalted', runId, status: 'paused', played: result.drove.played });
      } else {
        this.emit({ type: 'runHalted', runId, ...result.drove });
        // Set running again while it was halting: it goes back in the queue.
        if (!this.closed && (await this.store.status(runId)) === 'running') {
          await this.start(runId);
        }
      }
    }
    active?.settle();
  }

  /** A run whose job failed is paused, so a restart does not fail it again and again. */
  private async failed(runId: string, message: string): Promise<void> {
    if ((await this.store.status(runId)) === 'running') await this.store.setStatus(runId, 'paused');
    this.emit({ type: 'runFailed', runId, message });
  }

  /** A worker that died: its job fails, and a new worker takes its place when needed. */
  private lost(slot: Slot, error: Error): void {
    const index = this.slots.indexOf(slot);
    if (index < 0) return;
    this.slots.splice(index, 1);
    const job = slot.job;
    slot.job = null;
    void slot.worker.terminate();
    if (job?.kind === 'create') job.settle(Promise.reject(error));
    else if (job?.kind === 'roll') job.settle(Promise.reject(error));
    else if (job?.kind === 'drive') {
      const active = this.active.get(job.runId);
      this.active.delete(job.runId);
      void this.failed(job.runId, error.message).then(() => active?.settle());
    }
    this.pump();
  }
}

/** An edit on the trail, told apart from every other: what, who, when asked, when applied. */
const keyOf = (event: BanEvent): string =>
  JSON.stringify([event.oracleId, event.action, event.by, event.at, event.appliedAfterGameId]);

const appliedKeys = (trail: readonly BanEvent[]): Set<string> =>
  new Set(trail.filter((event) => event.appliedAfterGameId !== null).map(keyOf));
