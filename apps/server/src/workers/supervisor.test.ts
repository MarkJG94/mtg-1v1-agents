import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { banListOf, banViolations, type OracleId } from '@mtg/shared';
import {
  cardsIn,
  createRun,
  driveRun,
  latestGenerations,
  MemoryRunStore,
  type RunSnapshot,
} from '@mtg/sim';
import { afterAll, describe, expect, it } from 'vitest';
import { openReadonly } from '../db/open.js';
import type { SupervisorEvent } from './supervisor.js';
import { inProcessResolver, next, now, pool, sandbox, settings, within } from './testing.js';

/**
 * The worker pool (docs/01 "Processes"; roadmap 5.7), on real threads: runs made and played
 * on simulation workers, cards scripted by the scripting worker, every write made by the
 * API process — and a run on a worker ends exactly where the same run played in-process
 * does, including one whose server was killed mid-run and restarted.
 */

const box = sandbox();
afterAll(() => box.dispose());

const CYCLES = 2;
const reference = (async () => {
  const store = new MemoryRunStore();
  const cards = { pool, resolver: inProcessResolver() };
  await createRun({ store, cards, id: 'run-1', name: 'test', settings, now });
  await driveRun({ store, cards, runId: 'run-1', cycles: CYCLES });
  return (await store.load('run-1')) as RunSnapshot;
})();

/** The run as the first `cycles` cycles left it, whatever came after. */
const through = (snapshot: RunSnapshot | null, cycles: number) => ({
  lineage: snapshot?.lineage.filter((entry) => entry.cycle <= cycles),
  cycles: snapshot?.cycles.slice(0, cycles),
  bans: snapshot?.bans,
});

const is =
  <T extends SupervisorEvent['type']>(type: T, runId?: string) =>
  (event: SupervisorEvent): event is Extract<SupervisorEvent, { type: T }> =>
    event.type === type && (runId === undefined || ('runId' in event && event.runId === runId));

describe('a run on a simulation worker', async () => {
  const expected = await reference;
  const { supervisor, events } = box.supervise('whole.db');
  const created = await supervisor.create({ id: 'run-1', name: 'test', settings });
  await supervisor.start('run-1', { cycles: CYCLES });
  await within(supervisor.idle('run-1'), 'run run-1 going idle');
  const stored = await supervisor.store.load('run-1');

  it('is made on the worker with the seed deck the in-process run rolls', () => {
    expect(created.lineage).toEqual(expected.lineage.filter((entry) => entry.cycle === 0));
  });

  it('plays the cycles it was started for, then waits, paused', () => {
    expect(stored?.run.status).toBe('paused');
    expect(stored?.cycles).toHaveLength(CYCLES);
    expect(events.filter(is('runHalted'))).toEqual([
      { type: 'runHalted', runId: 'run-1', status: 'paused', played: CYCLES },
    ]);
  });

  it('ends exactly where the same run played in-process ends', () => {
    expect(through(stored, CYCLES)).toEqual(through(expected, CYCLES));
    expect(stored?.current).toBeNull();
  });

  it('tells the API process of every match, deck change and cycle as it is saved', () => {
    const matches = expected.cycles.reduce((sum, cycle) => sum + cycle.matches, 0);
    expect(events.filter(is('matchSaved'))).toHaveLength(matches);
    expect(events.filter(is('cycleFinished')).map((event) => event.record.number)).toEqual([1, 2]);
    const changed = events.filter(is('deckChanged')).flatMap((event) => event.generations);
    expect(changed).toEqual(expected.lineage.filter((entry) => entry.cycle > 0));
  });

  it('left every card it scripted in the cache, written by the API process', () => {
    for (const slot of created.lineage[0]?.deck.main ?? []) {
      expect(supervisor.scripts.get(slot.oracleId)?.status).toBe('supported');
    }
  });
});

