import type { CheckProblem } from './checks.js';
import type { ValidationStatus } from './validate.js';

/**
 * Where the resolver remembers things (docs/06 `card_scripts`, `unsupported_requests`).
 *
 * These are ports, not a database. The tables they mirror arrive with the server's
 * persistence in phase 5; until then an in-memory implementation is enough to build and
 * test the resolver, and the SQLite one drops in behind the same two interfaces without
 * the resolver noticing. The row shapes are docs/06's, field for field, so that swap is a
 * mapping rather than a redesign.
 */

export interface CachedScript {
  readonly oracleId: string;
  /** A script somebody wrote, or one the parser produced. */
  readonly source: 'hand' | 'auto';
  /**
   * Which version produced this verdict — the parser's for an auto script, the
   * validator's for a hand one. A cached answer from an older version is not believed:
   * that is the whole point of storing it (docs/03).
   */
  readonly parserVersion: number;
  readonly status: ValidationStatus;
  readonly reasons: readonly CheckProblem[];
  /** The script itself, as it was validated. */
  readonly script: unknown;
  readonly updatedAt: string;
}

/**
 * A card a run asked for and could not have. This is the demand signal: docs/03 wants
 * hand-scripting effort to follow what is actually requested rather than what looks
 * interesting, and the UI's coverage page reads it.
 */
export interface UnsupportedRequest {
  readonly oracleId: string;
  readonly runId?: string;
  /** Where the request came from — a deck generation, a legalisation, a manual lookup. */
  readonly context?: string;
  readonly reason: string;
  readonly requestedAt: string;
}

export interface ScriptStore {
  get(oracleId: string): CachedScript | null;
  put(entry: CachedScript): void;
  logUnsupported(request: UnsupportedRequest): void;
}

/** The in-memory store: real behaviour, no persistence. */
export class MemoryScriptStore implements ScriptStore {
  private readonly entries = new Map<string, CachedScript>();
  private readonly requests: UnsupportedRequest[] = [];

  get(oracleId: string): CachedScript | null {
    return this.entries.get(oracleId) ?? null;
  }

  put(entry: CachedScript): void {
    this.entries.set(entry.oracleId, entry);
  }

  logUnsupported(request: UnsupportedRequest): void {
    this.requests.push(request);
  }

  /** Everything logged, for tests and for whoever builds the coverage page. */
  unsupportedRequests(): readonly UnsupportedRequest[] {
    return this.requests;
  }

  size(): number {
    return this.entries.size;
  }
}
