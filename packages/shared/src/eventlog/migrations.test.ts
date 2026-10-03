import { describe, expect, it } from 'vitest';
import { CURRENT_EVENT_LOG_VERSION, EventLogVersionError, migrateEventLog } from './migrations.js';

const logAtVersion = (version: number) => ({ version, gameId: 'g1', events: [] });

describe('migrateEventLog', () => {
  it('passes a current-version log through', () => {
    const log = logAtVersion(CURRENT_EVENT_LOG_VERSION);
    expect(migrateEventLog(log)).toMatchObject({ version: CURRENT_EVENT_LOG_VERSION });
  });

  it('does not mutate the stored object it was given', () => {
    const stored = logAtVersion(CURRENT_EVENT_LOG_VERSION);
    migrateEventLog(stored);
    expect(stored).toEqual(logAtVersion(CURRENT_EVENT_LOG_VERSION));
  });

  it('refuses a log written by a newer build rather than dropping fields', () => {
    expect(() => migrateEventLog(logAtVersion(CURRENT_EVENT_LOG_VERSION + 1))).toThrow(
      EventLogVersionError,
    );
    expect(() => migrateEventLog(logAtVersion(CURRENT_EVENT_LOG_VERSION + 1))).toThrow(
      /newer than this build/,
    );
  });

  it.each([
    ['not an object', 42],
    ['null', null],
    ['missing a version', { gameId: 'g1' }],
    ['a non-integer version', { version: 1.5 }],
    ['a zero version', { version: 0 }],
  ])('rejects a log that is %s', (_label, stored) => {
    expect(() => migrateEventLog(stored)).toThrow(EventLogVersionError);
  });

  it('reports which version it choked on', () => {
    try {
      migrateEventLog(logAtVersion(99));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EventLogVersionError);
      expect((error as EventLogVersionError).version).toBe(99);
    }
  });
});