describe('a server killed mid-run, and the one that starts after it', async () => {
  const expected = await reference;
  const first = box.supervise('killed.db');
  await first.supervisor.create({ id: 'run-1', name: 'test', settings });
  await first.supervisor.start('run-1');
  // Killed during the second cycle, with a match of it saved: nothing but the file is left.
  await within(
    next(
      first.supervisor,
      (event): event is SupervisorEvent =>
        event.type === 'matchSaved' && event.match.cycle === 2 && event.match.index === 0,
    ),
    'a match of cycle 2',
  );
  await first.supervisor.close();
  first.database.close();

  const second = box.supervise('killed.db');
  const between = await second.supervisor.store.load('run-1');
  const resumed = await second.supervisor.resumeRunning();
  await within(
    next(
      second.supervisor,
      (event): event is SupervisorEvent =>
        event.type === 'cycleFinished' && event.record.number === 2,
    ),
    'cycle 2 finishing',
  );
  await second.supervisor.pause('run-1');
  await within(second.supervisor.idle('run-1'), 'run run-1 going idle');
  const after = await second.supervisor.store.load('run-1');

  it('finds the run still running at its last checkpoint, and plays it on', () => {
    expect(between?.run.status).toBe('running');
    expect(between?.current?.number).toBe(2);
    expect(between?.current?.matches.length).toBeGreaterThanOrEqual(1);
    expect(resumed).toEqual(['run-1']);
  });

  it('ends exactly where the run that was never killed ends', () => {
    expect(through(after, CYCLES)).toEqual(through(expected, CYCLES));
  });
});

describe('the queue, pausing and stopping', async () => {
  const { supervisor, events } = box.supervise('queue.db', { workers: 1 });
  await supervisor.create({ id: 'one', name: 'one', settings });
  await supervisor.create({ id: 'two', name: 'two', settings: { ...settings, seed: '8' } });
  await supervisor.start('one');
  await supervisor.start('two');
  const waiting = { active: supervisor.isActive('two'), load: supervisor.load };
  // Paused as its first match is saved: it halts after that match.
  await within(next(supervisor, is('matchSaved', 'one')), 'matchSaved for one');
  await supervisor.pause('one');
  await within(supervisor.idle('one'), 'run one going idle');
  const one = await supervisor.store.load('one');
  await within(next(supervisor, is('matchSaved', 'two')), 'matchSaved for two');
  await supervisor.stop('two');
  await within(supervisor.idle('two'), 'run two going idle');
  const two = await supervisor.store.load('two');

  it('holds a run that finds every worker busy until one is free', () => {
    expect(waiting).toEqual({ active: false, load: { workers: 1, busy: 1, queued: 1 } });
    const order = events
      .filter((event) => event.type === 'runStarted' || event.type === 'runHalted')
      .map((event) => `${event.type}:${'runId' in event ? event.runId : ''}`);
    expect(order).toEqual(['runStarted:one', 'runHalted:one', 'runStarted:two', 'runHalted:two']);
  });

  it('halts a paused or stopped run after the match in progress, with it saved', () => {
    expect(one?.run.status).toBe('paused');
    expect(two?.run.status).toBe('stopped');
    for (const run of [one, two]) {
      expect(run?.current?.matches.length).toBeGreaterThanOrEqual(1);
      expect(run?.current?.matches.length).toBeLessThan(settings.matchesPerCycle + 1);
    }
  });

  it('refuses to start a stopped run, and a run it does not have', async () => {
    await expect(supervisor.start('two')).rejects.toThrow('stopped');
    await expect(supervisor.start('three')).rejects.toThrow('no run');
  });

  it('carries a paused run on from where it halted', async () => {
    await supervisor.start('one', { cycles: 1 });
    await within(supervisor.idle('one'), 'run one going idle');
    const after = await supervisor.store.load('one');
    expect(after?.cycles.map((cycle) => cycle.number)).toEqual([1]);
    // The matches saved before the pause are the cycle's first, untouched.
    const kept = one?.current?.matches ?? [];
    const cycle = (await supervisor.store.matches('one', true)).filter((m) => m.cycle === 1);
    expect(cycle.slice(0, kept.length)).toEqual(kept);
    expect(cycle.length).toBe(after?.cycles[0]?.matches);
  });
});

describe('a run paused while it waits for a worker', async () => {
  const { supervisor, events } = box.supervise('waiting.db', { workers: 1 });
  await supervisor.create({ id: 'busy', name: 'busy', settings });
  await supervisor.create({ id: 'waits', name: 'waits', settings: { ...settings, seed: '9' } });
  await supervisor.start('busy');
  await supervisor.start('waits');
  const queued = supervisor.load.queued;
  await supervisor.pause('waits');
  const after = supervisor.load.queued;
  await within(next(supervisor, is('matchSaved', 'busy')), 'matchSaved for busy');
  await supervisor.pause('busy');
  await within(supervisor.idle('busy'), 'run busy going idle');

  it('leaves the queue, and does not take the worker when it is free', async () => {
    expect([queued, after]).toEqual([1, 0]);
    expect(events.filter(is('runStarted')).map((event) => event.runId)).toEqual(['busy']);
    expect(await supervisor.store.status('waits')).toBe('paused');
  });
});

