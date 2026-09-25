import type { PlayerView, SideView, VisibleObject } from '@mtg/engine/view';
import { objectsSeenIn } from '@mtg/engine/view';
import type { Colour } from '@mtg/shared';
import type { Weights } from './weights.js';

/**
 * The static evaluator (docs/04 "Architecture: evaluator + bounded search").
 *
 * `evaluate(view, weights)` says how good a position is **for the player whose view it
 * is**: positive is good for them, negative is good for their opponent. It is the whole
 * of the `greedy` agent's judgement and, from 4.3's search on, the leaf of every line the
 * search looks at — so it has to be cheap, and it has to be something a search can trust
 * to rank two positions that differ by one card.
 *
 * It reads **only the view**, like everything in this package (ADR 0009). Where docs/04
 * asks for something the view cannot show — the opponent's "visible burn", for instance,
 * which would need the hand — the term is left out rather than guessed at, and the
 * breakdown below says which terms exist so a reader never has to wonder.
 *
 * Most terms are symmetric: a side's life, board and cards are scored the same way for
 * either player, and the evaluation is the viewer's score minus the opponent's. Two are
 * not, because the information is not: colour coverage needs a hand to look at, and only
 * the viewer's can be read.
 */

/** Each term on its own, so a test or the tuning harness can see why a position scored as it did. */
export interface Evaluation {
  readonly total: number;
  readonly terms: {
    readonly result: number;
    readonly life: number;
    readonly board: number;
    readonly cards: number;
    readonly mana: number;
    readonly tempo: number;
    readonly threats: number;
  };
}

export const evaluate = (view: PlayerView, weights: Weights): number =>
  evaluateTerms(view, weights).total;

export const evaluateTerms = (view: PlayerView, weights: Weights): Evaluation => {
  const terms = {
    result: resultTerm(view, weights),
    life: lifeValue(view.you, weights) - lifeValue(view.opponent, weights),
    board: boardValue(view, view.you, weights) - boardValue(view, view.opponent, weights),
    cards: cardsValue(view.you, weights) - cardsValue(view.opponent, weights),
    mana: manaValue(view, view.you, weights) - manaValue(view, view.opponent, weights),
    tempo: tempoValue(view, weights),
    threats: threatsValue(view, weights),
  };
  const total =
    terms.result +
    terms.life +
    terms.board +
    terms.cards +
    terms.mana +
    terms.tempo +
    terms.threats;
  return { total, terms };
};

// --- The game's result ---

const resultTerm = (view: PlayerView, weights: Weights): number => {
  if (view.result === null) return 0;
  if (view.result.winner === null) return 0;
  return view.result.winner === view.viewer ? weights.win : -weights.win;
};

// --- Life and poison (CR 119, 704.5a, 704.5c) ---

/**
 * Linear in life, with an extra slope below the danger threshold: going from 20 to 17
 * matters less than going from 5 to 2, and an evaluator that could not tell would trade
 * its last points of life for a card as readily as its first.
 */
const lifeValue = (side: SideView, weights: Weights): number =>
  weights.life * side.life -
  weights.lifeDanger * Math.max(0, weights.dangerThreshold - side.life) -
  weights.poison * side.poison;

// --- The board ---

const permanentsOf = (view: PlayerView, side: SideView): readonly VisibleObject[] =>
  objectsSeenIn(view, side.battlefield);

const isLand = (object: VisibleObject): boolean => object.types.includes('land');

/**
 * What one creature is worth in a fight: its stats, more for power that is hard to block,
 * a little for each keyword that wins combats, and less while it is summoning sick —
 * which is to say while it cannot yet attack or tap (CR 302.6), though it can block.
 */
