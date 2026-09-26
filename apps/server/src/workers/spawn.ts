import { type TransferListItem, Worker } from 'node:worker_threads';

/**
 * Starts one of the server's workers. From the bundle, `dist/<name>.js` sits beside the
 * server and starts directly; from TypeScript source, the worker starts in
 * `dev-entry.mjs`, which registers tsx in the new thread before loading `<name>.ts` — a
 * worker does not inherit the loader its parent was started with.
 */
export type WorkerName = 'sim-worker' | 'script-worker';

export const spawnWorker = (
  name: WorkerName,
  workerData: Record<string, unknown>,
  transferList: readonly TransferListItem[] = [],
): Worker => {
  const here = import.meta.url;
  if (here.endsWith('.ts')) {
    return new Worker(new URL('./dev-entry.mjs', here), {
      workerData: { ...workerData, entry: new URL(`./${name}.ts`, here).href },
      transferList: [...transferList],
    });
  }
  return new Worker(new URL(`./${name}.js`, here), {
    workerData,
    transferList: [...transferList],
  });
};
