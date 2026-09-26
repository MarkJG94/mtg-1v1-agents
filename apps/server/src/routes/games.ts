import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../services.js';
import { notFound } from './errors.js';

/** docs/07's match and game routes: a match with its games, a game, a game's event log. */

const idParams = z.object({ id: z.string().min(1) });

export const gameRoutes = async (app: FastifyInstance, services: Services): Promise<void> => {
  const { queries } = services;

  app.get('/api/matches/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const match = queries.match(id);
    if (match === null) throw notFound(`match ${id}`);
    return match;
  });

  app.get('/api/games/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const game = queries.game(id);
    if (game === null) throw notFound(`game ${id}`);
    return game;
  });

  app.get('/api/games/:id/log', async (request) => {
    const { id } = idParams.parse(request.params);
    const log = queries.gameLog(id);
    if (log === null) throw notFound(`the event log of game ${id}`);
    return log;
  });
};
