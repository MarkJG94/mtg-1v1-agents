import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

/**
 * The database (docs/06): one SQLite file, in WAL mode with `synchronous=NORMAL`, brought
 * up to date with every migration under `drizzle/` whenever it is opened. `:memory:` gives
 * a throwaway one for tests.
 */

export type Db = BetterSQLite3Database<typeof schema>;

export interface OpenDatabase {
  readonly sqlite: Database.Database;
  readonly db: Db;
  close(): void;
}

/** `drizzle/` beside the package, found from the source (`src/db`) or the bundle (`dist`). */
const migrationsFolder = (): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [resolve(here, '../../drizzle'), resolve(here, '../drizzle')]) {
    if (existsSync(resolve(candidate, 'meta/_journal.json'))) return candidate;
  }
  throw new Error(`no drizzle migrations found near ${here}`);
};

export const openDatabase = (path: string): OpenDatabase => {
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migrationsFolder() });
  return { sqlite, db, close: () => sqlite.close() };
};

/**
 * A connection that can read and cannot write — SQLite refuses the write itself — for a
 * worker, since the API process is the only writer (docs/01 "Processes"). It expects the
 * file to exist and be migrated already, which `openDatabase` in the API process sees to.
 */
export const openReadonly = (path: string): OpenDatabase => {
  const sqlite = new Database(path, { readonly: true, fileMustExist: true });
  const db = drizzle(sqlite, { schema });
  return { sqlite, db, close: () => sqlite.close() };
};
