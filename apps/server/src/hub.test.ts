import {
  asOracleId,
  type GameEvent,
  type WsServerMessage,
  wsServerMessageSchema,
} from '@mtg/shared';
import type { StoredMatch } from '@mtg/sim';
import { afterAll, describe, expect, it } from 'vitest';
import { loadCatalogue } from './db/catalogue.js';
import { Queries } from './db/queries.js';
import { Hub, type HubSocket, type HubSupervisor } from './hub.js';
import type { SupervisorEvent } from './workers/supervisor.js';
import { now, pool, sandbox, settings, within } from './workers/testing.js';

/**
 * The WebSocket hub (docs/07 "WebSocket `/ws`"; roadmap 6.2). First on real workers: a
 * viewer subscribed to a run and its live game is sent every game's start, every event
 * the game's log holds, its end, and the run's status, cycle and deck changes as they are
 * saved. Then, with the test playing the supervisor, the rules that timing would make
 * flaky on real threads: joining mid-game, falling behind, the pace and who is told what.
 */

/** A socket that keeps what it is sent, parsed by the schema docs/07's client reads with. */
class FakeSocket implements HubSocket {
  readonly received: WsServerMessage[] = [];
  bufferedAmount = 0;
  private readonly listeners: { message: ((data: unknown) => void)[]; close: (() => void)[] } = {
    message: [],
    close: [],
  };

  send(data: string): void {
    this.received.push(wsServerMessageSchema.parse(JSON.parse(data)));
  }

  on(event: 'message' | 'close', listener: (data: unknown) => void): void {
    (this.listeners[event] as ((data: unknown) => void)[]).push(listener);
  }

  say(message: unknown): void {
    for (const listener of this.listeners.message) listener(JSON.stringify(message));
  }

  close(): void {
    for (const listener of this.listeners.close) listener();
  }

  of<T extends WsServerMessage['type']>(type: T): Extract<WsServerMessage, { type: T }>[] {
    return this.received.filter(
      (message): message is Extract<WsServerMessage, { type: T }> => message.type === type,
    );
  }
}

const box = sandbox();
afterAll(() => box.dispose());

describe('a viewer of a run played on real workers', async () => {
  const { database, supervisor, events } = box.supervise('hub.db');
  loadCatalogue(database, box.cardsPath);
  const queries = new Queries(database, supervisor.store);
  const hub = new Hub(supervisor, queries, { version: 'test' });
  const created = await supervisor.create({ id: 'watched', name: 'watched', settings });
  await supervisor.create({ id: 'unwatched', name: 'unwatched', settings });

  const viewer = new FakeSocket();
  const bystander = new FakeSocket();
  hub.connect(viewer);
  hub.connect(bystander);
  viewer.say({ subscribe: 'run', runId: 'watched' });
  viewer.say({ subscribe: 'game', runId: 'watched' });
  bystander.say({ subscribe: 'runs' });

  // A ban asked for as the first match is saved takes effect after a later game.
  const target = created.lineage[0]?.deck.main.find(
    (slot) => !pool.some((card) => card.oracleId === slot.oracleId && /Basic/.test(card.typeLine)),
  )?.oracleId;
  const banning = supervisor.on((event) => {
    if (event.type !== 'matchSaved' || event.runId !== 'watched') return;
    banning();
    void supervisor.requestBan('watched', {
      oracleId: asOracleId(target ?? ''),
      action: 'ban',
      by: 'operator',
      at: now(),
    });
  });
  await supervisor.start('watched', { cycles: 1 });
  await supervisor.start('unwatched', { cycles: 1 });
  await within(supervisor.idle('watched'), 'the watched run');
  await within(supervisor.idle('unwatched'), 'the unwatched run');
  const stored: StoredMatch[] = await supervisor.store.matches('watched', true);
  hub.close();

  it('greets each client', () => {
    expect(viewer.received[0]).toEqual({ type: 'hello', version: 'test' });
  });

  it('streams every game of the run it watches: start, the log’s events, end', () => {
    const games = stored.flatMap((match) => match.match.games);
    const logs = stored.flatMap((match) => match.logs);
    expect(viewer.of('gameStart').map((start) => start.seed)).toEqual(games.map((g) => g.seed));
    expect(viewer.of('gameStart')[0]).toMatchObject({
      runId: 'watched',
      cycle: 1,
      match: 0,
      game: 1,
      catchUp: false,
    });
    const streamed = viewer.of('gameEvents').flatMap((batch) => batch.events);
    expect(streamed).toEqual(logs.flatMap((log) => log.events));
    expect(viewer.of('gameEnd').map((end) => [end.seed, end.winner])).toEqual(
      games.map((game) => [game.seed, game.result?.winner ?? null]),
    );
  });

  it('does not stream a run nobody is watching', () => {
    const streamed = events.filter(
      (event) => event.type === 'gameStart' && event.runId === 'unwatched',
    );
    expect(streamed).toEqual([]);
    expect(bystander.of('gameStart')).toEqual([]);
  });

  it('tells the run’s viewer of its status, its cycle and its deck changes', () => {
    const statuses = viewer.of('runStatus').filter((status) => status.runId === 'watched');
    expect(statuses.length).toBeGreaterThan(stored.length);
    expect(statuses.at(-1)).toMatchObject({ status: 'paused', playing: false, cycle: 1 });
    const [cycle] = viewer.of('cycleFinished');
    expect(cycle?.cycle.number).toBe(1);
    const changes = viewer.of('deckChanged');
    const lineage = supervisor.store.lineage('watched').filter((entry) => entry.cycle === 1);
    expect(changes.map((change) => [change.agent, change.generation, change.cause])).toEqual(
      lineage.map((entry) => [entry.agent, entry.generation, entry.cause]),
    );
    const change = changes.find((each) => each.cause === 'change');
    if (change !== undefined) {
      expect(change.reason).not.toBeNull();
      expect(change.diff.removed[0]?.count).toBe(change.diff.added[0]?.count);
    }
  });

  it('tells it of a ban as it takes effect, stamped with its game', () => {
    // Once, though the trail is written again with every checkpoint after.
    const [applied, ...more] = viewer.of('banApplied');
    expect(more).toEqual([]);
    expect(applied?.event).toMatchObject({ oracleId: target, action: 'ban' });
    expect(applied?.event.appliedAfterGameId).not.toBeNull();
  });

  it('tells the list’s viewer of every run’s status, and no run’s game', () => {
    const runs = new Set(bystander.of('runStatus').map((status) => status.runId));
    expect(runs).toEqual(new Set(['watched', 'unwatched']));
    expect(bystander.of('cycleFinished')).toEqual([]);
  });
});

