import {
  type MessagePort,
  parentPort,
  receiveMessageOnPort,
  workerData,
} from 'node:worker_threads';
import type { CardProjection } from '@mtg/cards';
import { type BanRequest, createRun, driveRun, type RunCards, type RunStore } from '@mtg/sim';
import { readCardPool } from '../cards.js';
import { client } from './rpc.js';
import { ScriptClient } from './script-client.js';
import type { JobResult, SimJob, SimWorkerData } from './sim-protocol.js';

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

/** Every edit waiting on a port, taken without yielding (`DriveOptions.banRequests`). */
const drain = (port: MessagePort): BanRequest[] => {
  const taken: BanRequest[] = [];
  for (;;) {
    const received = receiveMessageOnPort(port);
    if (received === undefined) return taken;
    taken.push(received.message as BanRequest);
  }
};

const run = async (job: SimJob): Promise<JobResult> => {
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
  try {
    const drove = await driveRun({
      store,
      cards: cards(),
      runId: job.runId,
      cycles: job.cycles ?? Number.POSITIVE_INFINITY,
      banRequests: () => drain(job.control),
    });
    return { job: job.job, drove };
  } finally {
    // An edit asked for after the last game this job played is not lost with the job: it
    // is kept on the trail as pending, and the next cycle's start puts it into effect.
    const left = drain(job.control);
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