export const creatureValue = (object: VisibleObject, weights: Weights): number => {
  const power = Math.max(0, object.power ?? 0);
  const toughness = Math.max(0, (object.toughness ?? 0) - object.damage);
  const k = object.keywords;
  const evasive = k.flying || k.menace || k.trample;
  const fighting = [
    k.firstStrike,
    k.doubleStrike,
    k.deathtouch,
    k.lifelink,
    k.vigilance,
    k.indestructible,
    k.hexproof,
  ].filter(Boolean).length;

  const value =
    weights.creaturePower * power +
    weights.creatureToughness * toughness +
    (evasive ? weights.evasivePower * power : 0) +
    weights.combatKeyword * fighting;

  // A creature that can never attack is worth its blocking half, sick or not.
  const discount = object.summoningSick && !k.haste && !k.defender ? weights.summoningSickness : 0;
  return value * (1 - discount);
};

const boardValue = (view: PlayerView, side: SideView, weights: Weights): number => {
  let value = 0;
  for (const object of permanentsOf(view, side)) {
    if (object.isCreature) value += creatureValue(object, weights);
    else if (object.loyalty !== null) value += weights.planeswalkerLoyalty * object.loyalty;
    else if (!isLand(object)) value += weights.otherPermanent * object.manaValue;
  }
  return value;
};

// --- Cards ---

/**
 * Cards in hand, for either side — the size is public (CR 400.2) even where the contents
 * are not — and a heavy penalty for an empty library, because the next draw loses.
 */
const cardsValue = (side: SideView, weights: Weights): number =>
  weights.cardInHand * side.handSize - (side.librarySize === 0 ? weights.emptyLibrary : 0);

// --- Mana development ---

const manaValue = (view: PlayerView, side: SideView, weights: Weights): number => {
  const permanents = permanentsOf(view, side);
  const lands = permanents.filter(isLand).length;
  const developed =
    weights.land * Math.min(lands, weights.landTarget) +
    weights.landBeyondTarget * Math.max(0, lands - weights.landTarget);

  // Only the viewer's hand can be read, so only the viewer is charged for colours it
  // cannot make. Charging the opponent too would need their hand, which is the point.
  if (side.player !== view.viewer) return developed;

  const makes = new Set<string>(permanents.flatMap((object) => object.producesMana));
  const needs = new Set<Colour>(
    objectsSeenIn(view, view.you.hand).flatMap((object) => object.costColours),
  );
  const missing = [...needs].filter((colour) => !makes.has(colour)).length;
  return developed - weights.missingColour * missing;
};

// --- Tempo ---

/**
 * Mana held up with something to spend it on: untapped sources, capped by the cheapest
 * instant in hand. With no instant, untapped mana is just mana not spent, and scores
 * nothing — so tapping out for a creature costs greedy nothing here unless it had a
 * reason to wait.
 */
const tempoValue = (view: PlayerView, weights: Weights): number => {
  const instants = objectsSeenIn(view, view.you.hand).filter((object) =>
    object.types.includes('instant'),
  );
  if (instants.length === 0) return 0;
  const cheapest = Math.min(...instants.map((object) => object.manaValue));
  const untapped = permanentsOf(view, view.you).filter(
    (object) => object.producesMana.length > 0 && !object.tapped,
  ).length;
  return weights.heldMana * Math.min(untapped, Math.max(1, cheapest));
};

// --- Threats ---

/**
 * Whether a side's creatures, all attacking next turn, could deal the other side's life
 * total. Crude on purpose: it ignores blockers, and the combat solver in 4.4 is where
 * blocks get worked out properly. What it does catch is the position an evaluator must
 * never walk into — one where the opponent's board is already lethal.
 */
const threatsValue = (view: PlayerView, weights: Weights): number => {
  const potential = (side: SideView): number =>
    permanentsOf(view, side)
      .filter((object) => object.isCreature && !object.keywords.defender)
      .reduce((sum, object) => sum + Math.max(0, object.power ?? 0), 0);

  const ours = potential(view.you) >= view.opponent.life ? weights.lethalOnBoard : 0;
  const theirs = potential(view.opponent) >= view.you.life ? weights.lethalOnBoard : 0;
  return ours - theirs;
};
