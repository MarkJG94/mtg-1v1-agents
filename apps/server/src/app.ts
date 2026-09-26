import { existsSync, statSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import type { HealthResponse } from '@mtg/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ServerConfig } from './config.js';
import { cardRoutes } from './routes/cards.js';
import { registerErrors } from './routes/errors.js';
import { gameRoutes } from './routes/games.js';
import { runRoutes } from './routes/runs.js';
import type { Services } from './services.js';

export type { HealthResponse };

/** The database file and its write-ahead log, as they stand on disk. */
const databaseBytes = (path: string): number | null => {
  if (!existsSync(path)) return null;
  const wal = `${path}-wal`;
  return statSync(path).size + (existsSync(wal) ? statSync(wal).size : 0);
};

const packageVersion = '0.0.0';

/**
 * Build the API server without listening, so tests can drive it with `app.inject`. Without
 * services it answers health and nothing else — what the image's health check and a test of
 * the shell need; with them, every route in docs/07 (roadmap 6.1).
 */
export const buildApp = async (
  config: ServerConfig,
  services?: Services,
): Promise<FastifyInstance> => {
  const app = Fastify({
    logger: { level: config.logLevel },
  });

  await app.register(websocket);
  registerErrors(app);

  app.get('/api/health', async (): Promise<HealthResponse> => {
    const load = services?.supervisor.load;
    return {
      status: 'ok',
      version: packageVersion,
      simWorkers: config.simWorkers,
      runsPlaying: load?.busy ?? 0,
      runsWaiting: load?.queued ?? 0,
      databaseBytes: databaseBytes(config.databasePath),
      scryfallVersion: services?.queries.catalogueVersion() ?? null,
      uptimeSeconds: Math.round(process.uptime()),
    };
  });

  if (services !== undefined) {
    await runRoutes(app, services);
    await gameRoutes(app, services);
    await cardRoutes(app, services);
  }

  // The live game/run feed. Phase 6.2 replaces the echo with the subscription hub.
  app.get('/api/events', { websocket: true }, (socket) => {
    socket.send(JSON.stringify({ type: 'hello', version: packageVersion }));
  });

  // In the Docker image the built web app sits next to the server bundle and is
  // served from the same port. In development Vite serves it instead.
  if (config.webDist && existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.status(404).send({
          error: { code: 'not_found', message: `no route ${request.method} ${request.url}` },
        });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
};
