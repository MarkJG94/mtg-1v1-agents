import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    expect([body.runsPlaying, body.runsWaiting, body.scryfallVersion]).toEqual([0, 0, null]);
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('404s an unknown API route rather than serving the app shell', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});

describe('serving the built web app (the Docker image, WEB_DIST)', () => {
  let app: FastifyInstance;
  let web: string;

  beforeEach(async () => {
    web = mkdtempSync(join(tmpdir(), 'web-dist-'));
    mkdirSync(join(web, 'assets'));
    writeFileSync(join(web, 'index.html'), '<!doctype html><div id="root"></div>');
    writeFileSync(join(web, 'assets', 'app.js'), 'console.log(1)');
    app = await buildApp(
      loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', DATA_DIR: 'data', WEB_DIST: web }),
    );
  });

  afterEach(async () => {
    await app.close();
    rmSync(web, { recursive: true, force: true });
  });

  it('serves the app’s files, and its index for any page the router knows', async () => {
    expect((await app.inject({ url: '/assets/app.js' })).body).toBe('console.log(1)');
    for (const url of ['/', '/runs/new', '/runs/abc?tab=decks']) {
      const page = await app.inject({ url });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('<div id="root">');
    }
  });

  it('keeps the API, the images, a missing file and a POST as 404s in docs/07’s shape', async () => {
    for (const [method, url] of [
      ['GET', '/api/nope'],
      ['GET', '/img'],
      ['GET', '/assets/missing.js'],
      ['POST', '/runs/new'],
    ] as const) {
      const response = await app.inject({ method, url });
      expect(response.statusCode, url).toBe(404);
      expect(response.json(), url).toMatchObject({ error: { code: 'not_found' } });
    }
  });
});

describe('the live event feed', () => {
  it('greets a WebSocket client on /ws', async () => {
    const app = await buildApp(testConfig());
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no TCP address');

    try {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
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
