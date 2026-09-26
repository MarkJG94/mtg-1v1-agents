import {
  apiErrorSchema,
  type CreateRunRequest,
  cardSearchSchema,
  healthSchema,
  resolveCardsSchema,
  runDetailSchema,
  runListSchema,
  runSummarySchema,
  seedDeckPreviewSchema,
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
