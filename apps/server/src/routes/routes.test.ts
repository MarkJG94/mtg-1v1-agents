import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  apiErrorSchema,
  asOracleId,
  banStateSchema,
  cardDetailSchema,
  cardSearchSchema,
  coverageSchema,
  cycleDetailSchema,
  cyclePageSchema,
  gameDetailSchema,
  gameLogSchema,
  healthSchema,
  lineageSchema,
  matchDetailSchema,
  runBundleSchema,
  runDetailSchema,
  runListSchema,
  runSummarySchema,
  scriptResultSchema,
  statsTableSchema,
} from '@mtg/shared';
import { createRun, driveRun } from '@mtg/sim';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { loadCatalogue } from '../db/catalogue.js';
import { Queries } from '../db/queries.js';
import { Hub } from '../hub.js';
import { ImageCache } from '../images.js';
import { services } from '../services.js';
import { inProcessResolver, now, pool, sandbox, settings, within } from '../workers/testing.js';

/**
 * The API's contract (docs/07; roadmap 6.1): a real run made, played and read through the
 * routes, every response held to its `@mtg/shared` schema — the schema the web app reads
 * with — and every error in docs/07's shape with the status it names. The routes run over
 * a real supervisor, workers and database; nothing here is mocked.
 */

const box = sandbox();
// `mtg.db` in the sandbox, where the config puts the database, so health can measure it.
const { database, supervisor } = box.supervise('mtg.db');
const catalogue = loadCatalogue(database, box.cardsPath);
const queries = new Queries(database, supervisor.store);
/** Scryfall, as the tests see it: a JPEG's first bytes, and a count of what was asked. */
const scryfall: string[] = [];
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const images = new ImageCache({
  directory: `${box.directory}/images`,
  mode: 'lazy',
  spacingMs: 1,
  fetcher: async (url) => {
    scryfall.push(url);
    if (url.includes('00000000-0000-0000-0000-000000000000')) {
      return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength),
    };
  },
});
const app: FastifyInstance = await buildApp(
  loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', SIM_WORKERS: '2', DATA_DIR: box.directory }),
  services({
    supervisor,
    queries,
    hub: new Hub(supervisor, queries, { version: 'test' }),
    images,
    cardsPath: box.cardsPath,
    now,
  }),
);
afterAll(async () => {
  await app.close();
  await box.dispose();
});

/** Sends a request and parses the answer with the schema the API promises for it. */
const call = async <S extends z.ZodType>(
  schema: S,
  options: InjectOptions,
  status = 200,
): Promise<z.infer<S>> => {
  const response = await app.inject(options);
  expect({ status: response.statusCode, body: response.json() }).toMatchObject({ status });
  return schema.parse(response.json());
};
const failure = (options: InjectOptions, status: number) => call(apiErrorSchema, options, status);

const request = { ...settings };
const created = await call(
  runSummarySchema,
  { method: 'POST', url: '/api/runs', payload: { name: 'contract', settings: request } },
  201,
);
const run = `/api/runs/${created.id}`;
await call(runSummarySchema, { method: 'POST', url: `${run}/start`, payload: { cycles: 2 } });
await within(supervisor.idle(created.id), 'the run playing its two cycles');

describe('the card catalogue', () => {
  it('holds every card of the Scryfall data, loaded once per version', () => {
    expect(catalogue).toMatchObject({
      loaded: true,
      cards: new Set(pool.map((c) => c.oracleId)).size,
    });
    expect(loadCatalogue(database, box.cardsPath).loaded).toBe(false);
  });
});

