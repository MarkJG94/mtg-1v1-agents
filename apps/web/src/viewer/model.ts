import type {
  BoardObject,
  CardFace,
  EventLogObject,
  ObjectId,
  PlayerId,
  ZoneId,
} from '@mtg/shared';
import type { Names } from './narrate.js';

/**
 * What the board renderer knows of a game's objects beyond the board itself: what each is
 * (the log's `objects`, docs/06) and what its card says (`POST /api/cards/lookup`). The
 * board is the log folded (`@mtg/shared` replay.ts); this is everything else it draws.
 */
export interface GameCards {
  readonly identities: ReadonlyMap<ObjectId, EventLogObject>;
  readonly faces: ReadonlyMap<string, CardFace>;
}

/** The name a person would call an object by. */
export const nameOf = (cards: GameCards, id: ObjectId): string => {
  const identity = cards.identities.get(id);
  if (identity === undefined) return `object ${id}`;
  const card = cards.faces.get(identity.oracleId)?.name;
  if (identity.ability === true) return `${card ?? 'a card'}’s ability`;
  if (identity.token === true) return `${identity.name ?? card ?? 'a'} token`;
  return card ?? 'a card';
};

export const namesFor = (cards: GameCards): Names => ({
  name: (id) => nameOf(cards, id),
  owner: (id) => cards.identities.get(id)?.owner ?? null,
});

export type Row = 'lands' | 'creatures' | 'other';

/**
 * Which row of its owner's battlefield a permanent sits in (docs/08: lands, creatures,
 * other permanents). A creature land counts as a creature only while its card says it is
 * one, since the log does not say when one was animated.
 */
export const rowOf = (cards: GameCards, id: ObjectId): Row => {
  const identity = cards.identities.get(id);
  if (identity?.token === true) return identity.power == null ? 'other' : 'creatures';
  const typeLine =
    identity === undefined ? '' : (cards.faces.get(identity.oracleId)?.typeLine ?? '');
  const front = typeLine.split('//')[0] ?? '';
  if (/\bCreature\b/.test(front)) return 'creatures';
  if (/\bLand\b/.test(front)) return 'lands';
  return 'other';
};

const printed = (value: string | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
};

/**
 * Power and toughness as the board can know them: printed (or the token's), with +1/+1
 * and -1/-1 counters on top (CR 122.1a). What continuous effects do is not in the log, so
 * an anthem's bonus is not shown; a printed `*` is shown as it is printed.
 */
export const powerToughness = (
  cards: GameCards,
  object: BoardObject,
): { readonly power: string; readonly toughness: string } | null => {
  const identity = cards.identities.get(object.id);
  if (identity === undefined) return null;
  const face = cards.faces.get(identity.oracleId);
  const basePower = identity.token === true ? identity.power : face?.power;
  const baseToughness = identity.token === true ? identity.toughness : face?.toughness;
  if (basePower == null || baseToughness == null) return null;
  const shift = (object.counters['+1/+1'] ?? 0) - (object.counters['-1/-1'] ?? 0);
  const show = (base: string | number) => {
    const value = typeof base === 'number' ? base : printed(base);
    return value === null ? String(base) : String(value + shift);
  };
  return { power: show(basePower), toughness: show(baseToughness) };
};

/** A planeswalker's loyalty: its loyalty counters on the battlefield, else what is printed. */
export const loyaltyOf = (cards: GameCards, object: BoardObject): string | null => {
  const counters = object.counters.loyalty;
  if (counters !== undefined && object.zone === 'battlefield') return String(counters);
  const identity = cards.identities.get(object.id);
  if (identity === undefined) return null;
  return cards.faces.get(identity.oracleId)?.loyalty ?? null;
};

/** The objects of a zone that a player owns, in the zone's order. */
export const ownedIn = (
  cards: GameCards,
  zone: readonly ObjectId[],
  player: PlayerId,
): ObjectId[] => zone.filter((id) => cards.identities.get(id)?.owner === player);

export const zoneLabel = (zone: ZoneId): string => {
  const kind = zone.includes(':') ? zone.split(':')[1] : zone;
  return kind ?? zone;
};

export const speeds = [0.25, 0.5, 1, 2, 4, 8] as const;
export type Speed = (typeof speeds)[number];

/** Milliseconds between ticker lines when playing at 1×. */
export const baseInterval = 800;
