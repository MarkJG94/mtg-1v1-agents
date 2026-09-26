import type {
  BottomCardsDecision,
  MulliganDecision,
  PlayerView,
  VisibleObject,
} from '@mtg/engine/view';
import { objectsSeenIn } from '@mtg/engine/view';
import type { Colour, ObjectId } from '@mtg/shared';
import { isPermanentCard } from './after-action.js';
import { creatureValue } from './evaluate.js';
import type { Weights } from './weights.js';

/**
 * The start of a game: who plays first, which hand to keep, and which cards a kept
 * mulligan sends to the bottom (docs/04 "Architecture", items 5 and 6; roadmap 4.5).
 *
 * Everything here is judged from the viewer's own hand, which the view shows, and from a
 * record of past results the agent is given — never from anything about the opponent's
 * deck, which is not the agent's to know.
 */

// --- Play or draw (CR 103.1) ---

export interface PlayDrawRecord {
  /** Games this deck played on the play against this opponent, and how many it won. */
  readonly play: { readonly games: number; readonly wins: number };
  readonly draw: { readonly games: number; readonly wins: number };
}

/** Fewer games than this on either side, and the record is not trusted at all. */
export const PLAY_DRAW_MIN_GAMES = 20;

/**
 * docs/04 item 6: play, unless the record says drawing wins more.
 *
 * "Says" means more than a higher rate: the draw must beat the play by more than chance
 * would explain, by a one-sided two-proportion test at 5%. Being on the play is worth a
 * whole turn in almost every matchup, and a record of twenty games a side can show the
 * draw ahead by luck alone — acting on that would throw the turn away for nothing.
 */
export const playOrDraw = (record?: PlayDrawRecord): 'play' | 'draw' => {
  if (record === undefined) return 'play';
  const { play, draw } = record;
  if (play.games < PLAY_DRAW_MIN_GAMES || draw.games < PLAY_DRAW_MIN_GAMES) return 'play';

  const playRate = play.wins / play.games;
  const drawRate = draw.wins / draw.games;
  const pooled = (play.wins + draw.wins) / (play.games + draw.games);
  const spread = Math.sqrt(pooled * (1 - pooled) * (1 / play.games + 1 / draw.games));
  // z at one-sided 5%. With no spread at all the two rates are equal, the ratio is NaN,
  // and NaN is greater than nothing — so it plays, as it should.
  return (drawRate - playRate) / spread > 1.645 ? 'draw' : 'play';
};

// --- What a hand would do ---

const isLand = (card: VisibleObject): boolean => card.types.includes('land');

export interface OpeningProjection {
  /** Lands the hand would have in play by the last turn projected. */
  readonly lands: number;
  /** The spells it would cast, in the order it would cast them. */
  readonly cast: readonly VisibleObject[];
  /** What those spells are worth, on the evaluator's own scale. */
  readonly board: number;
}

/**
 * What a hand would put on the table in its first `turns` turns if it drew nothing:
 * a land a turn while it has one (CR 305.2), and each turn the spells it can pay for
 * with the lands in play — the most mana's worth it can cast, in colours those lands
 * make. docs/04's "projected turn-3 board".
 *
 * Draws are left out on purpose. A hand is judged on what it holds; what it might draw
 * is the same for every hand the player could keep.
 */
export const projectOpening = (
  cards: readonly VisibleObject[],
  weights: Weights,
  turns = 3,
): OpeningProjection => {
  const lands = cards.filter(isLand);
  const waiting = cards.filter((card) => !isLand(card));
  const played: VisibleObject[] = [];
  const cast: VisibleObject[] = [];

  for (let turn = 1; turn <= turns; turn += 1) {
    const next = nextLand(lands, played, waiting);
    if (next !== undefined) played.push(next);
    const colours = new Set<string>(played.flatMap((land) => land.producesMana));
    const castable = waiting.filter(
      (card) =>
        !cast.includes(card) && card.costColours.every((colour: Colour) => colours.has(colour)),
    );
    for (const card of mostManaFor(castable, played.length)) cast.push(card);
  }

  const board = cast.reduce((sum, card) => sum + worth(card, weights), 0);
  return { lands: played.length, cast, board };
};

