import type { GameEventLog } from './log.js';

/**
 * Event-log schema versioning (docs/06).
 *
 * Logs are written once and read for months, so old logs must always stay readable.
 * Bumping `CURRENT_EVENT_LOG_VERSION` means adding a migration here that lifts the
 * previous version to the new one; `migrateEventLog` chains them in order.
 */
export const CURRENT_EVENT_LOG_VERSION = 1;

/** Lifts a log from `version` to `version + 1`. */
type Migration = (log: Record<string, unknown>) => Record<string, unknown>;

/** Keyed by the version being migrated *from*. Empty while v1 is the only version. */
const migrations: ReadonlyMap<number, Migration> = new Map();

export class EventLogVersionError extends Error {
  constructor(
    message: string,
    readonly version: number,
  ) {
    super(message);
    this.name = 'EventLogVersionError';
  }
}

/**
 * Bring a stored log up to the current schema. Throws rather than guessing when the
 * log comes from a newer build than this one, since silently dropping fields would
 * corrupt replays and statistics.
 */
export const migrateEventLog = (stored: unknown): GameEventLog => {
  if (typeof stored !== 'object' || stored === null) {
    throw new EventLogVersionError('event log is not an object', Number.NaN);
  }

  const log = { ...(stored as Record<string, unknown>) };
  const version = log.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new EventLogVersionError(`event log has no usable version field`, Number(version));
  }
  if (version > CURRENT_EVENT_LOG_VERSION) {
    throw new EventLogVersionError(
      `event log version ${version} is newer than this build understands ` +
        `(${CURRENT_EVENT_LOG_VERSION}); upgrade before reading it`,
      version,
    );
  }

  let current = log;
  for (let from = version; from < CURRENT_EVENT_LOG_VERSION; from += 1) {
    const migration = migrations.get(from);
    if (!migration) {
      throw new EventLogVersionError(`no migration from event log version ${from}`, from);
    }
    current = migration(current);
    current.version = from + 1;
  }

  return current as unknown as GameEventLog;
};
