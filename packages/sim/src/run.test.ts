import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  autoScripter,
  type CardProjection,
  loadHandScripts,
  MemoryScriptStore,
  ScriptResolver,
} from '@mtg/cards';
import {
  asOracleId,
  banViolations,
  type DeckGeneration,
  parseRunSettings,
  type RunSettings,
} from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { cardCount, cardsIn } from './deck.js';
import {
  createRun,
  decklist,
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
} from './run.js';

/**
 * A run (docs/05, docs/06 "Resume protocol"; roadmap 5.6), on the in-memory store: cycles
 * one after another, the loser changing, checkpoints, and the property the checkpoints
 * exist for — a run that crashes and resumes ends exactly where one that never crashed
 * does. The SQLite store runs the same checks in the server's tests.
 */

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
const fixture = (name: string) =>
  Object.values(
    JSON.parse(readFileSync(here(`../../cards/fixtures/${name}`), 'utf8')) as Record<
      string,
      CardProjection
    >,
  );
const cards: RunCards = {
  pool: [...fixture('scryfall.json'), ...fixture('corpus.json')],
  resolver: new ScriptResolver({
    hand: loadHandScripts(here('../../cards/scripts')),
    auto: autoScripter,
    store: new MemoryScriptStore(),
    skipSmokeTest: true,
  }),
};

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

const fresh = async (store: RunStore = new MemoryRunStore(), id = 'run-1') => {
  await createRun({ store, cards, id, name: 'test', settings, now });
  return store;
};

/** What a run is, without the parts that differ between two stores holding it. */
const essence = (snapshot: RunSnapshot | null) => ({
  lineage: snapshot?.lineage,
  cycles: snapshot?.cycles,
  bans: snapshot?.bans,
  current: snapshot?.current,
});

const CYCLES = 2;
const reference = (async () => {
  const store = await fresh();
  const result = await driveRun({ store, cards, runId: 'run-1', cycles: CYCLES });
  return { store, result, snapshot: await store.load('run-1') };
})();

/** A store that "crashes" — throws — at a chosen write, before or after making it. */
const crashing = (
  inner: RunStore,
  at: { method: 'saveMatch' | 'finishCycle'; call: number; after: boolean },
): RunStore => {
  let calls = 0;
  const wrap =
    <A extends unknown[]>(method: 'saveMatch' | 'finishCycle', f: (...args: A) => Promise<void>) =>
    async (...args: A) => {
      if (method !== at.method) return f(...args);
      calls += 1;
      if (calls === at.call && !at.after) throw new Error('crash');
      await f(...args);
      if (calls === at.call && at.after) throw new Error('crash');
    };
  return {
    create: (...args) => inner.create(...args),
    load: (...args) => inner.load(...args),
    status: (...args) => inner.status(...args),
    setStatus: (...args) => inner.setStatus(...args),
    matches: (...args) => inner.matches(...args),
    saveBans: (...args) => inner.saveBans(...args),
    startCycle: (...args) => inner.startCycle(...args),
    saveGenerations: (...args) => inner.saveGenerations(...args),
    saveMatch: wrap('saveMatch', (...args: Parameters<RunStore['saveMatch']>) =>
      inner.saveMatch(...args),
    ),
    finishCycle: wrap('finishCycle', (...args: Parameters<RunStore['finishCycle']>) =>
      inner.finishCycle(...args),
    ),
  };
};

