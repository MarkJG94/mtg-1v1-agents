// A worker started from TypeScript source (tests, `pnpm dev`) begins here: it registers
// tsx in its own thread, then loads the worker it was asked for. The bundle's workers are
// JavaScript and start directly (see spawn.ts).
import { workerData } from 'node:worker_threads';

const { register } = await import('tsx/esm/api');
register();
await import(workerData.entry);
