import type { CardKind, CardTags, Colour, DeckSlot, OracleId } from '@mtg/shared';

/**
 * The sideboarding agent (docs/04 "Sideboarding agent"; roadmap 4.6).
 *
 * Between games 2 and 3 of a match an agent may swap cards between its main deck and its
 * sideboard: equal numbers in and out, so 60/15 is kept. It is a plain function of data —
 * the deck, what each card is, what the opponent has been seen to play, and how each card
 * has done in this matchup — and returns a plan: the swaps, the reason for each, and the
 * two lists that result. The match runner (roadmap 5.1) applies it and stores it with the
 * match, which is what lets the UI show it.
 *
 * **How a card is scored**, in the order docs/04 gives:
 *
 * - **by its record in this matchup**, if it has been drawn in a game against this
 *   opponent's current deck: its win rate when drawn less its win rate when not, each
 *   shrunk toward the deck's win rate in the matchup by a Beta prior of twenty games
 *   (docs/05 "Statistics") — so three wins in three draws is a hint, not a verdict;
 * - **otherwise by a prior from its tags**: of the cards the opponent has been seen to
 *   play, the share this card answers (its `vs` tags against their `is` tags), measured
 *   from an even half — a card that answers nothing they play scores below one that
 *   answers most of it.
 *
 * A card with neither — no record, and no answers to offer — has no score, and is never
 * swapped on a guess. Early in a run that leaves the prior to swap answer for answer, which
 * is what it can judge: Naturalize for Doom Blade against a deck of artifacts.
 *
 * **Which swaps are made**: the best-scoring sideboard card against the worst-scoring main
 * card, while the difference beats a margin, up to `maxSwaps` pairs. A land only replaces a
 * land and a spell only a spell, so the land count holds; a spell only comes in if the
 * lands that will be left make every colour it costs; and nothing banned comes in.
 */

export interface SideboardCard {
  readonly tags: CardTags;
  readonly land: boolean;
  /** Colours in its mana cost. */
  readonly costColours: readonly Colour[];
  /** Colours it can make, for a land. */
  readonly produces: readonly Colour[];
}

/** One card's games against this opponent's current deck (docs/05 `matchupWinRate`). */
export interface MatchupRecord {
  readonly gamesDrawn: number;
  readonly winsDrawn: number;
  readonly gamesNotDrawn: number;
  readonly winsNotDrawn: number;
}

export interface SideboardSettings {
  /** docs/04: `maxSideboardSwaps`, 4 by default. */
  readonly maxSwaps: number;
  /** How much better, on the win-rate scale, a card must be to come in. */
  readonly margin: number;
  /** Games of prior toward the deck's matchup win rate (docs/05: `n0 = 20`). */
  readonly shrinkage: number;
  /** A card that answers everything the opponent plays scores `priorWeight / 2`. */
  readonly priorWeight: number;
}

export const defaultSideboardSettings: SideboardSettings = {
  maxSwaps: 4,
  margin: 0.02,
  shrinkage: 20,
  priorWeight: 0.1,
};

export interface SideboardInput {
  readonly main: readonly DeckSlot[];
  readonly side: readonly DeckSlot[];
  /** Every card in either list, and every card the opponent has been seen to play. */
  readonly cards: ReadonlyMap<OracleId, SideboardCard>;
  /** What the opponent has been seen to play, counted (docs/04 "Opponent modelling"). */
  readonly opponentSeen: readonly DeckSlot[];
  /** Games against this opponent's current deck, and how many were won. */
  readonly matchup: { readonly games: number; readonly wins: number };
  readonly records: ReadonlyMap<OracleId, MatchupRecord>;
  readonly banned: ReadonlySet<OracleId>;
  readonly settings?: Partial<SideboardSettings>;
}

export interface CardScore {
  readonly score: number;
  readonly basis: 'record' | 'tags';
}

export interface SideboardSwap {
  readonly out: OracleId;
  readonly in: OracleId;
  readonly outScore: CardScore;
  readonly inScore: CardScore;
}

export interface SideboardPlan {
  readonly swaps: readonly SideboardSwap[];
  readonly main: readonly DeckSlot[];
  readonly side: readonly DeckSlot[];
}

export const sideboard = (input: SideboardInput): SideboardPlan => {
  const settings = { ...defaultSideboardSettings, ...input.settings };
  const scoreOf = scorer(input, settings);

  const main = new Map(input.main.map((slot) => [slot.oracleId, slot.count]));
  const side = new Map(input.side.map((slot) => [slot.oracleId, slot.count]));
  const swaps: SideboardSwap[] = [];

  const ranked = (pool: ReadonlyMap<OracleId, number>, direction: 1 | -1) =>
    [...pool]
      .filter(([, count]) => count > 0)
      .map(([oracleId]) => ({ oracleId, score: scoreOf(oracleId) }))
      .filter((entry): entry is { oracleId: OracleId; score: CardScore } => entry.score !== null)
      .sort(
        (a, b) =>
          direction * (a.score.score - b.score.score) || a.oracleId.localeCompare(b.oracleId),
      );

  while (swaps.length < settings.maxSwaps) {
    const swap = bestSwap(
      ranked(side, -1).filter((entry) => !input.banned.has(entry.oracleId)),
      ranked(main, 1),
      main,
      input.cards,
      settings.margin,
    );
    if (swap === null) break;
    swaps.push(swap);
    move(main, swap.out, -1);
    move(main, swap.in, 1);
    move(side, swap.in, -1);
    move(side, swap.out, 1);
  }

  return { swaps, main: slots(main), side: slots(side) };
};

