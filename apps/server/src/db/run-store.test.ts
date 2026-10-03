import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
import { asOracleId, parseRunSettings, type RunSettings } from '@mtg/shared';
import {
  cardsIn,
  createRun,
  driveRun,
  exportRun,
  forkRun,
  importRun,
  latestGenerations,
  MemoryRunStore,
  type RunCards,
  RunError,
  type RunSnapshot,
  type RunStore,
} from '@mtg/sim';
import { afterAll, describe, expect, it } from 'vitest';
import { type OpenDatabase, openDatabase } from './open.js';
import { SqliteRunStore } from './run-store.js';

/**
 * The run store in SQLite (docs/06 "Resume protocol"; roadmap 5.6). The sim's tests pin
 * what a run is on the in-memory store; these hold the SQLite store to exactly that: the
 * same run played on either ends the same, and a process that dies mid-run — the database
 * file closed and opened again by a new store, nothing carried over in memory — resumes to
 * the run that never died.
 */

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
const cardsDir = '../../../../packages/cards';
const fixture = (name: string) =>
  Object.values(
    JSON.parse(readFileSync(here(`${cardsDir}/fixtures/${name}`), 'utf8')) as Record<
      string,
      CardProjection
    >,
  );
const cards: RunCards = {
  pool: [...fixture('scryfall.json'), ...fixture('corpus.json')],
  resolver: new ScriptResolver({
    hand: loadHandScripts(here(`${cardsDir}/scripts`)),
    auto: autoScripter,
    store: new MemoryScriptStore(),
    skipSmokeTest: true,
  }),
};

// The sim's reference run: two small cycles, greedy agents.
const settings: RunSettings = parseRunSettings({
  seed: '7',
  matchesPerCycle: 2,
  tiebreakMatches: 1,
  shortlistSize: 6,
  trialTopK: 1,
  trialMatches: 1,
  turnCap: 30,
  agentLevel: 'greedy',
});
const now = () => '2026-09-26T12:00:00.000Z';
const CYCLES = 2;

const essence = (snapshot: RunSnapshot | null) => ({
  run: snapshot === null ? null : { ...snapshot.run, status: undefined },
  lineage: snapshot?.lineage,
  cycles: snapshot?.cycles,
  bans: snapshot?.bans,
  current: snapshot?.current,
});

const directory = mkdtempSync(join(tmpdir(), 'mtg-run-store-'));
const opened: OpenDatabase[] = [];
const open = (name: string): { database: OpenDatabase; store: SqliteRunStore } => {
  const database = openDatabase(join(directory, name));
  opened.push(database);
  return { database, store: new SqliteRunStore(database, now) };
};
afterAll(() => {
  for (const database of opened) if (database.sqlite.open) database.close();
  rmSync(directory, { recursive: true, force: true });
});

const play = async (store: RunStore, cycles = CYCLES) => {
  await createRun({ store, cards, id: 'run-1', name: 'test', settings, now });
  await driveRun({ store, cards, runId: 'run-1', cycles });
  return store;
};

const reference = (async () => {
  const store = await play(new MemoryRunStore());
  return { store, snapshot: await store.load('run-1') };
})();

