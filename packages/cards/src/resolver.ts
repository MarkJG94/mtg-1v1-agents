import type { CardDefinition } from '@mtg/engine';
import type { CheckProblem } from './checks.js';
import { readScripts, SCRIPTS_DIRECTORY } from './files.js';
import type { CardProjection } from './scryfall.js';
import type { CachedScript, ScriptStore } from './store.js';
import { VALIDATOR_VERSION, type ValidationStatus, validateScript } from './validate.js';

/**
 * `ScriptResolver` — how the system gets a playable card (docs/03 "Sources of truth").
 *
 * Four steps, in this order, and the order is the design:
 *
 * 1. **A hand script**, if somebody wrote one. Hand scripts always win: they exist
 *    precisely because the parser could not do the card justice.
 * 2. **A cached verdict**, if one was reached by the version that is running now. A stale
 *    one — from an older parser or an older validator — is not believed, because the whole
 *    reason for storing the version is to know when an answer has to be re-earned.
 * 3. **The auto-scripter**, which is phase 3. Until it exists the resolver simply has no
 *    third step, which is a legitimate configuration rather than a hole: everything
 *    outside the bootstrap set is unsupported, and says so.
 * 4. **Unsupported**, logged with a reason.
 *
 * Whatever happens, the verdict is cached — including "unsupported". Re-running a parser
 * and a smoke test on every request for a card that was unplayable an hour ago is the
 * cost this cache exists to avoid.
 *
 * **Partial scripts are never played** (docs/03). A partial script is right about what it
 * does but does not do everything the card says, and a game played with one is quietly
 * playing a different card.
 */

/** Phase 3's parser, as this side of the seam sees it. */
export interface AutoScripter {
  /** Bumped when the grammar changes, which invalidates every cached auto verdict. */
  readonly version: number;
  /** A script for this card, or `null` if the grammar could not read it. */
  script(card: CardProjection): unknown | null;
}

export interface ResolverOptions {
  /** Hand scripts by oracle id. `loadHandScripts()` builds one from the YAML files. */
  readonly hand?: ReadonlyMap<string, unknown>;
  readonly store?: ScriptStore;
  readonly auto?: AutoScripter;
  /** Playing the card is the slow check; a caller that only wants the cheap ones says so. */
  readonly skipSmokeTest?: boolean;
  /** Injected so a test's timestamps are its own. */
  readonly now?: () => string;
}

export interface Resolution {
  /** `unscripted` means nothing claimed the card at all, not that a script failed. */
  readonly status: ValidationStatus | 'unscripted';
  /** Non-null only when the card can actually be played. */
  readonly definition: CardDefinition | null;
  readonly source: 'hand' | 'auto' | 'cache' | 'none';
  readonly reasons: readonly CheckProblem[];
}

export interface RequestContext {
  readonly runId?: string;
  readonly context?: string;
}

export class ScriptResolver {
  private readonly hand: ReadonlyMap<string, unknown>;
  private readonly store: ScriptStore | undefined;
  private readonly auto: AutoScripter | undefined;
  private readonly now: () => string;
  private readonly skipSmokeTest: boolean;

  constructor(options: ResolverOptions = {}) {
    this.hand = options.hand ?? new Map();
    this.store = options.store;
    this.auto = options.auto;
    this.now = options.now ?? (() => new Date().toISOString());
    this.skipSmokeTest = options.skipSmokeTest ?? false;
  }

  resolve(card: CardProjection, request: RequestContext = {}): Resolution {
    const handScript = this.hand.get(card.oracleId);
    if (handScript !== undefined) {
      return this.fromCacheOrValidate(card, handScript, 'hand', VALIDATOR_VERSION, request);
    }

    const cached = this.usableCacheEntry(card.oracleId, 'auto');
    if (cached !== null) return this.fromCached(card, cached, request);

    if (this.auto !== undefined) {
      const generated = this.auto.script(card);
      if (generated !== null) {
        return this.fromCacheOrValidate(card, generated, 'auto', this.auto.version, request);
      }
    }

    const reason =
      this.auto === undefined
        ? 'no hand script, and no auto-scripter is configured'
        : 'the auto-scripter could not read this card';
    this.log(card, reason, request);
    return { status: 'unscripted', definition: null, source: 'none', reasons: [] };
  }

  /** Definitions for every card that can be played, for handing to a game. */
  definitionsFor(
    cards: readonly CardProjection[],
    request: RequestContext = {},
  ): readonly CardDefinition[] {
    return cards.flatMap((card) => {
      const resolved = this.resolve(card, request);
      return resolved.definition === null ? [] : [resolved.definition];
    });
  }

  // --- Internals ---

  /** A cached verdict is only usable when the version that produced it is still current. */
  private usableCacheEntry(oracleId: string, source: 'hand' | 'auto'): CachedScript | null {
    const cached = this.store?.get(oracleId);
    if (cached === undefined || cached === null || cached.source !== source) return null;

    const current = source === 'hand' ? VALIDATOR_VERSION : this.auto?.version;
    return current !== undefined && cached.parserVersion === current ? cached : null;
  }

  private fromCached(
    card: CardProjection,
    cached: CachedScript,
    request: RequestContext,
  ): Resolution {
    if (cached.status !== 'supported') {
      this.log(card, `cached as ${cached.status}`, request);
      return { status: cached.status, definition: null, source: 'cache', reasons: cached.reasons };
    }

    // The verdict is cached; the definition is not, because a `CardDefinition` is cheap to
    // rebuild and a stored one would be a second copy of the truth to keep in step.
    const result = validateScript(cached.script, card, { skipSmokeTest: true });
    return {
      status: result.status,
      definition: result.definition,
      source: 'cache',
      reasons: result.reasons,
    };
  }

  private fromCacheOrValidate(
    card: CardProjection,
    script: unknown,
    source: 'hand' | 'auto',
    version: number,
    request: RequestContext,
  ): Resolution {
    const cached = this.usableCacheEntry(card.oracleId, source);
    if (cached !== null) return this.fromCached(card, cached, request);

    const result = validateScript(script, card, { skipSmokeTest: this.skipSmokeTest });

    this.store?.put({
      oracleId: card.oracleId,
      source,
      parserVersion: version,
      status: result.status,
      reasons: result.reasons,
      script,
      updatedAt: this.now(),
    });

    if (result.status !== 'supported') {
      this.log(card, `${source} script is ${result.status}`, request);
      return { status: result.status, definition: null, source, reasons: result.reasons };
    }

    return {
      status: 'supported',
      definition: result.definition,
      source,
      reasons: result.reasons,
    };
  }

  private log(card: CardProjection, reason: string, request: RequestContext): void {
    this.store?.logUnsupported({
      oracleId: card.oracleId,
      ...(request.runId !== undefined ? { runId: request.runId } : {}),
      ...(request.context !== undefined ? { context: request.context } : {}),
      reason,
      requestedAt: this.now(),
    });
  }
}

/** Hand scripts from disk, by oracle id — the resolver's first step as a lookup. */
export const loadHandScripts = (directory = SCRIPTS_DIRECTORY): ReadonlyMap<string, unknown> => {
  const scripts = new Map<string, unknown>();

  for (const file of readScripts(directory)) {
    const oracleId = (file.content as { oracleId?: unknown }).oracleId;
    if (typeof oracleId === 'string') scripts.set(oracleId, file.content);
  }

  return scripts;
};