describe('a run', async () => {
  const { snapshot, result } = await reference;

  it('starts both agents on the same seed deck, as generation 0', async () => {
    const created = await (await fresh(new MemoryRunStore(), 'seed-only')).load('seed-only');
    expect(created?.run.status).toBe('created');
    const [a, b] = created?.lineage ?? [];
    expect(a?.deck).toEqual(b?.deck);
    expect([a?.agent, a?.generation, a?.cause, b?.agent, b?.generation]).toEqual([
      'A',
      0,
      'seed',
      'B',
      0,
    ]);
    expect(cardCount(a?.deck.main ?? [])).toBe(60);
  });

  it('plays its cycles, and changes the loser’s deck once each', () => {
    expect(result).toEqual({ played: CYCLES, status: 'running' });
    expect(snapshot?.cycles.map((cycle) => cycle.number)).toEqual([1, 2]);
    expect(snapshot?.current).toBeNull();
    const changes = snapshot?.lineage.filter((entry) => entry.cause === 'change') ?? [];
    expect(changes).toHaveLength(CYCLES);
    for (const [i, cycle] of (snapshot?.cycles ?? []).entries()) {
      expect(changes[i]?.agent).toBe(cycle.loser);
      expect(changes[i]?.cycle).toBe(cycle.number);
      expect(changes[i]?.change?.reason.length).toBeGreaterThan(0);
    }
  });

  it('counts generations up per agent, and starts each cycle from the newest', () => {
    for (const agent of ['A', 'B'] as const) {
      const mine = snapshot?.lineage.filter((entry) => entry.agent === agent) ?? [];
      expect(mine.map((entry) => entry.generation)).toEqual(mine.map((_, i) => i));
    }
    const [first, second] = snapshot?.cycles ?? [];
    expect(first?.generations).toEqual({ A: 0, B: 0 });
    const loser = first?.loser ?? 'A';
    expect(second?.generations[loser]).toBe(1);
  });

  it('stores every match with its games’ logs, and hands them out only when asked', async () => {
    const { store } = await reference;
    const all = await store.matches('run-1', true);
    const total = snapshot?.cycles.reduce((sum, cycle) => sum + cycle.matches, 0);
    expect(all).toHaveLength(total ?? -1);
    for (const stored of all) expect(stored.logs).toHaveLength(stored.match.games.length);
    for (const stored of await store.matches('run-1', false)) expect(stored.logs).toEqual([]);
  });

  it('keeps the statistics each trial recorded', () => {
    const trialled = Object.keys(snapshot?.cycles[0]?.trials ?? {});
    expect(trialled.length).toBeGreaterThan(0);
  });
});

describe('a crash, and the resume after it (docs/06 "Resume protocol")', async () => {
  const { snapshot } = await reference;
  const resumeAfter = async (at: Parameters<typeof crashing>[1]) => {
    const inner = await fresh();
    await expect(
      driveRun({ store: crashing(inner, at), cards, runId: 'run-1', cycles: CYCLES }),
    ).rejects.toThrow('crash');
    const between = await inner.load('run-1');
    // Resumed for the cycles the run still owes, the one in progress among them.
    const owed = CYCLES - (between?.cycles.length ?? 0);
    const resumed = await driveRun({ store: inner, cards, runId: 'run-1', cycles: owed });
    return { between, resumed, after: await inner.load('run-1'), inner };
  };

  it('resumes after a checkpoint to exactly the run that never crashed', async () => {
    // The third match is the first of cycle 2; the crash follows its write.
    const { between, resumed, after } = await resumeAfter({
      method: 'saveMatch',
      call: 3,
      after: true,
    });
    expect(between?.cycles).toHaveLength(1);
    expect(between?.current?.number).toBe(2);
    expect(between?.current?.matches).toHaveLength(1);
    expect(resumed.played).toBe(1);
    expect(essence(after)).toEqual(essence(snapshot));
  });

  it('replays the match a crash interrupted, to the same end', async () => {
    const { between, after } = await resumeAfter({ method: 'saveMatch', call: 2, after: false });
    expect(between?.current?.matches).toHaveLength(1);
    expect(essence(after)).toEqual(essence(snapshot));
  });

  it('replays a deck change a crash interrupted, to the same change', async () => {
    const { between, after } = await resumeAfter({ method: 'finishCycle', call: 1, after: false });
    expect(between?.cycles).toEqual([]);
    expect(between?.current?.matches).toHaveLength(settings.matchesPerCycle);
    expect(essence(after)).toEqual(essence(snapshot));
  });

  it('halts after the match in progress when paused, and carries on when running again', async () => {
    const inner = await fresh();
    let saved = 0;
    const pausing: RunStore = {
      ...crashing(inner, { method: 'finishCycle', call: 99, after: true }),
      saveMatch: async (...args) => {
        await inner.saveMatch(...args);
        saved += 1;
        if (saved === 3) await inner.setStatus('run-1', 'paused');
      },
    };
    const first = await driveRun({ store: pausing, cards, runId: 'run-1', cycles: CYCLES });
    expect(first).toEqual({ played: 1, status: 'paused' });
    expect(await driveRun({ store: inner, cards, runId: 'run-1', cycles: 1 })).toEqual({
      played: 0,
      status: 'paused',
    });
    await inner.setStatus('run-1', 'running');
    await driveRun({ store: inner, cards, runId: 'run-1', cycles: 1 });
    expect(essence(await inner.load('run-1'))).toEqual(essence(snapshot));
  });
});