describe('runs', () => {
  it('makes a run with the settings asked for, and lists it', async () => {
    expect(created).toMatchObject({ name: 'contract', seed: settings.seed, status: 'created' });
    const { runs } = await call(runListSchema, { method: 'GET', url: '/api/runs' });
    expect(runs.map((each) => each.id)).toContain(created.id);
  });

  it('draws a seed when the request names none', async () => {
    const { seed: _, ...unseeded } = request;
    const made = await call(
      runSummarySchema,
      { method: 'POST', url: '/api/runs', payload: { name: 'unseeded', settings: unseeded } },
      201,
    );
    expect(made.seed).toMatch(/^\d+$/);
    const again = await call(
      runSummarySchema,
      { method: 'POST', url: '/api/runs', payload: { name: 'unseeded', settings: unseeded } },
      201,
    );
    expect(again.seed).not.toBe(made.seed);
  });

  it('shows a run with its settings, decks, bans and last cycle', async () => {
    const detail = await call(runDetailSchema, { method: 'GET', url: run });
    expect(detail).toMatchObject({ status: 'paused', cycles: 2, currentCycle: null });
    expect(detail.lastCycle?.number).toBe(2);
    const lineage = supervisor.store.lineage(created.id);
    const newest = (agent: 'A' | 'B') =>
      lineage.filter((entry) => entry.agent === agent).at(-1)?.generation;
    expect([detail.decks.A.generation, detail.decks.B.generation]).toEqual([
      newest('A'),
      newest('B'),
    ]);
  });

  it('pages through its cycles', async () => {
    const page = await call(cyclePageSchema, { method: 'GET', url: `${run}/cycles` });
    expect(page.total).toBe(2);
    expect(page.cycles.map((cycle) => cycle.number)).toEqual([1, 2]);
    const second = await call(cyclePageSchema, {
      method: 'GET',
      url: `${run}/cycles?offset=1&limit=1`,
    });
    expect(second.cycles.map((cycle) => cycle.number)).toEqual([2]);
    for (const cycle of page.cycles) {
      // Every cycle either changed the loser's deck, or says why it did not.
      expect(cycle.change === null).toBe(cycle.unchanged !== null);
      if (cycle.change !== null) expect(cycle.change.agent).toBe(cycle.loser);
    }
  });

  it('shows one cycle with its decks, change, statistics and matches', async () => {
    const cycle = await call(cycleDetailSchema, { method: 'GET', url: `${run}/cycles/1` });
    expect(cycle.status).toBe('finished');
    expect(cycle.decks.A.generation).toBe(0);
    expect(cycle.matchList).toHaveLength(cycle.matches);
    expect(cycle.deckStats.A.games).toBeGreaterThan(0);
    if (cycle.changed !== null) expect(cycle.changed.change?.reason).toBe(cycle.change?.reason);
  });

  it('gives each agent’s lineage, generation by generation', async () => {
    const lineage = await call(lineageSchema, { method: 'GET', url: `${run}/decks/B` });
    expect(lineage.generations.map((entry) => entry.generation)).toEqual(
      lineage.generations.map((_, i) => i),
    );
    expect(lineage.generations.every((entry) => entry.agent === 'B')).toBe(true);
  });

  it('tables each card’s statistics, one cycle or all rolled up, with names', async () => {
    const one = await call(statsTableSchema, {
      method: 'GET',
      url: `${run}/stats?agent=A&cycle=1`,
    });
    const all = await call(statsTableSchema, { method: 'GET', url: `${run}/stats?agent=A` });
    expect([one.cycle, all.cycle]).toEqual([1, null]);
    expect(one.cards.length).toBeGreaterThan(0);
    expect(one.cards.every((card) => card.name !== null)).toBe(true);
    // Worst first, by the Δ the deck agent reads, then by oracle id. Read off the rolled-up
    // table: in one short cycle a deck that lost every game has Δ 0 for every card, and any
    // order is sorted.
    expect(new Set(all.cards.map((card) => card.delta)).size).toBeGreaterThan(2);
    const order = (cards: typeof all.cards) => cards.map((card) => card.oracleId);
    const ranked = [...all.cards].sort(
      (a, b) => a.delta - b.delta || a.oracleId.localeCompare(b.oracleId),
    );
    expect(order(all.cards)).toEqual(order(ranked));
  });
});

