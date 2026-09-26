import { type PlayerId, playerIds } from './player.js';

/**
 * Zones (CR 400).
 *
 * Magic splits zones into those each player owns and those the whole game shares.
 * Library, hand and graveyard are per player. The battlefield, stack, exile and
 * command zone are single shared zones — a permanent is on *the* battlefield, not on
 * its controller's battlefield. That matters: control-changing effects (CR 613.1b)
 * must not move an object between zones, or every "leaves the battlefield" trigger
 * would fire on a Mind Control. Instead control is a property of the object and
 * changing it moves nothing. See ADR 0002.
 */

export const playerZoneKinds = ['library', 'hand', 'graveyard'] as const;
export type PlayerZoneKind = (typeof playerZoneKinds)[number];

export const sharedZoneKinds = ['battlefield', 'stack', 'exile', 'command'] as const;
export type SharedZoneKind = (typeof sharedZoneKinds)[number];

export type ZoneKind = PlayerZoneKind | SharedZoneKind;

/** e.g. `"A:hand"`. */
export type PlayerZoneId = `${PlayerId}:${PlayerZoneKind}`;
export type ZoneId = PlayerZoneId | SharedZoneKind;

export const playerZone = (player: PlayerId, kind: PlayerZoneKind): PlayerZoneId =>
  `${player}:${kind}`;

export const allZoneIds: readonly ZoneId[] = [
  ...playerIds.flatMap((player) => playerZoneKinds.map((kind) => playerZone(player, kind))),
  ...sharedZoneKinds,
];

const sharedZoneKindSet: ReadonlySet<string> = new Set(sharedZoneKinds);

export const isSharedZone = (zone: ZoneId): zone is SharedZoneKind => sharedZoneKindSet.has(zone);

/** The player whose zone this is, or `null` for a shared zone. */
export const ownerOfZone = (zone: ZoneId): PlayerId | null =>
  isSharedZone(zone) ? null : (zone.slice(0, zone.indexOf(':')) as PlayerId);

export const kindOfZone = (zone: ZoneId): ZoneKind =>
  isSharedZone(zone) ? zone : (zone.slice(zone.indexOf(':') + 1) as PlayerZoneKind);

/**
 * Zones whose contents are hidden from at least one player (CR 400.2). The stored
 * event log always records the truth; the UI decides what to reveal (docs/06).
 */
export const isHiddenZone = (zone: ZoneId): boolean => {
  const kind = kindOfZone(zone);
  return kind === 'library' || kind === 'hand';
};

/** Zones whose order matters: library (top/bottom) and stack (LIFO). */
export const isOrderedZone = (zone: ZoneId): boolean => {
  const kind = kindOfZone(zone);
  return kind === 'library' || kind === 'stack';
};
