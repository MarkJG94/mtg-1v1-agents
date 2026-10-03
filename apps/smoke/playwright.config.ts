import { defineConfig } from '@playwright/test';

/**
 * The smoke (docs/09 §7) runs against the built server, started here on the repository's own
 * cards, or — with `SMOKE_BASE_URL` — against a server already running, which is how CI holds
 * the Docker image to it.
 */

const port = Number(process.env.SMOKE_PORT ?? 8098);
const external = process.env.SMOKE_BASE_URL;

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: external ?? `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    viewport: { width: 1400, height: 1000 },
    // A machine with its own Chromium (a sandbox, say) names it; CI installs Playwright's.
    ...(process.env.SMOKE_CHROMIUM === undefined
      ? {}
      : { launchOptions: { executablePath: process.env.SMOKE_CHROMIUM } }),
  },
  ...(external === undefined
    ? {
        webServer: {
          command: 'node prepare-data.mjs && node ../server/dist/index.js',
          url: `http://127.0.0.1:${port}/api/health`,
          timeout: 120_000,
          reuseExistingServer: false,
          stdout: 'pipe',
          env: {
            PORT: String(port),
            HOST: '127.0.0.1',
            DATA_DIR: 'apps/smoke/.data',
            WEB_DIST: 'apps/web/dist',
            SCRYFALL_IMAGE_CACHE: 'off',
            SIM_WORKERS: '1',
            LOG_LEVEL: 'warn',
            NODE_ENV: 'production',
          },
        },
      }
    : {}),
});
