import {
  type MessagePort,
  parentPort,
  receiveMessageOnPort,
  workerData,
} from 'node:worker_threads';
import type { CardProjection } from '@mtg/cards';
import { banListOf, type GameEvent } from '@mtg/shared';
import {
  type BanRequest,
  createRun,
  driveRun,
  type LiveGames,
  type RunCards,
  type RunStore,
  seedDeckFor,
} from '@mtg/sim';
import { readCardPool } from '../cards.js';
import { client } from './rpc.js';
import { ScriptClient } from './script-client.js';
import type {
  ControlMessage,
  JobResult,
  LiveMessage,
  SimJob,
  SimWorkerData,
} from './sim-protocol.js';

/**
 * A simulation worker (docs/01 "Processes"; roadmap 5.7): it runs one job at a time —
 * making a run, or driving one until it is paused or stopped — and holds no database. Every
 * read and write of the run goes to the API process through the run store it serves, and
 * every card is scripted by the scripting worker; what is left here is playing Magic.
 */

const data = workerData as SimWorkerData;
const parent = parentPort;
if (parent === null) throw new Error('a simulation worker runs in a worker thread');

const store = client<RunStore>(data.storePort) as RunStore;
const resolver = new ScriptClient(data.scriptPort);
let pool: CardProjection[] | null = null;
const cards = (): RunCards => {
  pool ??= readCardPool(data.cardsPath);
  return { pool, resolver };
};

/**
 * A drive job's control port, read without yielding: a game does not give the event loop a
 * turn between its end and the next, so messages are taken off the port rather than waited
 * for (`DriveOptions.banRequests`).
 */
class Control {
  private bans: BanRequest[] = [];
  private watched = false;

  constructor(readonly port: MessagePort) {}

  private poll(): void {
    for (;;) {
      const received = receiveMessageOnPort(this.port);
      if (received === undefined) return;
      const message = received.message as ControlMessage;
      if ('ban' in message) this.bans.push(message.ban);
      else this.watched = message.watch;
    }
  }

  takeBans(): BanRequest[] {
    this.poll();
    const taken = this.bans;
    this.bans = [];
    return taken;
  }

  watching(): boolean {
    this.poll();
    return this.watched;
  }
}

/** How often a watched game's events are sent on, at most (docs/07: "every ~50 ms"). */
const BATCH_MS = 50;

/**
 * A watched game streamed to the API process: its start, its events in batches of ~50 ms,
 * its end. Posting never waits; a game nobody watches as it starts is not streamed at all.
 */
const liveStream = (runId: string, control: Control): LiveGames => {
  let batch: GameEvent[] = [];
  let sent = 0;
  const post = (message: LiveMessage) => data.livePort.postMessage(message);
  const flush = () => {
    if (batch.length > 0) post({ runId, events: batch });
    batch = [];
    sent = Date.now();
  };
  return {
    watching: () => control.watching(),
    started: (game) => {
      post({ runId, start: game });
      sent = Date.now();
    },
    event: (event) => {
      batch.push(event);
      if (Date.now() - sent >= BATCH_MS) flush();
    },
    ended: (game) => {
      flush();
      post({ runId, end: game });
    },
  };
};

const run = async (job: SimJob): Promise<JobResult> => {
  if (job.kind === 'roll') {
    const seed = seedDeckFor({
      cards: cards(),
      settings: job.settings,
      banList: banListOf(job.bans),
    });
    return {
      job: job.job,
      rolled: {
        deck: seed.deck,
        colours: seed.colours,
        lands: seed.lands,
        nonbasicLands: seed.nonbasicLands,
        rerolled: seed.rerolled.map((card) => ({ ...card })),
      },
    };
  }
  if (job.kind === 'create') {
    const created = await createRun({
      store,
      cards: cards(),
      id: job.id,
      name: job.name,
      settings: job.settings,
      now: () => job.createdAt,
      ...(job.seedDeck === undefined ? {} : { seedDeck: job.seedDeck }),
      ...(job.bans === undefined ? {} : { bans: job.bans }),
    });
    return { job: job.job, created };
  }
  const control = new Control(job.control);
  try {
    const drove = await driveRun({
      store,
      cards: cards(),
      runId: job.runId,
      cycles: job.cycles ?? Number.POSITIVE_INFINITY,
      banRequests: () => control.takeBans(),
      live: liveStream(job.runId, control),
    });
    return { job: job.job, drove };
  } finally {
    // An edit asked for after the last game this job played is not lost with the job: it
    // is kept on the trail as pending, and the next cycle's start puts it into effect.
    const left = control.takeBans();
    job.control.close();
    if (left.length > 0) {
      const snapshot = await store.load(job.runId);
      if (snapshot !== null) {
        await store.saveBans(job.runId, [
          ...snapshot.bans,
          ...left.map((request) => ({
            oracleId: request.oracleId,
            action: request.action,
            note: request.note ?? '',
            by: request.by,
            at: request.at,
            appliedAfterGameId: null,
          })),
        ]);
      }
    }
  }
};

parent.on('message', (job: SimJob) => {
  void run(job)
    .catch(
      (error: unknown): JobResult => ({
        job: job.job,
        failed:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'Error', message: String(error) },
      }),
    )
    .then((result) => parent.postMessage(result));
});
