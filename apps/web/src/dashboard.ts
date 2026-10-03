import type { CardSummary } from '@mtg/shared';

/**
 * What the run dashboard works out from what the API answers (docs/08 "Run dashboard"):
 * which cycle a ban took effect in, a deck grouped by type, its mana curve and colours,
 * which agent a ban would catch, and how a card's Δ reads. Pure, so each is tested alone.
 */

export interface Slot {
  readonly oracleId: string;
  readonly count: number;
}

export interface Deck {
  readonly main: readonly Slot[];
  readonly side: readonly Slot[];
}

// --- Bans on the timeline ---

/**
 * The cycle a ban took effect in, from the game it is stamped with: `…:cycle-N:start` as
 * cycle N began, `…:cycle-N:match-M:game-G` after a game of it (docs/05), `<run>:created`
 * from the start (cycle 0). `null` while it is pending.
 */
export const cycleOfGame = (gameId: string | null): number | null => {
  if (gameId === null) return null;
  if (gameId.endsWith(':created')) return 0;
  const match = /:cycle-(\d+)(?::|$)/.exec(gameId);
  return match?.[1] === undefined ? null : Number(match[1]);
};

export interface BanEventLike {
  readonly oracleId: string;
  readonly action: 'ban' | 'restrict' | 'unban';
  readonly appliedAfterGameId: string | null;
}

/** Applied edits grouped by the cycle they took effect in, oldest first. */
export const banMarkers = <E extends BanEventLike>(
  history: readonly E[],
): { cycle: number; events: E[] }[] => {
  const byCycle = new Map<number, E[]>();
  for (const event of history) {
    const cycle = cycleOfGame(event.appliedAfterGameId);
    if (cycle === null) continue;
    byCycle.set(cycle, [...(byCycle.get(cycle) ?? []), event]);
  }
  return [...byCycle].sort(([a], [b]) => a - b).map(([cycle, events]) => ({ cycle, events }));
};

// --- A deck, read ---

/** The order a decklist reads in; a card goes in the first of these its type line has. */
export const typeGroups = [
  'Creature',
  'Planeswalker',
  'Battle',
  'Land',
  'Instant',
  'Sorcery',
  'Artifact',
  'Enchantment',
  'Other',
] as const;
export type TypeGroup = (typeof typeGroups)[number];

/** A card's group by its front face's types: "Artifact Creature" is a creature, "Artifact Land" a land. */
export const groupOf = (typeLine: string): TypeGroup => {
  const front = (typeLine.split(' // ')[0] ?? typeLine).split(' — ')[0] ?? '';
  const words = new Set(front.split(/\s+/));
  return typeGroups.find((group) => words.has(group)) ?? 'Other';
};

export interface GroupedCard<F> {
  readonly oracleId: string;
  readonly count: number;
  readonly card: F | undefined;
}

/**
 * A zone's cards in decklist order: by group, then by mana value and name. A card not yet
 * looked up goes in Other, by its id, until it is.
 */
export const groupDeck = <F extends Pick<CardSummary, 'name' | 'typeLine' | 'manaValue'>>(
  slots: readonly Slot[],
  facts: ReadonlyMap<string, F>,
): { group: TypeGroup; count: number; cards: GroupedCard<F>[] }[] => {
  const groups = new Map<TypeGroup, GroupedCard<F>[]>();
  for (const slot of slots) {
    const card = facts.get(slot.oracleId);
    const group = card === undefined ? 'Other' : groupOf(card.typeLine);
    groups.set(group, [...(groups.get(group) ?? []), { ...slot, card }]);
  }
  return typeGroups.flatMap((group) => {
    const cards = groups.get(group);
    if (cards === undefined) return [];
    cards.sort(
      (a, b) =>
        (a.card?.manaValue ?? 99) - (b.card?.manaValue ?? 99) ||
        (a.card?.name ?? a.oracleId).localeCompare(b.card?.name ?? b.oracleId),
    );
    return [{ group, count: cards.reduce((sum, each) => sum + each.count, 0), cards }];
  });
};

