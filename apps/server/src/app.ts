import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ServerConfig } from './config.js';

/** Reported by `GET /api/health`; also the shape the UI polls on startup. */
export interface HealthResponse {
  status: 'ok';
  version: string;
  simWorkers: number;
  uptimeSeconds: number;
}

const packageVersion = '0.0.0';

/**
 * Build the API server without listening, so tests can drive it with `app.inject`.
 * Routes for runs, cycles, decks, stats, bans, games and cards arrive in phase 6.
 */
export const buildApp = async (config: ServerConfig): Promise<FastifyInstance> => {
  const app = Fastify({
    logger: { level: config.logLevel },
  });

  await app.register(websocket);

  app.get('/api/health', async (): Promise<HealthResponse> => {
    return {
      status: 'ok',
      version: packageVersion,
      simWorkers: config.simWorkers,
      uptimeSeconds: Math.round(process.uptime()),
    };
  });

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
        return reply.status(404).send({ error: 'not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
};
