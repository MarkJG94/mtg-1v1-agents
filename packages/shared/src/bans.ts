import {
  applyDeckChange,
  type Deck75,
  type DeckChange,
  IllegalDeckChangeError,
} from './deck-change.js';
import type { OracleId } from './ids.js';

/**
 * A run's ban list (docs/05 "Bans and restrictions", decision D12): Vintage-style, so a
 * banned card may not be in the seventy-five at all and a restricted one only once, main
 * and side together. It is kept as an audit trail of edits (roadmap 5.5), replayed into
 * the list as it stands; the seed deck generator, the pool query and every deck change
 * read that, and a deck the list catches out is legalised.
 */
export type BanStatus = 'banned' | 'restricted';
export type BanList = ReadonlyMap<OracleId, BanStatus>;

export const noBans: BanList = new Map();

/** Copies of a card the run's own list allows in a seventy-five, before any other rule. */
export const banLimit = (banList: BanList, oracleId: OracleId): number => {
  const status = banList.get(oracleId);
  return status === 'banned' ? 0 : status === 'restricted' ? 1 : Number.POSITIVE_INFINITY;
};

// --- The audit trail ---

/** What an operator can do to a card (docs/07 `PUT` and `DELETE /api/runs/:id/bans`). */
export const banActions = ['ban', 'restrict', 'unban'] as const;
export type BanAction = (typeof banActions)[number];

/**
 * One edit to the ban list, as docs/06's `ban_events` keeps it: who asked for what and
 * why, when, and after which game it took effect. An edit asked for during a game takes
 * effect when that game ends (docs/05); until then `appliedAfterGameId` is `null` and the
 * edit is pending.
 */
export interface BanEvent {
  readonly oracleId: OracleId;
  readonly action: BanAction;
  readonly note: string;
  /** Who asked for it: an operator's name, or `import` for a list carried from elsewhere. */
  readonly by: string;
  /** When it was asked for, ISO 8601. */
  readonly at: string;
  readonly appliedAfterGameId: string | null;
}

/**
 * The list as the applied edits leave it, replayed in order: `ban` bans, `restrict`
 * restricts — loosening a ban as readily as tightening nothing — and `unban` clears the
 * card. A pending edit is not part of it yet.
 */
export const banListOf = (history: readonly BanEvent[]): BanList => {
  const list = new Map<OracleId, BanStatus>();
  for (const event of history) {
    if (event.appliedAfterGameId === null) continue;
    if (event.action === 'unban') list.delete(event.oracleId);
    else list.set(event.oracleId, event.action === 'ban' ? 'banned' : 'restricted');
  }
  return list;
};

// --- Legality ---

/** A card a 75 holds more copies of than the list allows. */
export interface BanViolation {
  readonly oracleId: OracleId;
  readonly status: BanStatus;
  /** Main and side together. */
  readonly held: number;
  readonly allowed: number;
}

/** Every card the deck holds too many of, in oracle-id order; none for a legal deck. */
export const banViolations = (deck: Deck75, banList: BanList): BanViolation[] => {
  const held = new Map<OracleId, number>();
  for (const slot of [...deck.main, ...deck.side]) {
    held.set(slot.oracleId, (held.get(slot.oracleId) ?? 0) + slot.count);
  }
  const violations: BanViolation[] = [];
  for (const [oracleId, status] of banList) {
    const count = held.get(oracleId) ?? 0;
    const allowed = banLimit(banList, oracleId);
    if (count > allowed) violations.push({ oracleId, status, held: count, allowed });
  }
  return violations.sort((a, b) => (a.oracleId < b.oracleId ? -1 : 1));
};

/**
 * A change applied, and refused if the deck it makes breaks the list (docs/05: "if a deck
 * holds 1 copy of a restricted card in the main and gains another via a change, the change
 * is rejected at validation"). Moving the one copy of a restricted card between main and
 * side is fine: the rule is about the 75.
 */
export const applyLegalChange = (
  deck: Deck75,
  change: Pick<DeckChange, 'shape' | 'remove' | 'add'>,
  banList: BanList,
): Deck75 => {
  const after = applyDeckChange(deck, change);
  const [broken] = banViolations(after, banList);
  if (broken !== undefined) {
    throw new IllegalDeckChangeError(
      `the change leaves ${broken.held} of ${broken.oracleId} in the 75, which is ${broken.status}`,
    );
  }
  return after;
};