/** The first pair — best card in, worst card out — that beats the margin and keeps the deck castable. */
const bestSwap = (
  ins: readonly { oracleId: OracleId; score: CardScore }[],
  outs: readonly { oracleId: OracleId; score: CardScore }[],
  main: ReadonlyMap<OracleId, number>,
  cards: ReadonlyMap<OracleId, SideboardCard>,
  margin: number,
): SideboardSwap | null => {
  for (const coming of ins) {
    for (const going of outs) {
      if (coming.score.score - going.score.score <= margin) break;
      const incoming = cards.get(coming.oracleId);
      const outgoing = cards.get(going.oracleId);
      if (incoming === undefined || outgoing === undefined) continue;
      if (incoming.land !== outgoing.land) continue;
      if (!castableAfter(main, cards, going.oracleId, coming.oracleId)) continue;
      return {
        out: going.oracleId,
        in: coming.oracleId,
        outScore: going.score,
        inScore: coming.score,
      };
    }
  }
  return null;
};

/**
 * Whether the swap keeps the deck castable: the incoming spell has lands for every colour
 * it costs once the swap is made, and no spell that had them before loses them — taking a
 * land out must not strand a spell. A spell the deck could not cast before is not this
 * swap's doing, and does not stop it.
 */
const castableAfter = (
  main: ReadonlyMap<OracleId, number>,
  cards: ReadonlyMap<OracleId, SideboardCard>,
  out: OracleId,
  incoming: OracleId,
): boolean => {
  const after = new Map(main);
  move(after, out, -1);
  move(after, incoming, 1);
  const before = coloursMade(main, cards);
  const now = coloursMade(after, cards);
  const castable = (card: SideboardCard, made: ReadonlySet<Colour>) =>
    card.costColours.every((colour) => made.has(colour));

  const coming = cards.get(incoming);
  if (coming !== undefined && !coming.land && !castable(coming, now)) return false;
  for (const [oracleId, count] of after) {
    const card = cards.get(oracleId);
    if (count === 0 || card === undefined || card.land) continue;
    if (castable(card, before) && !castable(card, now)) return false;
  }
  return true;
};

const coloursMade = (
  deck: ReadonlyMap<OracleId, number>,
  cards: ReadonlyMap<OracleId, SideboardCard>,
): Set<Colour> => {
  const made = new Set<Colour>();
  for (const [oracleId, count] of deck) {
    const card = cards.get(oracleId);
    if (count > 0 && card?.land === true) for (const colour of card.produces) made.add(colour);
  }
  return made;
};

/** A card's score in this matchup: its record if it has one, its tags if they say anything. */
const scorer = (input: SideboardInput, settings: SideboardSettings) => {
  const mean = input.matchup.games > 0 ? input.matchup.wins / input.matchup.games : 0.5;
  const shrunk = (wins: number, games: number) =>
    (wins + settings.shrinkage * mean) / (games + settings.shrinkage);

  // What the opponent is, by the share of their seen nonland cards of each kind.
  const seen = input.opponentSeen.flatMap((slot) => {
    const card = input.cards.get(slot.oracleId);
    return card === undefined || card.land ? [] : [{ is: card.tags.is, count: slot.count }];
  });
  const seenTotal = seen.reduce((sum, entry) => sum + entry.count, 0);
  const shareAnswered = (vs: readonly CardKind[]): number =>
    seen
      .filter((entry) => entry.is.some((kind) => vs.includes(kind)))
      .reduce((sum, entry) => sum + entry.count, 0) / seenTotal;

  return (oracleId: OracleId): CardScore | null => {
    const record = input.records.get(oracleId);
    if (record !== undefined && record.gamesDrawn > 0) {
      const score =
        shrunk(record.winsDrawn, record.gamesDrawn) -
        shrunk(record.winsNotDrawn, record.gamesNotDrawn);
      return { score, basis: 'record' };
    }
    const vs = input.cards.get(oracleId)?.tags.vs ?? [];
    if (vs.length === 0 || seenTotal === 0) return null;
    return { score: settings.priorWeight * (shareAnswered(vs) - 0.5), basis: 'tags' };
  };
};

const move = (pool: Map<OracleId, number>, oracleId: OracleId, by: number): void => {
  const count = (pool.get(oracleId) ?? 0) + by;
  if (count === 0) pool.delete(oracleId);
  else pool.set(oracleId, count);
};

const slots = (pool: ReadonlyMap<OracleId, number>): DeckSlot[] =>
  [...pool]
    .filter(([, count]) => count > 0)
    .map(([oracleId, count]) => ({ oracleId, count }))
    .sort((a, b) => a.oracleId.localeCompare(b.oracleId));
