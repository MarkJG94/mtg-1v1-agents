import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultEncoding, type Encoding, pack, unpack } from './compress.js';
import { openDatabase } from './open.js';
import * as schema from './schema.js';
import { SqliteScriptStore } from './script-store.js';

/**
 * The migrations under `drizzle/` and the schema in `schema.ts` are two statements of the
 * same tables (roadmap 5.6). The first is what a database actually gets; the second is
 * what the code reads and writes. A change to one without `pnpm db:generate` for the other
 * is caught here, column by column, before it is caught by a query failing at run time.
 */

const database = openDatabase(':memory:');
afterAll(() => database.close());

// `schema.ts` exports its tables and nothing else.
const tables: SQLiteTable[] = Object.values(schema);

interface ColumnInfo {
  readonly name: string;
  readonly notnull: number;
  readonly pk: number;
}

describe('the migrated database', () => {
  it('has every table the schema declares, and no other', () => {
    const migrated = database.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'",
      )
      .all() as { name: string }[];
    expect(migrated.map((row) => row.name).sort()).toEqual(
      tables.map((table) => getTableConfig(table).name).sort(),
    );
  });

  it.each(tables.map((table) => [getTableConfig(table).name, table] as const))(
    'has exactly the columns the schema declares for %s',
    (name, table) => {
      const config = getTableConfig(table);
      const migrated = database.sqlite.prepare(`PRAGMA table_info(${name})`).all() as ColumnInfo[];
      const compositeKey = new Set(
        config.primaryKeys.flatMap((key) => key.columns.map((column) => column.name)),
      );
      const shape = (column: { name: string; notNull: boolean; primary: boolean }) => ({
        name: column.name,
        notNull: column.notNull || column.primary,
        key: column.primary || compositeKey.has(column.name),
      });
      expect(
        migrated
          .map((column) =>
            shape({ name: column.name, notNull: column.notnull === 1, primary: column.pk > 0 }),
          )
          .sort((a, b) => a.name.localeCompare(b.name)),
      ).toEqual(config.columns.map(shape).sort((a, b) => a.name.localeCompare(b.name)));
    },
  );

  it('has every index the schema declares', () => {
    for (const table of tables) {
      const config = getTableConfig(table);
      const migrated = (
        database.sqlite.prepare(`PRAGMA index_list(${config.name})`).all() as { name: string }[]
      ).map((row) => row.name);
      for (const declared of config.indexes) expect(migrated).toContain(declared.config.name);
    }
  });
});

describe('the script store in SQLite', () => {
  const store = new SqliteScriptStore(database.db);

  it('gives back what it was given, and replaces an entry rather than adding one', () => {
    expect(store.get('o-1')).toBeNull();
    const entry = {
      oracleId: 'o-1',
      source: 'auto' as const,
      parserVersion: 3,
      status: 'partial' as const,
      reasons: [{ check: 'coverage' as const, message: 'not yet' }],
      script: { name: 'Thing', abilities: [] },
      updatedAt: '2026-09-26T12:00:00.000Z',
    };
    store.put(entry);
    expect(store.get('o-1')).toEqual(entry);
    const newer = { ...entry, parserVersion: 4, status: 'supported' as const, reasons: [] };
    store.put(newer);
    expect(store.get('o-1')).toEqual(newer);
    expect(database.sqlite.prepare('SELECT count(*) AS n FROM card_scripts').get()).toEqual({
      n: 1,
    });
  });

  it('keeps an unsupported verdict with no script', () => {
    const entry = {
      oracleId: 'o-2',
      source: 'auto' as const,
      parserVersion: 1,
      status: 'unsupported' as const,
      reasons: [],
      script: null,
      updatedAt: 'x',
    };
    store.put(entry);
    expect(store.get('o-2')).toEqual(entry);
  });

  it('logs every unsupported request, in order, with what was given', () => {
    store.logUnsupported({ oracleId: 'a', reason: 'r1', requestedAt: 't1' });
    store.logUnsupported({
      oracleId: 'b',
      runId: 'run',
      context: 'legalise',
      reason: 'r2',
      requestedAt: 't2',
    });
    store.logUnsupported({ oracleId: 'a', reason: 'r3', requestedAt: 't3' });
    expect(store.unsupportedRequests()).toEqual([
      { oracleId: 'a', reason: 'r1', requestedAt: 't1' },
      { oracleId: 'b', runId: 'run', context: 'legalise', reason: 'r2', requestedAt: 't2' },
      { oracleId: 'a', reason: 'r3', requestedAt: 't3' },
    ]);
  });
});

describe('compressed blobs', () => {
  const encodings: Encoding[] = defaultEncoding === 'zstd' ? ['zstd', 'gzip'] : ['gzip'];
  it.each(encodings)('round-trip through %s', (encoding) => {
    const value = { log: Array.from({ length: 200 }, (_, i) => ({ seq: i, kind: 'draw' })) };
    const packed = pack(value, encoding);
    expect(packed.length).toBeLessThan(JSON.stringify(value).length / 4);
    expect(unpack(packed, encoding)).toEqual(value);
  });

  it('refuses an encoding it does not know', () => {
    expect(() => unpack(pack({}), 'lz4')).toThrow();
  });
});