/** The land to play next: the one that adds the most colours the spells still need. */
const nextLand = (
  lands: readonly VisibleObject[],
  played: readonly VisibleObject[],
  spells: readonly VisibleObject[],
): VisibleObject | undefined => {
  const have = new Set<string>(played.flatMap((land) => land.producesMana));
  const need = new Set<string>(spells.flatMap((spell) => spell.costColours));
  let best: VisibleObject | undefined;
  let bestNew = -1;
  for (const land of lands) {
    if (played.includes(land)) continue;
    const adds = land.producesMana.filter((type) => need.has(type) && !have.has(type)).length;
    if (adds > bestNew) {
      best = land;
      bestNew = adds;
    }
  }
  return best;
};

/** The set of spells with the most mana value that `mana` can pay for. Hands are small. */
const mostManaFor = (spells: readonly VisibleObject[], mana: number): VisibleObject[] => {
  let best: VisibleObject[] = [];
  let bestMana = 0;
  const limit = 1 << Math.min(spells.length, 10);
  for (let mask = 1; mask < limit; mask += 1) {
    const chosen = spells.filter((_, i) => (mask >> i) & 1);
    const total = chosen.reduce((sum, card) => sum + card.manaValue, 0);
    if (total <= mana && total > bestMana) {
      best = chosen;
      bestMana = total;
    }
  }
  return best;
};

/** What a cast card is worth once it has resolved, on the evaluator's scale. */
const worth = (card: VisibleObject, weights: Weights): number => {
  if (card.isCreature) return creatureValue({ ...card, summoningSick: false }, weights);
  if (isPermanentCard(card)) return weights.otherPermanent * card.manaValue;
  return weights.spellUntargeted * card.manaValue;
};

// --- Keeping (CR 103.4) ---

/**
 * docs/04 item 5: keep a hand with two to five lands — fewer allowed as the hand shrinks
 * — that can cast something by turn two in the colours its lands make, and whose
 * projected turn-3 board clears a threshold (scaled to the size of the hand being kept);
 * never go below five cards.
 */
export const mulliganChoice = (
  view: PlayerView,
  decision: MulliganDecision,
  weights: Weights,
): 'keep' | 'mulligan' => {
  if (!decision.options.includes('mulligan')) return 'keep';
  const keeping = decision.hand.length - decision.taken;
  if (keeping <= 5) return 'keep';

  const hand = objectsSeenIn(view, decision.hand);
  const lands = hand.filter(isLand);
  const enoughLand = lands.length >= 2 && lands.length <= Math.min(5, keeping - 2);

  const colours = new Set<string>(lands.flatMap((land) => land.producesMana));
  const earlyPlay = hand.some(
    (card) =>
      !isLand(card) &&
      card.manaValue <= 2 &&
      card.costColours.every((colour) => colours.has(colour)),
  );

  const threshold = weights.keepBoard * (keeping / 7);
  const strongEnough = projectOpening(hand, weights).board >= threshold;

  return enoughLand && earlyPlay && strongEnough ? 'keep' : 'mulligan';
};

// --- Bottoming (CR 103.4b) ---

/**
 * docs/04 item 5: "the London bottoming choice keeps the best-curved subset". Every way
 * of keeping `hand − count` cards is tried — at most thirty-five, from seven — and the
 * one kept is the one whose projected board is best, less a charge for every land it
 * keeps outside two to four: too few and nothing gets cast, too many and there is nothing
 * to cast.
 */
export const bottomCards = (
  view: PlayerView,
  decision: BottomCardsDecision,
  weights: Weights,
): ObjectId[] => {
  const hand = objectsSeenIn(view, decision.from);
  const keep = hand.length - decision.count;
  if (keep <= 0) return hand.map((card) => card.id);

  let best: readonly VisibleObject[] = hand.slice(0, keep);
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const kept of subsets(hand, keep)) {
    const score = keptScore(kept, weights);
    if (score > bestScore) {
      best = kept;
      bestScore = score;
    }
  }
  return hand.filter((card) => !best.includes(card)).map((card) => card.id);
};

const keptScore = (kept: readonly VisibleObject[], weights: Weights): number => {
  const lands = kept.filter(isLand).length;
  const offCurve = Math.max(0, 2 - lands) + Math.max(0, lands - 4);
  return projectOpening(kept, weights).board - weights.land * offCurve;
};

/** Every way of choosing `size` of `items`, in order. */
const subsets = <T>(items: readonly T[], size: number): T[][] => {
  if (size === 0) return [[]];
  if (items.length < size) return [];
  const [first, ...rest] = items as [T, ...T[]];
  return [...subsets(rest, size - 1).map((subset) => [first, ...subset]), ...subsets(rest, size)];
};
