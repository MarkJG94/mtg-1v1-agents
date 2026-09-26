import { cardSearchQuerySchema } from '@mtg/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../services.js';
import { notFound } from './errors.js';

/**
 * docs/07's card routes: search the Scryfall catalogue, one card with its script and its
 * record across runs, force a card to be scripted afresh, and the coverage summary.
 */

const cardParams = z.object({ oracleId: z.string().min(1) });

export const cardRoutes = async (app: FastifyInstance, services: Services): Promise<void> => {
  const { queries, supervisor } = services;

  app.get('/api/cards', async (request) => {
    const { q, limit } = cardSearchQuerySchema.parse(request.query);
    return { cards: queries.searchCards(q, limit) };
  });

  app.get('/api/cards/:oracleId', async (request) => {
    const { oracleId } = cardParams.parse(request.params);
    const card = queries.card(oracleId);
    if (card === null) throw notFound(`card ${oracleId}`);
    return card;
  });

  app.post('/api/cards/:oracleId/script', async (request) => {
    const { oracleId } = cardParams.parse(request.params);
    const projection = queries.projection(oracleId);
    if (projection === null) throw notFound(`card ${oracleId}`);
    const resolution = await supervisor.resolveCard(projection, { force: true });
    return {
      oracleId,
      status: resolution.status,
      source: resolution.source,
      reasons: resolution.reasons,
    };
  });

  app.get('/api/coverage', async () => queries.coverage());
};
