import type { OracleId } from './ids.js';

/**
 * A run's ban list (docs/05 "Bans and restrictions", decision D12): Vintage-style, so a
 * banned card may not be in the seventy-five at all and a restricted one only once, main
 * and side together. Roadmap 5.5 gives it an audit trail and legalises decks against it;
 * the seed deck generator (5.3) and the pool query read it as it stands.
 */
export type BanStatus = 'banned' | 'restricted';
export type BanList = ReadonlyMap<OracleId, BanStatus>;

export const noBans: BanList = new Map();

/** Copies of a card the run's own list allows in a seventy-five, before any other rule. */
export const banLimit = (banList: BanList, oracleId: OracleId): number => {
  const status = banList.get(oracleId);
  return status === 'banned' ? 0 : status === 'restricted' ? 1 : Number.POSITIVE_INFINITY;
};
