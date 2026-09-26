import { randomUUID } from 'node:crypto';
import {
  asOracleId,
  type BanEvent,
  banListOf,
  banRequestSchema,
  createRunRequestSchema,
  exportQuerySchema,
  forkRunRequestSchema,
  paginationSchema,
  parseRunSettings,
  type RunSummary,
  runBundleSchema,
  seedDeckRequestSchema,
  startRunRequestSchema,
  statsQuerySchema,
  unbanRequestSchema,
  validateSeedDeckColours,
} from '@mtg/shared';
import { exportRun, forkRun, importRun, type RunBundle } from '@mtg/sim';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { dto, type RunRow } from '../db/queries.js';
import type { Services } from '../services.js';
import { HttpError, notFound } from './errors.js';

/**
 * docs/07's run routes (roadmap 6.1): list, create, detail, lifecycle, fork, export and
 * import, cycles, lineage, statistics and bans. Every body and query is parsed with its
 * `@mtg/shared` schema; the contract tests hold every response to its schema.
 */

const idParams = z.object({ id: z.string().min(1) });
const cycleParams = idParams.extend({ n: z.coerce.number().int().min(1) });
const agentParams = idParams.extend({ agent: z.enum(['A', 'B']) });
const banParams = idParams.extend({ oracleId: z.string().min(1) });

/** A 64-bit seed as a decimal string (docs/05), drawn when a request does not name one. */
const randomSeed = (): string => {
  const [high = 0, low = 0] = crypto.getRandomValues(new Uint32Array(2));
  return ((BigInt(high) << 32n) | BigInt(low)).toString();
};

/** A new run's initial list, as edits applied as it is made (`createRun` stamps them). */
const initialBans = (
  bans: readonly { oracleId: string; status: 'banned' | 'restricted'; note: string }[],
  at: string,
): BanEvent[] =>
  bans.map((ban) => ({
    oracleId: asOracleId(ban.oracleId),
    action: ban.status === 'banned' ? 'ban' : 'restrict',
    note: ban.note,
    by: 'operator',
    at,
    appliedAfterGameId: null,
  }));

/** Export bundles carry every match and, if asked, every log: far past Fastify's 1 MB. */
const BUNDLE_LIMIT = 1024 * 1024 * 1024;