describe('a run in SQLite', async () => {
  const { snapshot } = await reference;
  const { database, store } = open('whole.db');
  await play(store);

  it('ends exactly where the same run on the in-memory store does', async () => {
    const stored = await store.load('run-1');
    expect(stored?.cycles).toHaveLength(CYCLES);
    expect(essence(stored)).toEqual(essence(snapshot));
    const { store: memory } = await reference;
    expect(await store.matches('run-1', true)).toEqual(await memory.matches('run-1', true));
  });

  it('is a WAL-mode file, as docs/06 has it', () => {
    expect(database.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(database.sqlite.pragma('synchronous', { simple: true })).toBe(1);
  });

  it('puts a row where docs/06 says: generations, cycles, matches, games, statistics', () => {
    const count = (table: string) =>
      (database.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(count('deck_generations')).toBe(snapshot?.lineage.length);
    expect(count('cycles')).toBe(CYCLES);
    const matches = snapshot?.cycles.reduce((sum, cycle) => sum + cycle.matches, 0);
    expect(count('matches')).toBe(matches);
    expect(count('games')).toBeGreaterThanOrEqual(2 * (matches ?? 0));
    // Every card either deck ran, counted in every cycle, against every deck.
    const cards = Object.keys(snapshot?.cycles[0]?.stats.A.cards ?? {}).length;
    expect(cards).toBeGreaterThan(0);
    expect(
      (
        database.sqlite
          .prepare(
            "SELECT count(*) AS n FROM card_stats WHERE cycle_id = 'run-1:1' AND agent = 'A' AND opponent_deck_gen = '*'",
          )
          .get() as { n: number }
      ).n,
    ).toBe(cards);
    // A finished cycle's columns say what its record says.
    const row = database.sqlite
      .prepare("SELECT * FROM cycles WHERE id = 'run-1:1'")
      .get() as Record<string, unknown>;
    const first = snapshot?.cycles[0];
    expect(row).toMatchObject({
      status: 'finished',
      matches_done: first?.matches,
      loser: first?.loser,
      win_rate_a: first?.winRate.A,
    });
  });

  it('refuses to make a run that exists', async () => {
    await expect(
      createRun({ store, cards, id: 'run-1', name: 'again', settings, now }),
    ).rejects.toThrow(RunError);
  });

  it('writes a status through, and says so for a run it does not have', async () => {
    await store.setStatus('run-1', 'paused');
    expect(await store.status('run-1')).toBe('paused');
    expect(await store.status('nope')).toBeNull();
    expect(await store.load('nope')).toBeNull();
    await store.setStatus('run-1', 'running');
  });
});

describe('a process that dies mid-run, and the one that resumes it', async () => {
  const { snapshot } = await reference;

  /** Plays until the store's `method` has been called `call` times, then dies. */
  const dieAt = async (name: string, method: 'saveMatch' | 'finishCycle', call: number) => {
    const { database, store } = open(name);
    await createRun({ store, cards, id: 'run-1', name: 'test', settings, now });
    let calls = 0;
    const original = store[method].bind(store) as (...args: unknown[]) => Promise<void>;
    (store as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
      calls += 1;
      if (calls === call) throw new Error('killed');
      await original(...args);
    };
    await expect(driveRun({ store, cards, runId: 'run-1', cycles: CYCLES })).rejects.toThrow(
      'killed',
    );
    // The process is gone: nothing survives but the file.
    database.close();
    const reopened = open(name).store;
    const between = await reopened.load('run-1');
    await driveRun({
      store: reopened,
      cards,
      runId: 'run-1',
      cycles: CYCLES - (between?.cycles.length ?? 0),
    });
    return { between, after: await reopened.load('run-1'), store: reopened };
  };

  it('dying mid-cycle leaves the matches before it, and the resume plays on to the same end', async () => {
    // The fourth write is cycle 2's second match: the first of that cycle was saved.
    const { between, after, store } = await dieAt('mid-cycle.db', 'saveMatch', 4);
    expect(between?.cycles).toHaveLength(1);
    expect(between?.current?.number).toBe(2);
    expect(between?.current?.matches).toHaveLength(1);
    expect(essence(after)).toEqual(essence(snapshot));
    const { store: memory } = await reference;
    expect(await store.matches('run-1', true)).toEqual(await memory.matches('run-1', true));
  });

  it('a write that fails halfway leaves none of itself behind', async () => {
    // A trigger fails cycle 2's first match at its second game, after the match row and
    // the first game are in: the transaction must take both back out.
    const name = 'half-written.db';
    const { database, store } = open(name);
    await createRun({ store, cards, id: 'run-1', name: 'test', settings, now });
    database.sqlite.exec(
      "CREATE TRIGGER die BEFORE INSERT ON games WHEN NEW.id = 'run-1:2:0:1' BEGIN SELECT RAISE(ABORT, 'killed'); END",
    );
    await expect(driveRun({ store, cards, runId: 'run-1', cycles: CYCLES })).rejects.toThrow(
      'killed',
    );
    database.sqlite.exec('DROP TRIGGER die');
    database.close();
    const reopened = open(name).store;
    const between = await reopened.load('run-1');
    expect(between?.current?.number).toBe(2);
    expect(between?.current?.matches).toEqual([]);
    await driveRun({ store: reopened, cards, runId: 'run-1', cycles: 1 });
    expect(essence(await reopened.load('run-1'))).toEqual(essence(snapshot));
  });

  it('dying before a cycle is finished replays the deck change to the same change', async () => {
    const { between, after } = await dieAt('before-finish.db', 'finishCycle', 1);
    expect(between?.cycles).toEqual([]);
    expect(between?.current?.matches).toHaveLength(settings.matchesPerCycle);
    expect(essence(after)).toEqual(essence(snapshot));
  });
});

describe('fork, export and import in SQLite', async () => {
  const { snapshot } = await reference;
  const { store } = open('bundle.db');
  await play(store);

  it('forks after a cycle, and the fork plays on as a run of its own', async () => {
    const fork = await forkRun({
      store,
      from: 'run-1',
      cycle: 1,
      id: 'fork',
      name: 'fork',
      seed: '99',
      now,
    });
    expect(await store.load('fork')).toEqual(fork);
    expect(fork.cycles).toEqual(snapshot?.cycles.slice(0, 1));
    await driveRun({ store, cards, runId: 'fork', cycles: 1 });
    expect((await store.load('fork'))?.cycles.map((cycle) => cycle.number)).toEqual([1, 2]);
    expect(essence(await store.load('run-1'))).toEqual(essence(snapshot));
  });

  it('exports a bundle that imports into another database as the same run', async () => {
    const bundle = await exportRun({ store, runId: 'run-1', logs: true, now });
    const target = open('imported.db').store;
    await importRun({ store: target, bundle: JSON.parse(JSON.stringify(bundle)), id: 'copy' });
    const copied = await target.load('copy');
    expect(copied?.run.status).toBe('paused');
    const { run: _run, ...rest } = essence(copied);
    const { run: _original, ...expected } = essence(snapshot);
    expect(rest).toEqual(expected);
    expect(await target.matches('copy', true)).toEqual(await store.matches('run-1', true));
    // A finished cycle keeps its own match count, however many matches came in with it.
    expect(copied?.cycles.map((cycle) => cycle.matches)).toEqual(
      snapshot?.cycles.map((cycle) => cycle.matches),
    );
  });
});

describe('a cycle that changed nothing, in SQLite', async () => {
  // A pool that scripts only what the decks already hold, so no change can be made.
  const { store } = open('unchanged.db');
  await createRun({ store, cards, id: 'run-1', name: 'test', settings, now });
  const held = new Set(
    cardsIn(latestGenerations((await store.load('run-1'))?.lineage ?? []).A.deck).keys(),
  );
  await driveRun({
    store,
    cards: {
      pool: cards.pool,
      resolver: {
        resolve: (card, request) =>
          held.has(asOracleId(card.oracleId))
            ? cards.resolver.resolve(card, request)
            : { status: 'unscripted', definition: null, source: 'none', reasons: [] },
      },
    },
    runId: 'run-1',
    cycles: 1,
  });

  it('keeps the deck agent’s reason with the cycle', async () => {
    const [cycle] = (await store.load('run-1'))?.cycles ?? [];
    expect(cycle?.unchanged).toMatch(/nothing the engine can play/);
  });
});