describe('a ban asked for while a run is on a worker', async () => {
  const { supervisor, events } = box.supervise('bans.db');
  const created = await supervisor.create({ id: 'run-1', name: 'test', settings });
  const target = [...cardsIn(created.lineage[0]?.deck ?? { main: [], side: [] }).keys()].find(
    (oracleId) =>
      !pool.some((card) => card.oracleId === oracleId && card.typeLine.includes('Basic')),
  ) as OracleId;
  await supervisor.start('run-1');
  const first = await within(next(supervisor, is('matchSaved', 'run-1')), 'matchSaved for run-1');
  await supervisor.requestBan('run-1', {
    oracleId: target,
    action: 'ban',
    by: 'operator',
    at: now(),
  });
  await within(next(supervisor, is('cycleFinished', 'run-1')), 'cycleFinished for run-1');
  await supervisor.pause('run-1');
  await within(supervisor.idle('run-1'), 'run run-1 going idle');
  const after = await supervisor.store.load('run-1');
  const matches = await supervisor.store.matches('run-1', false);

  it('goes to the worker, and takes effect after a game of the cycle in progress', () => {
    const [event] = after?.bans ?? [];
    expect(event?.oracleId).toBe(target);
    const laterGames = matches
      .filter((stored) => stored.cycle === 1 && stored.index > first.match.index)
      .flatMap((stored) => stored.match.games.map((game) => game.seed));
    expect(laterGames).toContain(event?.appliedAfterGameId);
  });

  it('legalises both decks there and then, as generations the API process is told of', () => {
    const list = banListOf(after?.bans ?? []);
    const latest = latestGenerations(after?.lineage ?? []);
    for (const agent of ['A', 'B'] as const)
      expect(banViolations(latest[agent].deck, list)).toEqual([]);
    const forced = events
      .filter(is('deckChanged'))
      .flatMap((event) => event.generations)
      .filter((entry) => entry.cause === 'ban');
    expect(forced.length).toBeGreaterThan(0);
  });

  it('is kept as pending when the run is on no worker, and takes effect when it plays on', async () => {
    await supervisor.requestBan('run-1', {
      oracleId: target,
      action: 'unban',
      by: 'operator',
      at: now(),
    });
    const pending = (await supervisor.store.load('run-1'))?.bans.at(-1);
    expect(pending?.appliedAfterGameId).toBeNull();
    await supervisor.start('run-1', { cycles: 1 });
    await within(supervisor.idle('run-1'), 'run run-1 going idle');
    expect((await supervisor.store.load('run-1'))?.bans.at(-1)?.appliedAfterGameId).not.toBeNull();
  });

  it('is not lost when asked for as the run halts', async () => {
    const halting = supervisor.on((event) => {
      if (event.type !== 'matchSaved') return;
      halting();
      void supervisor.requestBan('run-1', {
        oracleId: target,
        action: 'restrict',
        by: 'operator',
        at: now(),
      });
      void supervisor.pause('run-1');
    });
    await supervisor.start('run-1');
    await within(supervisor.idle('run-1'), 'run run-1 going idle');
    const bans = (await supervisor.store.load('run-1'))?.bans ?? [];
    expect(bans.at(-1)).toMatchObject({ action: 'restrict', oracleId: target });
  });
});

