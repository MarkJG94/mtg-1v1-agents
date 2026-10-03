import type { CachedScript, ScriptStore, UnsupportedRequest } from '@mtg/cards';
import { eq } from 'drizzle-orm';
import type { Db } from './open.js';
import { cardScripts, unsupportedRequests } from './schema.js';

/**
 * The resolver's cache and demand log in SQLite (docs/06 `card_scripts`,
 * `unsupported_requests`; roadmap 5.6) — the port 2.4 left for it, row for row.
 */
export class SqliteScriptStore implements ScriptStore {
  constructor(private readonly db: Db) {}

  get(oracleId: string): CachedScript | null {
    const row = this.db.select().from(cardScripts).where(eq(cardScripts.oracleId, oracleId)).get();
    if (row === undefined) return null;
    return {
      oracleId: row.oracleId,
      source: row.source,
      parserVersion: row.parserVersion,
      status: row.status,
      reasons: JSON.parse(row.reasons),
      script: JSON.parse(row.script),
      updatedAt: row.updatedAt,
    };
  }

  put(entry: CachedScript): void {
    const row = {
      oracleId: entry.oracleId,
      source: entry.source,
      parserVersion: entry.parserVersion,
      status: entry.status,
      reasons: JSON.stringify(entry.reasons),
      script: JSON.stringify(entry.script ?? null),
      updatedAt: entry.updatedAt,
    };
    this.db
      .insert(cardScripts)
      .values(row)
      .onConflictDoUpdate({ target: cardScripts.oracleId, set: row })
      .run();
  }

  logUnsupported(request: UnsupportedRequest): void {
    this.db
      .insert(unsupportedRequests)
      .values({
        oracleId: request.oracleId,
        runId: request.runId ?? null,
        context: request.context ?? null,
        reason: request.reason,
        requestedAt: request.requestedAt,
      })
      .run();
  }

  /** Every request, oldest first, for the coverage page. */
  unsupportedRequests(): UnsupportedRequest[] {
    return this.db
      .select()
      .from(unsupportedRequests)
      .orderBy(unsupportedRequests.id)
      .all()
      .map((row) => ({
        oracleId: row.oracleId,
        ...(row.runId === null ? {} : { runId: row.runId }),
        ...(row.context === null ? {} : { context: row.context }),
        reason: row.reason,
        requestedAt: row.requestedAt,
      }));
  }
}
