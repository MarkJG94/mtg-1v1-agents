import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp, type HealthResponse } from './app.js';
import { loadConfig } from './config.js';

const testConfig = () =>
  loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', DATA_DIR: 'data', SIM_WORKERS: '2' });

describe('the API server', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp(testConfig());
  });

  afterEach(async () => {
    await app.close();
  });

  it('answers GET /api/health', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    const body = response.json<HealthResponse>();
    expect(body.status).toBe('ok');
    expect(body.simWorkers).toBe(2);
    expect([body.runsPlaying, body.runsWaiting]).toEqual([0, 0]);
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('404s an unknown API route rather than serving the app shell', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(response.statusCode).toBe(404);
  });
});

describe('the live event feed', () => {
  it('greets a WebSocket client on /api/events', async () => {
    const app = await buildApp(testConfig());
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no TCP address');

    try {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/events`);
      const greeting = await new Promise<string>((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => rejectPromise(new Error('no greeting')), 5_000);
        socket.on('message', (data: Buffer) => {
          clearTimeout(timer);
          resolvePromise(data.toString('utf8'));
        });
        socket.on('error', (error: Error) => {
          clearTimeout(timer);
          rejectPromise(error);
        });
      });
      expect(JSON.parse(greeting)).toEqual({ type: 'hello', version: '0.0.0' });
      socket.close();
    } finally {
      await app.close();
    }
  });
});
