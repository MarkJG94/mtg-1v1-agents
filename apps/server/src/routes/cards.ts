import { cardSearchQuerySchema, resolveCardsRequestSchema } from '@mtg/shared';
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

  // Names a person typed — a pasted decklist, a ban list — as the catalogue's cards, each
  // scripted so its support is known rather than guessed (docs/08 "New run").
  app.post('/api/cards/resolve', async (request) => {
    const { names, script } = resolveCardsRequestSchema.parse(request.body);
    const cards = [];
    for (const query of names) {
      const found = queries.findByName(query);
      if (found === null) {
        cards.push({ query, oracleId: null, name: null, support: null });
        continue;
      }
      const projection = script ? queries.projection(found.oracleId) : null;
      const support =
        projection === null
          ? (queries.card(found.oracleId)?.support ?? null)
          : (await supervisor.resolveCard(projection)).status;
      cards.push({ query, oracleId: found.oracleId, name: found.name, support });
    }
    return { cards };
  });
};
