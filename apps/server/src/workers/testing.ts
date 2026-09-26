import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  autoScripter,
  type CardProjection,
  loadHandScripts,
  MemoryScriptStore,
  ScriptResolver,
} from '@mtg/cards';
import { parseRunSettings, type RunSettings } from '@mtg/shared';
import { type OpenDatabase, openDatabase } from '../db/open.js';
import { Supervisor, type SupervisorEvent } from './supervisor.js';

/**
 * What the worker tests share (not part of the server): the committed card fixtures as a
 * JSONL pool on disk, the sim tests' small reference settings, and supervisors on a
 * database file in a temporary directory.
 */

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
const cardsDir = here('../../../../packages/cards');

const fixture = (name: string) =>
  Object.values(
    JSON.parse(readFileSync(`${cardsDir}/fixtures/${name}`, 'utf8')) as Record<
      string,
      CardProjection
    >,
  );

export const pool: CardProjection[] = [...fixture('scryfall.json'), ...fixture('corpus.json')];
export const handScriptsDir = `${cardsDir}/scripts`;

/** The resolver a run would have in-process: the reference the workers are held to. */
export const inProcessResolver = () =>
  new ScriptResolver({
    hand: loadHandScripts(handScriptsDir),
    auto: autoScripter,
    store: new MemoryScriptStore(),
    skipSmokeTest: true,
  });

// The sim's reference run: two small cycles, greedy agents.
export const settings: RunSettings = parseRunSettings({
  seed: '7',
  matchesPerCycle: 2,
  tiebreakMatches: 1,
  shortlistSize: 6,
  trialTopK: 1,
  trialMatches: 1,
  turnCap: 30,
  agentLevel: 'greedy',
});
export const now = () => '2026-09-26T12:00:00.000Z';

export interface Sandbox {
  readonly directory: string;
  readonly cardsPath: string;
  /** Opens (and migrates) a database file in the sandbox, and a supervisor over it. */
  supervise(
    name: string,
    options?: { readonly workers?: number; readonly cardsPath?: string },
  ): { database: OpenDatabase; supervisor: Supervisor; events: SupervisorEvent[] };
  /** Closes everything it opened and removes the directory. */
  dispose(): Promise<void>;
}

export const sandbox = (): Sandbox => {
  const directory = mkdtempSync(join(tmpdir(), 'mtg-workers-'));
  const cardsPath = join(directory, 'cards.jsonl');
  writeFileSync(cardsPath, pool.map((card) => JSON.stringify(card)).join('\n'));
  const opened: { database: OpenDatabase; supervisor: Supervisor }[] = [];
  return {
    directory,
    cardsPath,
    supervise(name, options = {}) {
      const database = openDatabase(join(directory, name));
      const supervisor = new Supervisor({
        database,
        workers: options.workers ?? 2,
        cardsPath: options.cardsPath ?? cardsPath,
        handScriptsDir,
        skipSmokeTest: true,
        now,
      });
      const events: SupervisorEvent[] = [];
      supervisor.on((event) => events.push(event));
      opened.push({ database, supervisor });
      return { database, supervisor, events };
    },
    async dispose() {
      for (const { database, supervisor } of opened) {
        await supervisor.close();
        if (database.sqlite.open) database.close();
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
};

/** Resolves with the first event `match` accepts. */
export const next = <E extends SupervisorEvent>(
  supervisor: Supervisor,
  match: (event: SupervisorEvent) => event is E,
): Promise<E> =>
  new Promise((resolve) => {
    const stop = supervisor.on((event) => {
      if (match(event)) {
        stop();
        resolve(event);
      }
    });
  });

/**
 * `promise`, or a failure after `ms`: a supervisor that never settles fails its test with
 * the reason rather than hanging the run until something else gives up.
 */
export const within = <T>(promise: Promise<T>, what: string, ms = 60_000): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not happen in ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
