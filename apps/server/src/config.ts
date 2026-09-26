import { cpus } from 'node:os';
import { resolve } from 'node:path';
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
  /** The hand-written card scripts; the repository's, relative to where the server runs. */
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

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): ServerConfig => {
  // Docker Compose passes unset variables through as empty strings; treat those as absent
  // so that `SIM_WORKERS=` means "use the default" rather than "zero workers".
  const present = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ''),
  );
  const parsed = envSchema.parse(present);
  const dataDir = resolve(parsed.DATA_DIR);
  return {
    port: parsed.PORT,
    host: parsed.HOST,
    dataDir,
    databasePath: resolve(dataDir, 'mtg.db'),
    scryfallDir: resolve(dataDir, 'scryfall'),
    imageCacheDir: resolve(dataDir, 'images'),
    cardsPath: resolve(dataDir, 'scryfall', 'cards.jsonl'),
    cardScriptsDir: resolve(parsed.CARD_SCRIPTS_DIR),
    simWorkers: parsed.SIM_WORKERS ?? defaultSimWorkers(),
    scryfallImageCache: parsed.SCRYFALL_IMAGE_CACHE,
    logLevel: parsed.LOG_LEVEL,
    nodeEnv: parsed.NODE_ENV,
    webDist: parsed.WEB_DIST ? resolve(parsed.WEB_DIST) : undefined,
  };
};