describe('a ban asked for between cycles', async () => {
  const { snapshot } = await reference;
  const store = await fresh();
  await driveRun({ store, cards, runId: 'run-1', cycles: 1 });
  const before = latestGenerations((await store.load('run-1'))?.lineage ?? []);
  const target = [...cardsIn(before.A.deck).keys()].find(
    (oracleId) => !before.A.deck.main.every((slot) => slot.oracleId !== oracleId),
  );
  const at = now();
  await store.saveBans('run-1', [
    ...((await store.load('run-1'))?.bans ?? []),
    {
      oracleId: target ?? asOracleId('none'),
      action: 'ban',
      note: '',
      by: 'operator',
      at,
      appliedAfterGameId: null,
    },
  ]);
  await driveRun({ store, cards, runId: 'run-1', cycles: 1 });
  const after = await store.load('run-1');

  it('takes effect as the next cycle starts, legalising the decks before it plays', () => {
    expect(after?.bans.at(-1)?.appliedAfterGameId).toBe(`${settings.seed}:cycle-2:start`);
    const bans = after?.lineage.filter((entry) => entry.cause === 'ban') ?? [];
    expect(bans.length).toBeGreaterThan(0);
    for (const entry of bans) expect(entry.cycle).toBe(2);
    const list = new Map([[target ?? asOracleId('none'), 'banned' as const]]);
    for (const agent of ['A', 'B'] as const) {
      expect(banViolations(latestGenerations(after?.lineage ?? [])[agent].deck, list)).toEqual([]);
    }
    // The cycle began from the legalised decks.
    const started = after?.cycles[1]?.generations;
    const newest = (agent: 'A' | 'B') =>
      Math.max(
        ...(after?.lineage ?? [])
          .filter((entry) => entry.agent === agent && entry.cause !== 'change')
          .map((entry) => entry.generation),
      );
    expect(started?.A).toBeGreaterThanOrEqual(newest('A'));
    expect(snapshot).toBeDefined();
  });
});

