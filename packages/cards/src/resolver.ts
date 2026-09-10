import type { CardDefinition } from '@mtg/engine';
import type { CardScript } from './schema.js';
import type { CardDatabase, ScryfallCard } from './scryfall.js';
import { type ScriptStatus, type ValidateOptions, validateScript } from './validate.js';

/** Bumping this invalidates every cached auto script (docs/03 §Sources of truth). */
export const PARSER_VERSION = 0;

export interface CachedScript {
  oracleId: string;
  source: 'hand' | 'auto';
  parserVersion: number;
  status: ScriptStatus;
  reasons: string[];
  script: CardScript | null;
  updatedAt: string;
}

/** Storage for auto-script results (`card_scripts` table in Phase 5; in-memory here). */
export interface ScriptCache {
  get(oracleId: string, parserVersion: number): CachedScript | undefined;
  set(entry: CachedScript): void;
}

export interface UnsupportedRequest {
  oracleId: string;
  runId: string | null;
  context: string;
  reason: string;
  requestedAt: string;
}

/** Sink for unsupported requests (`unsupported_requests` table in Phase 5). */
export interface UnsupportedLog {
  log(entry: UnsupportedRequest): void;
}

/** The oracle-text auto-scripter (Phase 3). Returns null when the text cannot be parsed. */
export interface AutoScripter {
  version: number;
  script(card: ScryfallCard): { script: unknown | null; reasons: string[] };
}

export interface ResolveResult {
  oracleId: string;
  status: ScriptStatus;
  source: 'hand' | 'auto' | 'none';
  reasons: string[];
  definition: CardDefinition | null;
  parserVersion: number;
}

export class MemoryScriptCache implements ScriptCache {
  readonly entries = new Map<string, CachedScript>();
  get(oracleId: string, parserVersion: number): CachedScript | undefined {
    const e = this.entries.get(oracleId);
    return e && e.parserVersion === parserVersion ? e : undefined;
  }
  set(entry: CachedScript): void {
    this.entries.set(entry.oracleId, entry);
  }
}

export class MemoryUnsupportedLog implements UnsupportedLog {
  readonly entries: UnsupportedRequest[] = [];
  log(entry: UnsupportedRequest): void {
    this.entries.push(entry);
  }
}

export interface ResolverOptions {
  db: CardDatabase;
  /** Hand scripts keyed by oracle id (raw documents; validated on first use). */
  handScripts: Map<string, unknown>;
  cache?: ScriptCache;
  unsupportedLog?: UnsupportedLog;
  autoScripter?: AutoScripter;
  validate?: ValidateOptions;
  now?: () => string;
}

/**
 * Decides, card by card, what the engine can play (docs/01 §Card lifecycle):
 * hand script → cached auto script → auto-scripter → validation. Results are memoised per resolver;
 * every non-supported answer is written to the unsupported log with its reason.
 */
export class ScriptResolver {
  private readonly db: CardDatabase;
  private readonly handScripts: Map<string, unknown>;
  private readonly cache: ScriptCache;
  private readonly unsupported: UnsupportedLog;
  private readonly autoScripter: AutoScripter | null;
  private readonly validateOptions: ValidateOptions;
  private readonly now: () => string;
  private readonly memo = new Map<string, ResolveResult>();