export const runRoutes = async (app: FastifyInstance, services: Services): Promise<void> => {
  const { supervisor, queries, now } = services;
  const { store } = supervisor;

  const summary = (row: RunRow): RunSummary => ({
    id: row.id,
    name: row.name,
    status: row.status,
    seed: row.seed,
    agentLevel: row.settings.agentLevel,
    createdAt: row.createdAt,
    forkedFrom: row.forkedFrom,
    cycles: row.cycles,
    currentCycle: row.currentCycle,
    playing: supervisor.isActive(row.id),
    winRates: [...row.winRates],
    lastChange: row.lastChange,
  });
  const runOr404 = (runId: string): RunRow => {
    const row = queries.run(runId);
    if (row === null) throw notFound(`run ${runId}`);
    return row;
  };
  const cardOr404 = (oracleId: string) => {
    if (queries.names([oracleId]).size === 0) throw notFound(`card ${oracleId}`);
  };
  const banState = (runId: string) => {
    const history = queries.bans(runId);
    const list = [...banListOf(history)];
    const names = queries.names(list.map(([oracleId]) => oracleId));
    return {
      list: list.map(([oracleId, status]) => ({
        oracleId,
        name: names.get(oracleId) ?? null,
        status,
      })),
      history,
      playing: supervisor.isActive(runId),
    };
  };

  app.get('/api/runs', async () => ({ runs: queries.runs().map(summary) }));

  // The new-run form's preview: the deck a run with these settings would be made with.
  app.post('/api/seed-decks', async (request) => {
    const body = seedDeckRequestSchema.parse(request.body ?? {});
    const settings = parseRunSettings({
      ...body.settings,
      seed: body.settings.seed ?? randomSeed(),
    });
    const problems = validateSeedDeckColours(settings);
    if (problems.length > 0) {
      throw new HttpError(400, 'invalid_request', problems.join('; '), problems);
    }
    for (const ban of body.bans) cardOr404(ban.oracleId);
    services.requireCards();
    const bans = initialBans(body.bans, now()).map((event) => ({
      ...event,
      appliedAfterGameId: 'preview',
    }));
    const rolled = await supervisor.roll(settings, bans);
    const facts = queries.facts([...rolled.deck.main, ...rolled.deck.side].map((s) => s.oracleId));
    // Every card in a rolled deck is one the engine can play: the rest were re-rolled.
    const card = (slot: { oracleId: string; count: number }) => ({
      oracleId: slot.oracleId,
      count: slot.count,
      name: facts.get(slot.oracleId)?.name ?? slot.oracleId,
      typeLine: facts.get(slot.oracleId)?.typeLine ?? '',
      manaValue: facts.get(slot.oracleId)?.manaValue ?? 0,
      support: 'supported' as const,
    });
    return {
      seed: settings.seed,
      colours: [...rolled.colours],
      lands: rolled.lands,
      nonbasicLands: rolled.nonbasicLands,
      main: rolled.deck.main.map(card),
      side: rolled.deck.side.map(card),
      rerolled: rolled.rerolled.map((each) => ({ ...each })),
    };
  });

  app.post('/api/runs', async (request, reply) => {
    const body = createRunRequestSchema.parse(request.body);
    const settings = parseRunSettings({
      ...body.settings,
      seed: body.settings.seed ?? randomSeed(),
    });
    const problems = validateSeedDeckColours(settings);
    if (problems.length > 0) {
      throw new HttpError(400, 'invalid_request', problems.join('; '), problems);
    }
    services.requireCards();
    const id = randomUUID();
    for (const ban of body.bans) cardOr404(ban.oracleId);
    try {
      await supervisor.create({
        id,
        name: body.name,
        settings,
        ...(body.bans.length === 0 ? {} : { bans: initialBans(body.bans, now()) }),
        ...(body.seedDeck === undefined
          ? {}
          : {
              seedDeck: {
                main: body.seedDeck.main.map((slot) => ({
                  ...slot,
                  oracleId: asOracleId(slot.oracleId),
                })),
                side: body.seedDeck.side.map((slot) => ({
                  ...slot,
                  oracleId: asOracleId(slot.oracleId),
                })),
              },
            }),
      });
    } catch (error) {
      // A pasted 75 that is not sixty and fifteen, or breaks the list, is the caller's.
      if (error instanceof Error && error.name === 'RunError') {
        throw new HttpError(400, 'invalid_seed_deck', error.message);
      }
      throw error;
    }
    return reply.status(201).send(summary(runOr404(id)));
  });

  app.post('/api/runs/import', { bodyLimit: BUNDLE_LIMIT }, async (request, reply) => {
    const bundle = runBundleSchema.parse(request.body) as unknown as RunBundle;
    const id = randomUUID();
    await importRun({ store, bundle, id });
    return reply.status(201).send(summary(runOr404(id)));
  });

  app.get('/api/runs/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const row = runOr404(id);
    const latest = queries.latest(id);
    if (latest === null) throw notFound(`decks of run ${id}`);
    return {
      ...summary(row),
      settings: row.settings,
      bans: banState(id).list,
      decks: { A: dto(latest.A), B: dto(latest.B) },
      lastCycle: queries.lastCycle(id),
    };
  });

  app.post('/api/runs/:id/start', async (request) => {
    const { id } = idParams.parse(request.params);
    const body = startRunRequestSchema.parse(request.body ?? {});
    services.requireCards();
    await supervisor.start(id, body.cycles === undefined ? {} : { cycles: body.cycles });
    return summary(runOr404(id));
  });

  app.post('/api/runs/:id/pause', async (request) => {
    const { id } = idParams.parse(request.params);
    await supervisor.pause(id);
    return summary(runOr404(id));
  });

  app.post('/api/runs/:id/stop', async (request) => {
    const { id } = idParams.parse(request.params);
    await supervisor.stop(id);
    return summary(runOr404(id));
  });

  app.post('/api/runs/:id/fork', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = forkRunRequestSchema.parse(request.body);
    const from = runOr404(id);
    const forked = randomUUID();
    await forkRun({
      store,
      from: id,
      cycle: body.cycle,
      id: forked,
      name: body.name ?? `${from.name} (fork at cycle ${body.cycle})`,
      seed: body.seed ?? randomSeed(),
      now,
    });
    return reply.status(201).send(summary(runOr404(forked)));
  });

  app.get('/api/runs/:id/export', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { logs } = exportQuerySchema.parse(request.query);
    const row = runOr404(id);
    const ids = queries
      .lineage(id)
      .flatMap((entry) => [...entry.deck.main, ...entry.deck.side].map((slot) => slot.oracleId));
    const names = queries.names(ids);
    const bundle = await exportRun({
      store,
      runId: id,
      logs,
      now,
      name: (oracleId) => names.get(oracleId) ?? oracleId,
    });
    const file = row.name.replaceAll(/[^\w.-]+/g, '-').slice(0, 80) || 'run';
    return reply.header('content-disposition', `attachment; filename="${file}.json"`).send(bundle);
  });

  app.get('/api/runs/:id/cycles', async (request) => {
    const { id } = idParams.parse(request.params);
    const { offset, limit } = paginationSchema.parse(request.query);
    runOr404(id);
    return { offset, limit, ...queries.cyclePage(id, offset, limit) };
  });

  app.get('/api/runs/:id/cycles/:n', async (request) => {
    const { id, n } = cycleParams.parse(request.params);
    runOr404(id);
    const detail = queries.cycleDetail(id, n);
    if (detail === null) throw notFound(`cycle ${n} of run ${id}`);
    return detail;
  });

  app.get('/api/runs/:id/decks/:agent', async (request) => {
    const { id, agent } = agentParams.parse(request.params);
    runOr404(id);
    return { agent, generations: queries.lineage(id, agent).map(dto) };
  });

  app.get('/api/runs/:id/stats', async (request) => {
    const { id } = idParams.parse(request.params);
    const { agent, cycle } = statsQuerySchema.parse(request.query);
    runOr404(id);
    const table = queries.stats(id, agent, cycle);
    if (table === null) throw notFound(`cycle ${cycle} of run ${id}`);
    return table;
  });

  app.get('/api/runs/:id/bans', async (request) => {
    const { id } = idParams.parse(request.params);
    runOr404(id);
    return banState(id);
  });

  app.put('/api/runs/:id/bans/:oracleId', async (request, reply) => {
    const { id, oracleId } = banParams.parse(request.params);
    const body = banRequestSchema.parse(request.body ?? {});
    runOr404(id);
    cardOr404(oracleId);
    await supervisor.requestBan(id, {
      oracleId: asOracleId(oracleId),
      action: body.status === 'banned' ? 'ban' : 'restrict',
      note: body.note,
      by: body.by,
      at: now(),
    });
    return reply.status(202).send(banState(id));
  });

  app.delete('/api/runs/:id/bans/:oracleId', async (request, reply) => {
    const { id, oracleId } = banParams.parse(request.params);
    const body = unbanRequestSchema.parse(request.body ?? {});
    runOr404(id);
    cardOr404(oracleId);
    await supervisor.requestBan(id, {
      oracleId: asOracleId(oracleId),
      action: 'unban',
      note: body.note,
      by: body.by,
      at: now(),
    });
    return reply.status(202).send(banState(id));
  });
};
