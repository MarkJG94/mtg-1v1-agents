import type { CardFace, CardSummary } from '@mtg/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from './api.js';

/**
 * Cards a page holds the ids of — decks, changes, bans — by id, looked up once each: the
 * query is keyed by the sorted ids, so the same set asked twice is one request, and a
 * card looked up keeps its facts while a bigger set loads.
 */
export const useCardFacts = (oracleIds: readonly string[]): ReadonlyMap<string, CardFace> => {
  const ids = [...new Set(oracleIds)].sort();
  const query = useQuery({
    queryKey: ['card-facts', ids],
    queryFn: () => api.lookupCards(ids),
    enabled: ids.length > 0,
    staleTime: Number.POSITIVE_INFINITY,
    placeholderData: (previous) => previous,
  });
  return new Map((query.data ?? []).map((card) => [card.oracleId, card]));
};

/** A card's name, or a short form of its id until it is looked up. */
export const nameOf = (facts: ReadonlyMap<string, CardSummary>, oracleId: string): string =>
  facts.get(oracleId)?.name ?? `${oracleId.slice(0, 8)}…`;