describe('the scripting worker', async () => {
  const { supervisor } = box.supervise('scripts.db');
  const resolver = inProcessResolver();
  const sample = [...pool.slice(0, 20), ...pool.slice(-40)];
  const answers = await Promise.all(sample.map((card) => supervisor.resolveCard(card)));

  it('scripts a card exactly as the resolver does in-process', () => {
    for (const [i, card] of sample.entries()) {
      const local = resolver.resolve(card);
      expect([card.name, answers[i]?.status, answers[i]?.definition]).toEqual([
        card.name,
        local.status,
        local.definition,
      ]);
    }
    expect(answers.some((answer) => answer.definition !== null)).toBe(true);
    expect(answers.some((answer) => answer.definition === null)).toBe(true);
  });

  it('has its verdicts and its unsupported requests written by the API process', () => {
    for (const card of sample) expect(supervisor.scripts.get(card.oracleId)).not.toBeNull();
    const unsupported = answers.filter((answer) => answer.definition === null).length;
    expect(supervisor.scripts.unsupportedRequests()).toHaveLength(unsupported);
  });

  it('answers a card it has seen from its cache', async () => {
    const card = sample.find((_, i) => answers[i]?.status === 'supported');
    if (card === undefined) throw new Error('no supported card');
    expect((await supervisor.resolveCard(card)).source).toBe('cache');
  });
});

describe('what a worker may write', () => {
  it('the scripting worker’s connection cannot write, whatever it tries', () => {
    const { database } = box.supervise('readonly.db');
    const readonly = openReadonly(database.sqlite.name);
    expect(() => readonly.sqlite.prepare("INSERT INTO runs (id) VALUES ('x')").run()).toThrow(
      /readonly/,
    );
    readonly.close();
  });

  it('a simulation worker holds no database at all', () => {
    const source = readFileSync(fileURLToPath(new URL('./sim-worker.ts', import.meta.url)), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    expect(imports.filter((specifier) => specifier?.includes('db'))).toEqual([]);
    const scripting = readFileSync(
      fileURLToPath(new URL('./script-worker.ts', import.meta.url)),
      'utf8',
    );
    expect(scripting).toContain('openReadonly(');
    expect(scripting).not.toMatch(/openDatabase|RunStore/);
  });
});

describe('a worker that fails', async () => {
  const expected = await reference;
  const { supervisor, events } = box.supervise('failing.db', { cardsPath: '/nowhere/cards.jsonl' });

  it('fails the run it was making, and says why', async () => {
    await expect(supervisor.create({ id: 'x', name: 'x', settings })).rejects.toThrow(/ENOENT/);
  });

  it('pauses the run it was driving, so a restart does not fail it again', async () => {
    await supervisor.store.create({
      ...expected,
      run: { ...expected.run, status: 'running' },
      cycles: [],
      lineage: expected.lineage.filter((entry) => entry.cycle === 0),
      current: null,
    });
    await supervisor.start('run-1');
    await within(supervisor.idle('run-1'), 'run run-1 going idle');
    expect(await supervisor.store.status('run-1')).toBe('paused');
    expect(events.filter(is('runFailed'))[0]?.message).toMatch(/ENOENT/);
    // The next job still finds a worker.
    await expect(supervisor.create({ id: 'y', name: 'y', settings })).rejects.toThrow(/ENOENT/);
  });
});

describe('a scripting worker that stops', async () => {
  // A hand script that does not parse stops the worker as it loads them.
  const scripts = join(box.directory, 'broken-scripts');
  mkdirSync(scripts);
  writeFileSync(join(scripts, 'broken.yaml'), 'oracleId: [unclosed\n');
  const { supervisor } = box.supervise('scripting-stopped.db', { handScriptsDir: scripts });
  const [card] = pool;
  if (card === undefined) throw new Error('no fixture cards');

  it('fails what was waiting on it, and all that asks after, at once rather than timing out', async () => {
    const first = await within(
      supervisor.resolveCard(card).then(
        () => null,
        (error: Error) => error,
      ),
      'the first script request failing',
      10_000,
    );
    expect(first?.message).toMatch(/scripting worker has stopped/);
    await expect(within(supervisor.resolveCard(card), 'a later request', 1_000)).rejects.toThrow(
      /scripting worker has stopped/,
    );
    await expect(within(supervisor.roll(settings), 'a roll', 1_000)).rejects.toMatchObject({
      name: 'ScriptingStoppedError',
    });
    await expect(
      within(supervisor.create({ id: 'z', name: 'z', settings }), 'a run being made', 1_000),
    ).rejects.toThrow(/scripting worker has stopped/);
  });

  it('is refused at boot when its scripts are not there, rather than dying unseen', () => {
    expect(() =>
      box.supervise('no-scripts.db', { handScriptsDir: join(box.directory, 'absent') }),
    ).toThrow(/no card scripts at .*absent \(CARD_SCRIPTS_DIR\)/);
  });
});
