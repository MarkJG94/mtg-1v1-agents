import { existsSync } from 'node:fs';
import type { Queries } from './db/queries.js';
import { HttpError } from './routes/errors.js';
import type { Supervisor } from './workers/supervisor.js';

/** What the routes work with (roadmap 6.1). */
export interface Services {
  readonly supervisor: Supervisor;
  readonly queries: Queries;
  readonly now: () => string;
  /** Fails a request that needs Scryfall's cards when they have not been fetched. */
  requireCards(): void;
}

export const services = (options: {
  readonly supervisor: Supervisor;
  readonly queries: Queries;
  readonly cardsPath: string;
  readonly now?: () => string;
}): Services => ({
  supervisor: options.supervisor,
  queries: options.queries,
  now: options.now ?? (() => new Date().toISOString()),
  requireCards: () => {
    if (!existsSync(options.cardsPath)) {
      throw new HttpError(
        503,
        'no_card_data',
        'the Scryfall data is missing: run `pnpm fetch:scryfall`',
      );
    }
  },
});