/** Mana curve buckets: 0 to 6, then 7 and more. */
export const curveBuckets = ['0', '1', '2', '3', '4', '5', '6', '7+'] as const;

/** Copies of the main deck's spells at each mana value; lands are no part of the curve. */
export const manaCurve = (
  slots: readonly Slot[],
  facts: ReadonlyMap<string, Pick<CardSummary, 'typeLine' | 'manaValue'>>,
): number[] => {
  const curve = curveBuckets.map(() => 0);
  for (const slot of slots) {
    const card = facts.get(slot.oracleId);
    if (card === undefined || groupOf(card.typeLine) === 'Land') continue;
    const bucket = Math.min(7, Math.max(0, Math.floor(card.manaValue)));
    curve[bucket] = (curve[bucket] ?? 0) + slot.count;
  }
  return curve;
};

export const colourOrder = ['W', 'U', 'B', 'R', 'G'] as const;
export type ColourSymbol = (typeof colourOrder)[number];

/**
 * Coloured mana symbols in a mana cost: `{R}` one red, `{W/U}` one of each (either pays),
 * `{G/P}` one green; generic, colourless, `{X}` and snow none.
 */
export const pipsOf = (manaCost: string | null): Record<ColourSymbol, number> => {
  const pips: Record<ColourSymbol, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const [, symbol] of (manaCost ?? '').matchAll(/\{([^}]+)\}/g)) {
    for (const part of (symbol ?? '').split('/')) {
      if ((colourOrder as readonly string[]).includes(part)) pips[part as ColourSymbol] += 1;
    }
  }
  return pips;
};

/** The colours the main deck asks for: every copy's coloured symbols, added up. */
export const colourShare = (
  slots: readonly Slot[],
  facts: ReadonlyMap<string, Pick<CardSummary, 'manaCost'>>,
): Record<ColourSymbol, number> => {
  const total: Record<ColourSymbol, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const slot of slots) {
    const pips = pipsOf(facts.get(slot.oracleId)?.manaCost ?? null);
    for (const colour of colourOrder) total[colour] += pips[colour] * slot.count;
  }
  return total;
};

// --- What a ban would do ---

/** Copies of a card in a seventy-five, main and side together (the list's rule, docs/05). */
export const held = (deck: Deck, oracleId: string): number =>
  [...deck.main, ...deck.side]
    .filter((slot) => slot.oracleId === oracleId)
    .reduce((sum, slot) => sum + slot.count, 0);

export type BanStatus = 'banned' | 'restricted';

/**
 * For each agent, how many copies it holds and how many the status allows: an agent over
 * the limit is the one a ban legalises (docs/08: "which agent is affected").
 */
export const affected = (
  decks: { readonly A: Deck; readonly B: Deck },
  oracleId: string,
  status: BanStatus,
): { agent: 'A' | 'B'; held: number; allowed: number }[] => {
  const allowed = status === 'banned' ? 0 : 1;
  return (['A', 'B'] as const)
    .map((agent) => ({ agent, held: held(decks[agent], oracleId), allowed }))
    .filter((each) => each.held > allowed);
};

// --- A card's Δ ---

/**
 * A card's Δ — its deck's win rate with it drawn less without — in percentage points,
 * with its sign as a glyph so the chip is not read by colour alone (docs/08).
 */
export const formatDelta = (
  delta: number,
): { text: string; glyph: '▲' | '▼' | '•'; sign: 1 | -1 | 0 } => {
  const points = Math.round(delta * 1000) / 10;
  if (points === 0) return { text: '0.0', glyph: '•', sign: 0 };
  return points > 0
    ? { text: `+${points.toFixed(1)}`, glyph: '▲', sign: 1 }
    : { text: `−${Math.abs(points).toFixed(1)}`, glyph: '▼', sign: -1 };
};