describe('a cycle that changed nothing', async () => {
  // Played in-process on the same store, with a pool that scripts only what the decks
  // hold, so the deck agent can find nothing to change with (ADR 0017).
  const { store } = supervisor;
  const resolver = inProcessResolver();
  const cards = { pool, resolver };
  const made = await createRun({ store, cards, id: 'narrow', name: 'narrow', settings, now });
  const held = new Set(made.lineage.flatMap((entry) => entry.deck.main.map((s) => s.oracleId)));
  for (const entry of made.lineage) for (const slot of entry.deck.side) held.add(slot.oracleId);
  await driveRun({
    store,
    cards: {
      pool,
      resolver: {
        resolve: (card, request) =>
          held.has(asOracleId(card.oracleId))
            ? resolver.resolve(card, request)
            : { status: 'unscripted', definition: null, source: 'none', reasons: [] },
      },
    },
    runId: 'narrow',
    cycles: 1,
  });

  it('says why in the cycle list and the cycle, and names no change', async () => {
    const page = await call(cyclePageSchema, { method: 'GET', url: '/api/runs/narrow/cycles' });
    expect(page.cycles[0]).toMatchObject({ change: null });
    expect(page.cycles[0]?.unchanged).toMatch(/nothing the engine can play/);
    const cycle = await call(cycleDetailSchema, {
      method: 'GET',
      url: '/api/runs/narrow/cycles/1',
    });
    expect(cycle.changed).toBeNull();
    expect(cycle.unchanged).toBe(page.cycles[0]?.unchanged);
  });
});

describe('matches and games', async () => {
  const cycle = await call(cycleDetailSchema, { method: 'GET', url: `${run}/cycles/1` });
  const first = cycle.matchList[0];
  if (first === undefined) throw new Error('no match');
  const match = await call(matchDetailSchema, {
    method: 'GET',
    url: `/api/matches/${encodeURIComponent(first.id)}`,
  });
  const game = match.games[0];
  if (game === undefined) throw new Error('no game');

  it('shows a match with its games', () => {
    expect(match).toMatchObject({ runId: created.id, cycle: 1, number: first.number });
    expect(match.games).toHaveLength(first.games);
  });

  it('shows a game, and decodes its event log', async () => {
    const detail = await call(gameDetailSchema, {
      method: 'GET',
      url: `/api/games/${encodeURIComponent(game.id)}`,
    });
    expect(detail).toMatchObject({ matchId: match.id, runId: created.id, seed: game.seed });
    const log = await call(gameLogSchema, {
      method: 'GET',
      url: `/api/games/${encodeURIComponent(game.id)}/log`,
    });
    expect(log.seed).toBe(game.seed);
    expect(log.events.length).toBeGreaterThan(0);
  });
});

describe('bans', async () => {
  const detail = await call(runDetailSchema, { method: 'GET', url: run });
  const target = detail.decks.A.deck.main.find(
    (slot) => !pool.some((card) => card.oracleId === slot.oracleId && /Basic/.test(card.typeLine)),
  )?.oracleId;
  if (target === undefined) throw new Error('no card to ban');
  const url = `${run}/bans/${target}`;

  it('takes a ban on a run that is not playing as pending, for its next cycle', async () => {
    const state = await call(
      banStateSchema,
      { method: 'PUT', url, payload: { status: 'restricted', note: 'too strong' } },
      202,
    );
    expect(state.playing).toBe(false);
    expect(state.history.at(-1)).toMatchObject({
      oracleId: target,
      action: 'restrict',
      note: 'too strong',
      by: 'operator',
      appliedAfterGameId: null,
    });
    // Pending, so not yet on the list.
    expect(state.list).toEqual([]);
  });

  it('takes an unban the same way, and lists the trail', async () => {
    await call(banStateSchema, { method: 'DELETE', url }, 202);
    const state = await call(banStateSchema, { method: 'GET', url: `${run}/bans` });
    expect(state.history.map((event) => event.action)).toEqual(['restrict', 'unban']);
  });

  it('refuses a card the catalogue does not know', async () => {
    await failure(
      { method: 'PUT', url: `${run}/bans/no-such-card`, payload: { status: 'banned' } },
      404,
    );
  });
});

