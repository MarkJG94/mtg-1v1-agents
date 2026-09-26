import { existsSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

/**
 * Server configuration, entirely from the environment so the Docker image needs no
 * config file. See "Deployment" in docs/01-architecture.md.
 */
const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  HOST: z.string().default('0.0.0.0'),
  /** Where the SQLite database, Scryfall bulk data and the image cache live. */
  DATA_DIR: z.string().default('data'),
  /** Simulation workers. Defaults to one per core, less the API process. */
  SIM_WORKERS: z.coerce.number().int().min(1).max(256).optional(),
  SCRYFALL_IMAGE_CACHE: z.enum(['lazy', 'off']).default('lazy'),
  /** The hand-written card scripts: the repository's by default. */
  CARD_SCRIPTS_DIR: z.string().default('packages/cards/scripts'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Directory of the built web app; served as static files when it exists. */
  WEB_DIST: z.string().optional(),
});

export interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  databasePath: string;
  scryfallDir: string;
  imageCacheDir: string;
  /** Scryfall's projections, one per line (`pnpm fetch:scryfall`). */
  cardsPath: string;
  cardScriptsDir: string;
  simWorkers: number;
  scryfallImageCache: 'lazy' | 'off';
  logLevel: z.infer<typeof envSchema>['LOG_LEVEL'];
  nodeEnv: z.infer<typeof envSchema>['NODE_ENV'];
  webDist: string | undefined;
}

export const defaultSimWorkers = (): number => Math.max(1, cpus().length - 1);

/**
 * Where a relative `DATA_DIR` or `CARD_SCRIPTS_DIR` is taken from: the pnpm workspace the
 * server runs in, found by walking up to its `pnpm-workspace.yaml`, or else `start`
 * itself. `pnpm dev` runs the server in `apps/server`, and the data `pnpm fetch:scryfall`
 * writes and the scripts it reads are the repository's, at its root; the Docker image sets
 * both paths absolutely.
 */
export const pathBase = (start: string = process.cwd()): string => {
  let directory = resolve(start);
  for (;;) {
    if (existsSync(join(directory, 'pnpm-workspace.yaml'))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return resolve(start);
    directory = parent;
  }
};

export const loadConfig = (
  env: NodeJS.ProcessEnv = process.env,
  base: string = pathBase(),
): ServerConfig => {
  // Docker Compose passes unset variables through as empty strings; treat those as absent
  // so that `SIM_WORKERS=` means "use the default" rather than "zero workers".
  const present = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ''),
  );
  const parsed = envSchema.parse(present);
  const dataDir = resolve(base, parsed.DATA_DIR);
  return {
    port: parsed.PORT,
    host: parsed.HOST,
    dataDir,
    databasePath: resolve(dataDir, 'mtg.db'),
    scryfallDir: resolve(dataDir, 'scryfall'),
    imageCacheDir: resolve(dataDir, 'images'),
    cardsPath: resolve(dataDir, 'scryfall', 'cards.jsonl'),
    cardScriptsDir: resolve(base, parsed.CARD_SCRIPTS_DIR),
    simWorkers: parsed.SIM_WORKERS ?? defaultSimWorkers(),
    scryfallImageCache: parsed.SCRYFALL_IMAGE_CACHE,
    logLevel: parsed.LOG_LEVEL,
    nodeEnv: parsed.NODE_ENV,
    webDist: parsed.WEB_DIST ? resolve(base, parsed.WEB_DIST) : undefined,
  };
};
