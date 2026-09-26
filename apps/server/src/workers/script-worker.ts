import { type MessagePort, parentPort, workerData } from 'node:worker_threads';
import {
  autoScripter,
  type CachedScript,
  loadHandScripts,
  ScriptResolver,
  type ScriptStore,
} from '@mtg/cards';
import { openReadonly } from '../db/open.js';
import { SqliteScriptStore } from '../db/script-store.js';
import type { ScriptAnswer, ScriptConnect, ScriptRequest, ScriptWrite } from './script-protocol.js';

/**
 * The scripting worker (docs/01 "Processes"; roadmap 5.7): the one place cards are
 * scripted — hand script, cached verdict, auto-scripter, validation — for every run and for
 * the API. It reads the `card_scripts` cache through a read-only connection and posts
 * every verdict and unsupported request to the API process, which writes them; verdicts
 * it has reached are also kept here, so the next request for a card does not wait on that
 * write.
 */

export interface ScriptWorkerData {
  readonly databasePath: string;
  readonly handScriptsDir: string;
  readonly skipSmokeTest?: boolean;
}

const data = workerData as ScriptWorkerData;
const parent = parentPort;
if (parent === null) throw new Error('the scripting worker runs in a worker thread');

const database = openReadonly(data.databasePath);
const cache = new SqliteScriptStore(database.db);
const reached = new Map<string, CachedScript>();
const write = (message: ScriptWrite) => parent.postMessage(message);

/** The card being scripted afresh, whose cached verdict is not to be believed. */
let forced: string | null = null;

const store: ScriptStore = {
  get: (oracleId) => (oracleId === forced ? null : (reached.get(oracleId) ?? cache.get(oracleId))),
  put: (entry) => {
    reached.set(entry.oracleId, entry);
    write({ put: entry });
  },
  logUnsupported: (request) => write({ unsupported: request }),
};

const resolver = new ScriptResolver({
  hand: loadHandScripts(data.handScriptsDir),
  auto: autoScripter,
  store,
  skipSmokeTest: data.skipSmokeTest ?? false,
});

const answer = (port: MessagePort) => {
  port.on('message', (value: ScriptRequest) => {
    let reply: ScriptAnswer;
    forced = value.force === true ? value.card.oracleId : null;
    try {
      reply = { id: value.id, resolution: resolver.resolve(value.card, value.request) };
    } catch (error) {
      reply = { id: value.id, error: error instanceof Error ? error.message : String(error) };
    } finally {
      forced = null;
    }
    port.postMessage(reply);
    if (value.signal !== undefined) {
      Atomics.store(value.signal, 0, 1);
      Atomics.notify(value.signal, 0);
    }
  });
};

parent.on('message', (value: ScriptConnect) => {
  if (value.connect !== undefined) answer(value.connect);
});