describe('fork, export and import', () => {
  it('forks a run at a finished cycle', async () => {
    const fork = await call(
      runSummarySchema,
      { method: 'POST', url: `${run}/fork`, payload: { cycle: 1 } },
      201,
    );
    expect(fork.forkedFrom).toEqual({ run: created.id, cycle: 1 });
    expect(fork).toMatchObject({ cycles: 1, status: 'created' });
    await failure({ method: 'POST', url: `${run}/fork`, payload: { cycle: 9 } }, 409);
  });

  it('exports a bundle with named decklists that imports as the same run', async () => {
    const response = await app.inject({ method: 'GET', url: `${run}/export?logs=true` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toBe('attachment; filename="contract.json"');
    const bundle = runBundleSchema.parse(response.json());
    const named = pool.find((card) => bundle.decklists['A-0']?.includes(card.name));
    expect(named).toBeDefined();
    const imported = await call(
      runSummarySchema,
      { method: 'POST', url: '/api/runs/import', payload: response.json() },
      201,
    );
    expect(imported).toMatchObject({ status: 'paused', cycles: 2, name: 'contract' });
    const page = await call(cyclePageSchema, {
      method: 'GET',
      url: `/api/runs/${imported.id}/cycles`,
    });
    const original = await call(cyclePageSchema, { method: 'GET', url: `${run}/cycles` });
    expect(page.cycles).toEqual(original.cycles);
  });
});

describe('cards and coverage', async () => {
  const detail = await call(runDetailSchema, { method: 'GET', url: run });
  const played = detail.decks.A.deck.main[0]?.oracleId ?? '';
  const card = pool.find((each) => each.oracleId === played);
  if (card === undefined) throw new Error('no card');

  it('finds a card by name, with its support status, the exact name first', async () => {
    // A name that holds the query and sorts before it, as a split card's does.
    database.sqlite
      .prepare(
        `INSERT INTO cards (oracle_id, name, mana_value, colors, color_identity, type_line,
           oracle_text, keywords, layout, legal_base, projection)
         VALUES ('decoy', ?, 0, '[]', '[]', 'Instant', '', '[]', 'split', 1, '{}')`,
      )
      .run(`Aaa // ${card.name}`);
    const { cards } = await call(cardSearchSchema, {
      method: 'GET',
      url: `/api/cards?q=${encodeURIComponent(card.name)}`,
    });
    database.sqlite.prepare("DELETE FROM cards WHERE oracle_id = 'decoy'").run();
    expect(cards.map((each) => each.oracleId)).toContain('decoy');
    expect(cards[0]).toMatchObject({
      oracleId: card.oracleId,
      name: card.name,
      support: 'supported',
    });
  });

  it('shows a card with its script and its record across runs', async () => {
    const shown = await call(cardDetailSchema, { method: 'GET', url: `/api/cards/${played}` });
    expect(shown.script?.status).toBe('supported');
    expect(shown.stats.games).toBeGreaterThan(0);
    expect(shown.stats.runs).toBeGreaterThanOrEqual(1);
  });

  it('scripts a card afresh on request', async () => {
    const before = supervisor.scripts.get(played)?.updatedAt;
    const result = await call(scriptResultSchema, {
      method: 'POST',
      url: `/api/cards/${played}/script`,
    });
    expect(result).toMatchObject({ oracleId: played, status: 'supported' });
    // Afresh, not from the cache.
    expect(result.source).not.toBe('cache');
    expect(before).toBeDefined();
  });

  it('summarises coverage with the most-requested unsupported cards', async () => {
    const coverage = await call(coverageSchema, { method: 'GET', url: '/api/coverage' });
    expect(coverage.cards).toBe(catalogue.cards);
    expect(coverage.scripted.supported).toBeGreaterThan(0);
    const counts = coverage.mostRequested.map((row) => row.requests);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });
});

describe('card images', async () => {
  const detail = await call(runDetailSchema, { method: 'GET', url: run });
  const played = detail.decks.A.deck.main[0]?.oracleId ?? '';
  const printing = pool.find((card) => card.oracleId === played)?.id;

  it('fetches a card’s image from Scryfall once, by its printing, then serves it from disk', async () => {
    const first = await app.inject({ method: 'GET', url: `/img/${played}` });
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toBe('image/jpeg');
    expect(first.headers['x-image-cache']).toBe('miss');
    expect(first.rawPayload.equals(jpeg)).toBe(true);
    expect(scryfall).toEqual([
      `https://api.scryfall.com/cards/${printing}?format=image&version=normal`,
    ]);
    const again = await app.inject({ method: 'GET', url: `/img/${played}` });
    expect(again.headers['x-image-cache']).toBe('hit');
    expect(again.rawPayload.equals(jpeg)).toBe(true);
    expect(scryfall).toHaveLength(1);
  });

  it('keeps each size apart', async () => {
    const small = await app.inject({ method: 'GET', url: `/img/${played}?size=small` });
    expect(small.headers['x-image-cache']).toBe('miss');
    expect(scryfall.at(-1)).toContain('version=small');
  });

  it('answers a card it does not know with 404, and a size it does not have with 400', async () => {
    await failure({ method: 'GET', url: '/img/no-such-card' }, 404);
    await failure({ method: 'GET', url: `/img/${played}?size=huge` }, 400);
  });
});

describe('errors (docs/07)', () => {
  it('answers a body that does not match with 400 and the issues', async () => {
    const error = await failure(
      { method: 'POST', url: '/api/runs', payload: { settings: {} } },
      400,
    );
    expect(error.error.code).toBe('invalid_request');
    expect(Array.isArray(error.error.details)).toBe(true);
    await failure({ method: 'GET', url: `${run}/stats` }, 400);
    await failure({ method: 'GET', url: `${run}/decks/C` }, 400);
  });

  it('answers a pasted deck that is not sixty and fifteen with 400', async () => {
    const error = await failure(
      {
        method: 'POST',
        url: '/api/runs',
        payload: {
          name: 'short',
          settings: request,
          seedDeck: { main: [{ oracleId: pool[0]?.oracleId, count: 4 }], side: [] },
        },
      },
      400,
    );
    expect(error.error.code).toBe('invalid_seed_deck');
  });

  it('answers what does not exist with 404', async () => {
    await failure({ method: 'GET', url: '/api/runs/nope' }, 404);
    await failure({ method: 'POST', url: '/api/runs/nope/start' }, 404);
    await failure({ method: 'GET', url: `${run}/cycles/99` }, 404);
    await failure({ method: 'GET', url: '/api/matches/nope' }, 404);
    await failure({ method: 'GET', url: '/api/games/nope/log' }, 404);
    await failure({ method: 'GET', url: '/api/cards/nope' }, 404);
    await failure({ method: 'GET', url: '/api/nowhere' }, 404);
  });

  it('answers what cannot be done now with 409', async () => {
    const made = await call(
      runSummarySchema,
      { method: 'POST', url: '/api/runs', payload: { name: 'stopped', settings: request } },
      201,
    );
    await call(runSummarySchema, { method: 'POST', url: `/api/runs/${made.id}/stop` });
    await failure({ method: 'POST', url: `/api/runs/${made.id}/start` }, 409);
  });
});

describe('the routes docs/07 lists', () => {
  it('are all served, and health reports the pool', async () => {
    const table = readFileSync(
      fileURLToPath(new URL('../../../../docs/07-api.md', import.meta.url)),
      'utf8',
    );
    const routes = [...table.matchAll(/^\| (GET|POST|PUT|DELETE) \| `([^`]+)`(.*?)\|/gm)].flatMap(
      ([, method, path, rest]) => {
        // "`/api/runs/:id/start` · `/pause` · `/stop`" is three routes.
        const extra = [...(rest ?? '').matchAll(/`\/(\w+)`/g)].map(
          ([, last]) => `${(path ?? '').replace(/\/\w+$/, '')}/${last}`,
        );
        // A path written with its query (`/export?logs=true`) is the path.
        return [path ?? '', ...extra].map((url) => ({
          method: method ?? '',
          url: url.replace(/\?.*$/, ''),
        }));
      },
    );
    const served = routes;
    expect(served.length).toBeGreaterThan(20);
    const missing = served.filter(
      (route) => !app.hasRoute({ method: route.method as 'GET', url: route.url }),
    );
    expect(missing).toEqual([]);
    const health = await call(healthSchema, { method: 'GET', url: '/api/health' });
    expect(health).toMatchObject({
      runsPlaying: 0,
      runsWaiting: 0,
      simWorkers: 2,
      scryfallVersion: catalogue.version,
    });
    expect(health.databaseBytes).toBeGreaterThan(0);
  });
});