describe('the hub’s rules, with the test playing the supervisor', async () => {
  const { database, supervisor: real } = box.supervise('rules.db');
  loadCatalogue(database, box.cardsPath);
  await real.create({ id: 'run', name: 'run', settings });
  const queries = new Queries(database, real.store);

  /** A supervisor whose events the test sends, recording what it is asked to watch. */
  const fake = () => {
    const listeners = new Set<(event: SupervisorEvent) => void>();
    const watched: [string, boolean][] = [];
    const supervisor: HubSupervisor = {
      on: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      watch: (runId, watching) => {
        watched.push([runId, watching]);
      },
      isActive: () => true,
    };
    const send = (event: SupervisorEvent) => {
      for (const listener of listeners) listener(event);
    };
    return { supervisor, send, watched };
  };
  const event = (seq: number): GameEvent =>
    ({ seq, turn: 1, step: 'upkeep', type: 'untap', object: 1 }) as unknown as GameEvent;
  const start = (seed: string): SupervisorEvent => ({
    type: 'gameStart',
    runId: 'run',
    game: {
      seed,
      game: 1,
      chooser: 'A',
      decks: { A: [], B: [] },
      generations: { A: 0, B: 0 },
      cycle: 1,
      match: 0,
    },
  });

  it('catches a viewer who joins mid-game up on the start and every event so far', () => {
    const { supervisor, send } = fake();
    const hub = new Hub(supervisor, queries, { version: 'test' });
    send(start('g1'));
    send({ type: 'gameEvents', runId: 'run', events: [event(0), event(1)] });
    send({ type: 'gameEvents', runId: 'run', events: [event(2)] });
    const late = new FakeSocket();
    hub.connect(late);
    late.say({ subscribe: 'game', runId: 'run' });
    expect(late.of('gameStart')).toMatchObject([{ seed: 'g1', catchUp: true }]);
    expect(late.of('gameEvents').flatMap((batch) => batch.events.map((e) => e.seq))).toEqual([
      0, 1, 2,
    ]);
    send({ type: 'gameEvents', runId: 'run', events: [event(3)] });
    expect(
      late
        .of('gameEvents')
        .at(-1)
        ?.events.map((e) => e.seq),
    ).toEqual([3]);
    hub.close();
  });

  it('skips a viewer that has fallen behind until the next game, and never waits', () => {
    const { supervisor, send } = fake();
    const hub = new Hub(supervisor, queries, { version: 'test', maxBuffered: 100 });
    const slow = new FakeSocket();
    hub.connect(slow);
    slow.say({ subscribe: 'game', runId: 'run' });
    send(start('g1'));
    send({ type: 'gameEvents', runId: 'run', events: [event(0)] });
    slow.bufferedAmount = 1_000;
    send({ type: 'gameEvents', runId: 'run', events: [event(1)] });
    slow.bufferedAmount = 0;
    // Caught up on the socket, but the game it fell behind on stays skipped.
    send({ type: 'gameEvents', runId: 'run', events: [event(2)] });
    expect(slow.of('gameEvents').flatMap((b) => b.events.map((e) => e.seq))).toEqual([0]);
    send({ type: 'gameEnd', runId: 'run', game: { seed: 'g1', onPlay: 'A', result: null } });
    send(start('g2'));
    send({ type: 'gameEvents', runId: 'run', events: [event(10)] });
    expect(slow.of('gameStart').map((s) => s.seed)).toEqual(['g1', 'g2']);
    expect(
      slow
        .of('gameEvents')
        .at(-1)
        ?.events.map((e) => e.seq),
    ).toEqual([10]);
    hub.close();
  });

  it('asks for a run’s games only while someone is watching them', () => {
    const { supervisor, watched } = fake();
    const hub = new Hub(supervisor, queries, { version: 'test' });
    const one = new FakeSocket();
    const two = new FakeSocket();
    hub.connect(one);
    hub.connect(two);
    one.say({ subscribe: 'game', runId: 'run' });
    two.say({ subscribe: 'game', runId: 'run' });
    one.say({ unsubscribe: 'game', runId: 'run' });
    expect(watched.at(-1)).toEqual(['run', true]);
    two.close();
    expect(watched.at(-1)).toEqual(['run', false]);
    expect(hub.connected).toBe(1);
    hub.close();
  });

  it('measures a run’s pace over the last minute, and the time its cycle has left', () => {
    let clock = 0;
    const { supervisor, send } = fake();
    const hub = new Hub(supervisor, queries, { version: 'test', clock: () => clock });
    const viewer = new FakeSocket();
    hub.connect(viewer);
    viewer.say({ subscribe: 'run', runId: 'run' });
    const saved = (games: number): SupervisorEvent => ({
      type: 'matchSaved',
      runId: 'run',
      match: { match: { games: Array.from({ length: games }) } } as unknown as StoredMatch,
    });
    for (const at of [0, 1_000, 2_000]) {
      clock = at;
      send(saved(3));
    }
    const status = viewer.of('runStatus').at(-1);
    // Two matches of three games in the two seconds since the first was saved.
    expect(status?.gamesPerSecond).toBeCloseTo(3);
    // The run was made, not played: nothing planned is left to time.
    expect(status?.etaSeconds).toBe(0);
    // A minute on, the old matches no longer count — asked for with no match saved since.
    clock = 70_000;
    send({ type: 'runStarted', runId: 'run' });
    expect(viewer.of('runStatus').at(-1)?.gamesPerSecond).toBe(0);
    send(saved(3));
    expect(viewer.of('runStatus').at(-1)?.gamesPerSecond).toBe(0);
    hub.close();
  });

  it('tells a list viewer of an unsupported card, by name', () => {
    const { supervisor, send } = fake();
    const hub = new Hub(supervisor, queries, { version: 'test' });
    const viewer = new FakeSocket();
    hub.connect(viewer);
    viewer.say({ subscribe: 'runs' });
    const card = pool[0];
    send({
      type: 'unsupportedCard',
      request: { oracleId: card?.oracleId ?? '', reason: 'no', requestedAt: now() },
    });
    expect(viewer.of('unsupportedCard')).toEqual([
      {
        type: 'unsupportedCard',
        runId: null,
        oracleId: card?.oracleId,
        name: card?.name,
        reason: 'no',
      },
    ]);
    hub.close();
  });

  it('answers a message it cannot read, or a run it does not have, with an error', () => {
    const { supervisor } = fake();
    const hub = new Hub(supervisor, queries, { version: 'test' });
    const viewer = new FakeSocket();
    hub.connect(viewer);
    viewer.say({ subscribe: 'run' });
    viewer.say({ subscribe: 'run', runId: 'nope' });
    viewer.say({ shout: true });
    expect(viewer.of('error')).toHaveLength(3);
    hub.close();
  });
});