  constructor(opts: ResolverOptions) {
    this.db = opts.db;
    this.handScripts = opts.handScripts;
    this.cache = opts.cache ?? new MemoryScriptCache();
    this.unsupported = opts.unsupportedLog ?? new MemoryUnsupportedLog();
    this.autoScripter = opts.autoScripter ?? null;
    this.validateOptions = opts.validate ?? {};
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  get parserVersion(): number {
    return this.autoScripter?.version ?? PARSER_VERSION;
  }

  resolve(oracleId: string, context = 'unknown', runId: string | null = null): ResolveResult {
    const memo = this.memo.get(oracleId);
    if (memo) {
      if (memo.status !== 'supported') this.logUnsupported(oracleId, context, runId, memo.reasons);
      return memo;
    }
    const result = this.compute(oracleId);
    this.memo.set(oracleId, result);
    if (result.status !== 'supported')
      this.logUnsupported(oracleId, context, runId, result.reasons);
    return result;
  }

  resolveByName(name: string, context = 'unknown', runId: string | null = null): ResolveResult {
    const card = this.db.named(name);
    if (!card)
      return {
        oracleId: '',
        status: 'unsupported',
        source: 'none',
        reasons: [`no card named "${name}"`],
        definition: null,
        parserVersion: this.parserVersion,
      };
    return this.resolve(card.oracle_id, context, runId);
  }

  /** Definitions of every supported card resolved so far, keyed by oracle id (what a game needs). */
  definitions(): Record<string, CardDefinition> {
    const out: Record<string, CardDefinition> = {};
    for (const r of this.memo.values())
      if (r.definition && r.status === 'supported') out[r.oracleId] = r.definition;
    return out;
  }

  private logUnsupported(
    oracleId: string,
    context: string,
    runId: string | null,
    reasons: string[],
  ): void {
    this.unsupported.log({
      oracleId,
      runId,
      context,
      reason: reasons.join('; ') || 'unsupported',
      requestedAt: this.now(),
    });
  }

  private compute(oracleId: string): ResolveResult {
    const card = this.db.get(oracleId);
    const pv = this.parserVersion;
    if (!card)
      return {
        oracleId,
        status: 'unsupported',
        source: 'none',
        reasons: ['unknown oracle id'],
        definition: null,
        parserVersion: pv,
      };

    const hand = this.handScripts.get(oracleId);
    if (hand !== undefined) {
      const v = validateScript(hand, card, this.validateOptions);
      return {
        oracleId,
        status: v.status,
        source: 'hand',
        reasons: v.reasons,
        definition: v.status === 'supported' ? v.definition : null,
        parserVersion: pv,
      };
    }

    const cached = this.cache.get(oracleId, pv);
    if (cached) {
      if (cached.status === 'supported' && cached.script) {
        const v = validateScript(cached.script, card, { ...this.validateOptions, skipSmoke: true });
        return {
          oracleId,
          status: v.status,
          source: 'auto',
          reasons: v.reasons,
          definition: v.status === 'supported' ? v.definition : null,
          parserVersion: pv,
        };
      }
      return {
        oracleId,
        status: cached.status,
        source: 'auto',
        reasons: cached.reasons,
        definition: null,
        parserVersion: pv,
      };
    }

    if (!this.autoScripter) {
      const reasons = ['no hand script and no auto-scripter available'];
      this.cache.set({
        oracleId,
        source: 'auto',
        parserVersion: pv,
        status: 'unsupported',
        reasons,
        script: null,
        updatedAt: this.now(),
      });
      return {
        oracleId,
        status: 'unsupported',
        source: 'none',
        reasons,
        definition: null,
        parserVersion: pv,
      };
    }
    const produced = this.autoScripter.script(card);
    if (!produced.script) {
      this.cache.set({
        oracleId,
        source: 'auto',
        parserVersion: pv,
        status: 'unsupported',
        reasons: produced.reasons,
        script: null,
        updatedAt: this.now(),
      });
      return {
        oracleId,
        status: 'unsupported',
        source: 'auto',
        reasons: produced.reasons,
        definition: null,
        parserVersion: pv,
      };
    }
    const v = validateScript(produced.script, card, this.validateOptions);
    this.cache.set({
      oracleId,
      source: 'auto',
      parserVersion: pv,
      status: v.status,
      reasons: v.reasons,
      script: v.script,
      updatedAt: this.now(),
    });
    return {
      oracleId,
      status: v.status,
      source: 'auto',
      reasons: v.reasons,
      definition: v.status === 'supported' ? v.definition : null,
      parserVersion: pv,
    };
  }
}
