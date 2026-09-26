import { existsSync, statSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import type { HealthResponse } from '@mtg/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ServerConfig } from './config.js';
import { cardRoutes } from './routes/cards.js';
import { registerErrors } from './routes/errors.js';
import { gameRoutes } from './routes/games.js';
import { imageRoutes } from './routes/images.js';
import { runRoutes } from './routes/runs.js';
import type { Services } from './services.js';

export type { HealthResponse };

/** The database file and its write-ahead log, as they stand on disk. */
const databaseBytes = (path: string): number | null => {
  if (!existsSync(path)) return null;
  const wal = `${path}-wal`;
  return statSync(path).size + (existsSync(wal) ? statSync(wal).size : 0);
};

export const packageVersion = '0.0.0';

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
  // In the Docker image the built web app sits next to the server bundle and is served
  // from the same port, its pages falling back to index.html. In development Vite serves it.
  const { webDist } = config;
  const appShell = webDist !== undefined && existsSync(webDist);
  if (appShell) await app.register(fastifyStatic, { root: webDist });
  registerErrors(app, { appShell });

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
    await imageRoutes(app, services);
  }

  // docs/07's live feed: the hub, or a greeting alone from a server with no runs to show.
  app.get('/ws', { websocket: true }, (socket) => {
    if (services !== undefined) services.hub.connect(socket);
    else socket.send(JSON.stringify({ type: 'hello', version: packageVersion }));
  });

  return app;
};
