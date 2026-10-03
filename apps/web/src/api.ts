import {
  apiErrorSchema,
  banStateSchema,
  type CardFace,
  type CreateRunRequest,
  type CycleSummary,
  cardDetailSchema,
  cardLookupSchema,
  cardSearchSchema,
  coverageSchema,
  cycleDetailSchema,
  cyclePageSchema,
  gameDetailSchema,
  gameLogSchema,
  healthSchema,
  matchDetailSchema,
  resolveCardsSchema,
  runDetailSchema,
  runListSchema,
  runSummarySchema,
  scriptResultSchema,
  seedDeckPreviewSchema,
  statsTableSchema,
} from '@mtg/shared';
import type { z } from 'zod';

/**
 * The HTTP API as the browser calls it (docs/07). Every response is parsed with the schema
 * the server's contract tests hold it to (`@mtg/shared` api.ts), so a field the two ends
 * disagree about fails here, loudly, rather than as `undefined` three components later.
 */

/** A request the server refused, with docs/07's `{ error: { code, message, details? } }`. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

const request = async <T extends z.ZodType>(
  schema: T,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<z.output<T>> => {
  const response = await fetch(path, {
    method: init.method ?? 'GET',
    headers:
      init.body === undefined
        ? { accept: 'application/json' }
        : { accept: 'application/json', 'content-type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text.length === 0 ? null : JSON.parse(text);
  } catch {
    // Not JSON: a proxy's error page, say. Reported below by status.
  }
  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(json);
    if (parsed.success) {
      const { code, message, details } = parsed.data.error;
      throw new ApiRequestError(response.status, code, message, details);
    }
    throw new ApiRequestError(response.status, 'http_error', `${path}: HTTP ${response.status}`);
  }
  return schema.parse(json);
};

const post = <T extends z.ZodType>(schema: T, path: string, body: unknown = {}) =>
  request(schema, path, { method: 'POST', body });

const runPath = (id: string) => `/api/runs/${encodeURIComponent(id)}`;

export type RunAction = 'start' | 'pause' | 'stop';

/** The most the API pages at once (docs/07: cycles `limit` at most 500) and looks up. */
const PAGE = 500;

export const api = {
  health: () => request(healthSchema, '/api/health'),
  runs: () => request(runListSchema, '/api/runs'),
  run: (id: string) => request(runDetailSchema, runPath(id)),
  createRun: (body: CreateRunRequest) => post(runSummarySchema, '/api/runs', body),
  lifecycle: (id: string, action: RunAction) => post(runSummarySchema, `${runPath(id)}/${action}`),
  fork: (id: string, body: { cycle: number; name?: string }) =>
    post(runSummarySchema, `${runPath(id)}/fork`, body),
  /** Where a run's export bundle downloads from; the browser fetches it, not this client. */
  exportUrl: (id: string) => `${runPath(id)}/export`,
  importRun: (bundle: unknown) => post(runSummarySchema, '/api/runs/import', bundle),
  rollSeedDeck: (body: {
    settings: CreateRunRequest['settings'];
    bans: NonNullable<CreateRunRequest['bans']>;
  }) => post(seedDeckPreviewSchema, '/api/seed-decks', body),
  resolveCards: (names: readonly string[], script = true) =>
    post(resolveCardsSchema, '/api/cards/resolve', { names, script }),
  cycles: (id: string, offset = 0, limit = 50) =>
    request(cyclePageSchema, `${runPath(id)}/cycles?offset=${offset}&limit=${limit}`),
  /** Every finished cycle, page by page: the win-rate chart plots them all. */
  allCycles: async (id: string): Promise<CycleSummary[]> => {
    const all: CycleSummary[] = [];
    for (;;) {
      const page = await api.cycles(id, all.length, PAGE);
      all.push(...page.cycles);
      if (page.cycles.length === 0 || all.length >= page.total) return all;
    }
  },
  cycle: (id: string, number: number) =>
    request(cycleDetailSchema, `${runPath(id)}/cycles/${number}`),
  stats: (id: string, agent: 'A' | 'B', cycle?: number) =>
    request(
      statsTableSchema,
      `${runPath(id)}/stats?agent=${agent}${cycle === undefined ? '' : `&cycle=${cycle}`}`,
    ),
  match: (id: string) => request(matchDetailSchema, `/api/matches/${encodeURIComponent(id)}`),
  game: (id: string) => request(gameDetailSchema, `/api/games/${encodeURIComponent(id)}`),
  gameLog: (id: string) => request(gameLogSchema, `/api/games/${encodeURIComponent(id)}/log`),
  bans: (id: string) => request(banStateSchema, `${runPath(id)}/bans`),
  ban: (id: string, oracleId: string, body: { status: 'banned' | 'restricted'; note: string }) =>
    request(banStateSchema, `${runPath(id)}/bans/${encodeURIComponent(oracleId)}`, {
      method: 'PUT',
      body,
    }),
  unban: (id: string, oracleId: string) =>
    request(banStateSchema, `${runPath(id)}/bans/${encodeURIComponent(oracleId)}`, {
      method: 'DELETE',
    }),
  /** Cards by oracle id, as many as asked, in requests of at most 500. */
  lookupCards: async (oracleIds: readonly string[]): Promise<CardFace[]> => {
    const unique = [...new Set(oracleIds)];
    const found: CardFace[] = [];
    for (let start = 0; start < unique.length; start += PAGE) {
      const { cards } = await post(cardLookupSchema, '/api/cards/lookup', {
        oracleIds: unique.slice(start, start + PAGE),
      });
      found.push(...cards);
    }
    return found;
  },
  card: (oracleId: string) =>
    request(cardDetailSchema, `/api/cards/${encodeURIComponent(oracleId)}`),
  /** Scripts a card afresh (docs/08 "try to script"). */
  scriptCard: (oracleId: string) =>
    post(scriptResultSchema, `/api/cards/${encodeURIComponent(oracleId)}/script`),
  coverage: () => request(coverageSchema, '/api/coverage'),
  searchCards: (q: string, limit = 12) =>
    request(cardSearchSchema, `/api/cards?${new URLSearchParams({ q, limit: String(limit) })}`),
};

/** An image of a card through the server's cache (docs/07 `/img/:oracleId`). */
export const imageUrl = (oracleId: string, size: 'small' | 'normal' = 'small') =>
  `/img/${encodeURIComponent(oracleId)}?size=${size}`;

/** What to show a person for a failed request. */
export const describeError = (error: unknown): string =>
  error instanceof ApiRequestError
    ? `${error.message} (${error.code})`
    : error instanceof Error
      ? error.message
      : String(error);