describe('fork, export and import', async () => {
  const { store, snapshot } = await reference;

  it('forks a run as it stood after a cycle, with a fresh seed and the ban list', async () => {
    const fork = await forkRun({
      store,
      from: 'run-1',
      cycle: 1,
      id: 'fork',
      name: 'fork',
      seed: '99',
      now,
    });
    expect(fork.run.forkedFrom).toEqual({ run: 'run-1', cycle: 1 });
    expect([fork.run.seed, fork.run.settings.seed, fork.run.status]).toEqual([
      '99',
      '99',
      'created',
    ]);
    expect(fork.cycles).toEqual(snapshot?.cycles.slice(0, 1));
    expect(fork.lineage).toEqual(snapshot?.lineage.filter((entry) => entry.cycle <= 1));
    expect(fork.bans).toEqual(snapshot?.bans);
    expect(fork.current).toBeNull();
    // It plays on from there as a run of its own.
    const played = await driveRun({ store, cards, runId: 'fork', cycles: 1 });
    expect(played.played).toBe(1);
    expect((await store.load('fork'))?.cycles.map((cycle) => cycle.number)).toEqual([1, 2]);
    // And the run it came from is untouched.
    expect(essence(await store.load('run-1'))).toEqual(essence(snapshot));
  });

  it('refuses to fork at a cycle the run has not finished', async () => {
    await expect(
      forkRun({ store, from: 'run-1', cycle: 3, id: 'x', name: 'x', seed: '1', now }),
    ).rejects.toThrow(RunError);
  });

  it('exports a bundle that imports as the same run under a new id', async () => {
    const bundle = await exportRun({ store, runId: 'run-1', logs: true, now });
    const target = new MemoryRunStore();
    const imported = await importRun({
      store: target,
      bundle: structuredClone(bundle),
      id: 'copy',
    });
    expect(imported.run.id).toBe('copy');
    expect(imported.run.status).toBe('paused');
    expect(essence(await target.load('copy'))).toEqual(essence(snapshot));
    expect(await target.matches('copy', true)).toEqual(await store.matches('run-1', true));
    // Without logs, the matches come without them.
    const lean = await exportRun({ store, runId: 'run-1', logs: false, now });
    for (const stored of lean.matches) expect(stored.logs).toEqual([]);
  });

  it('refuses a bundle it cannot read', async () => {
    const bundle = await exportRun({ store, runId: 'run-1', logs: false, now });
    await expect(
      importRun({ store: new MemoryRunStore(), bundle: { ...bundle, version: 2 as 1 }, id: 'x' }),
    ).rejects.toThrow(RunError);
  });

  it('writes a plain-text decklist for every generation', async () => {
    const bundle = await exportRun({
      store,
      runId: 'run-1',
      logs: false,
      now,
      name: (id) => `<${id}>`,
    });
    expect(Object.keys(bundle.decklists).sort()).toEqual(
      (snapshot?.lineage ?? [])
        .map((entry: DeckGeneration) => `${entry.agent}-${entry.generation}`)
        .sort(),
    );
    const text = bundle.decklists['A-0'] ?? '';
    expect(text).toContain('\nSideboard\n');
    expect(text.split('\n')[0]).toMatch(/^\d+ <.+>$/);
  });

  it('writes the main deck, then the sideboard, a line a card', () => {
    const text = decklist(
      {
        main: [
          { oracleId: asOracleId('b'), count: 4 },
          { oracleId: asOracleId('a'), count: 56 },
        ],
        side: [{ oracleId: asOracleId('c'), count: 15 }],
      },
      (id) => id.toUpperCase(),
    );
    expect(text).toBe('56 A\n4 B\n\nSideboard\n15 C');
  });
});

describe('creating a run', () => {
  it('takes a pasted 75, and refuses one of the wrong size or against the list', async () => {
    const { snapshot } = await reference;
    const deck = snapshot?.lineage[0]?.deck;
    if (deck === undefined) throw new Error('no deck');
    const store = new MemoryRunStore();
    const made = await createRun({
      store,
      cards,
      id: 'fixed',
      name: 'f',
      settings,
      now,
      seedDeck: deck,
    });
    expect(made.lineage[0]?.deck).toEqual(deck);

    const short = { main: deck.main.slice(1), side: deck.side };
    await expect(
      createRun({ store, cards, id: 'short', name: 's', settings, now, seedDeck: short }),
    ).rejects.toThrow(/sixty cards/);

    const [first] = deck.main;
    await expect(
      createRun({
        store,
        cards,
        id: 'banned',
        name: 'b',
        settings,
        now,
        seedDeck: deck,
        bans: [
          {
            oracleId: first?.oracleId ?? asOracleId('x'),
            action: 'ban',
            note: '',
            by: 'op',
            at: now(),
            appliedAfterGameId: null,
          },
        ],
      }),
    ).rejects.toThrow(RunError);
  });

  it('draws the seed deck around an initial ban list, which is in effect from the start', async () => {
    const { snapshot } = await reference;
    const first = snapshot?.lineage[0]?.deck.main.find((slot) => slot.count < 10)?.oracleId;
    const store = new MemoryRunStore();
    const made = await createRun({
      store,
      cards,
      id: 'listed',
      name: 'l',
      settings,
      now,
      bans: [
        {
          oracleId: first ?? asOracleId('x'),
          action: 'ban',
          note: '',
          by: 'op',
          at: now(),
          appliedAfterGameId: null,
        },
      ],
    });
    expect(
      cardsIn(made.lineage[0]?.deck ?? { main: [], side: [] }).has(first ?? asOracleId('x')),
    ).toBe(false);
    expect(made.bans[0]?.appliedAfterGameId).toBe('listed:created');
  });
});
