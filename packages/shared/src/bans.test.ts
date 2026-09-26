import { describe, expect, it } from 'vitest';
import {
  applyLegalChange,
  type BanEvent,
  type BanList,
  banLimit,
  banListOf,
  banViolations,
} from './bans.js';
import { type Deck75, IllegalDeckChangeError } from './deck-change.js';
import { asOracleId } from './ids.js';

/** The ban list (docs/05 "Bans and restrictions"; roadmap 5.5). */

const id = asOracleId;
const event = (
  oracleId: string,
  action: BanEvent['action'],
  applied: string | null = 'game-1',
): BanEvent => ({
  oracleId: id(oracleId),
  action,
  note: '',
  by: 'operator',
  at: '2026-09-26T12:00:00.000Z',
  appliedAfterGameId: applied,
});

describe('the list the audit trail makes', () => {
  it('replays applied edits in order', () => {
    const list = banListOf([
      event('lotus', 'ban'),
      event('recall', 'restrict'),
      event('bolt', 'ban'),
      event('bolt', 'unban'),
      event('recall', 'ban'),
      event('lotus', 'restrict'),
    ]);
    expect([...list].sort()).toEqual([
      [id('lotus'), 'restricted'],
      [id('recall'), 'banned'],
    ]);
  });

  it('leaves out an edit that has not taken effect yet', () => {
    expect(banListOf([event('lotus', 'ban', null)]).size).toBe(0);
    expect(banListOf([event('lotus', 'ban'), event('lotus', 'unban', null)]).get(id('lotus'))).toBe(
      'banned',
    );
  });

  it('allows none of a banned card, one of a restricted one, and any number otherwise', () => {
    const list: BanList = new Map([
      [id('lotus'), 'banned'],
      [id('recall'), 'restricted'],
    ]);
    expect(banLimit(list, id('lotus'))).toBe(0);
    expect(banLimit(list, id('recall'))).toBe(1);
    expect(banLimit(list, id('bolt'))).toBe(Number.POSITIVE_INFINITY);
  });
});

const slot = (name: string, count: number) => ({ oracleId: id(name), count });
const deck: Deck75 = {
  main: [slot('lotus', 1), slot('recall', 1), slot('bolt', 4), slot('mountain', 54)],
  side: [slot('recall', 1), slot('shatter', 14)],
};
const list: BanList = new Map([
  [id('lotus'), 'banned'],
  [id('recall'), 'restricted'],
]);

describe('which cards a deck holds too many of', () => {
  it('counts main and side together against the list', () => {
    expect(banViolations(deck, list)).toEqual([
      { oracleId: id('lotus'), status: 'banned', held: 1, allowed: 0 },
      { oracleId: id('recall'), status: 'restricted', held: 2, allowed: 1 },
    ]);
  });

  it('finds nothing wrong with a legal deck, or a card the list does not name', () => {
    expect(banViolations(deck, new Map())).toEqual([]);
    const legal: Deck75 = { main: [slot('recall', 1), slot('mountain', 59)], side: [] };
    expect(banViolations(legal, list)).toEqual([]);
  });
});

describe('a change checked against the list', () => {
  const legal: Deck75 = {
    main: [slot('recall', 1), slot('bolt', 4), slot('mountain', 55)],
    side: [slot('shatter', 15)],
  };

  it('refuses a second copy of a restricted card, main or side', () => {
    expect(() =>
      applyLegalChange(
        legal,
        {
          shape: 'replace',
          remove: { oracleId: id('shatter'), zone: 'side', count: 1 },
          add: { oracleId: id('recall'), zone: 'side', count: 1 },
        },
        list,
      ),
    ).toThrow(IllegalDeckChangeError);
  });

  it('refuses a banned card', () => {
    expect(() =>
      applyLegalChange(
        legal,
        {
          shape: 'replace',
          remove: { oracleId: id('bolt'), zone: 'main', count: 1 },
          add: { oracleId: id('lotus'), zone: 'main', count: 1 },
        },
        list,
      ),
    ).toThrow(/lotus.*banned/);
  });

  it('allows moving the one copy of a restricted card to the sideboard', () => {
    const after = applyLegalChange(
      { main: legal.main, side: [slot('shatter', 14), slot('wall', 1)] },
      {
        shape: 'swap',
        remove: { oracleId: id('recall'), zone: 'main', count: 1 },
        add: { oracleId: id('wall'), zone: 'main', count: 1 },
      },
      list,
    );
    expect(after.side).toContainEqual(slot('recall', 1));
  });
});
