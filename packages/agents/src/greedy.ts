import type {
  BottomCardsDecision,
  Decision,
  DecisionResponse,
  DeclareAttackersDecision,
  DeclareBlockersDecision,
  DiscardDecision,
  MulliganDecision,
  PlayerView,
  PriorityAction,
  PriorityDecision,
  VisibleObject,
} from '@mtg/engine/view';
import { objectsSeenIn } from '@mtg/engine/view';
import type { ObjectId } from '@mtg/shared';
import { afterAction, isPermanentCard } from './after-action.js';
import { type Block, withoutLoneMenaceBlocks } from './blocks.js';
import { creatureValue, evaluate } from './evaluate.js';
import type { PlayAgent } from './play-agent.js';
import { defaultWeights, type Weights } from './weights.js';

/**
 * The `greedy` level (docs/04): the evaluator, and no search.
 *
 * At a priority decision it scores every legal action by how much better the position
 * looks just after taking it, and takes the best — or passes, if nothing is better than
 * doing nothing. "Just after" is `afterAction`, which knows what an action visibly moves
 * and nothing about what a spell *does*, because finding that out needs the engine and
 * this package may not call it (ADR 0009). The part it cannot see is priced by an explicit
 * prior from the weights file — a spell aimed at an opposing creature is worth something
 * in proportion to that creature, one aimed at the opponent in proportion to its cost —
 * so the guess is written down, tunable, and replaced wholesale by 4.3's search rather
 * than hidden somewhere in the arithmetic.
 *
 * Every other decision kind gets a rule of thumb from docs/04: keep a hand with enough
 * lands and something to cast, attack with what cannot die for nothing, block what can be
 * killed for free, chump only when the damage would be lethal. The combat solver in 4.4
 * replaces the combat rules; they are here so that greedy can play a whole game rather
 * than stop at the first question its evaluator has no opinion on.
 *
 * Deterministic: it never draws from the generator. Ties go to the first option, which for
 * a priority decision is always passing.
 */
export const greedyAgent = (weights: Weights = defaultWeights): PlayAgent => ({
  level: 'greedy',
  decide: (view: PlayerView, decision: Decision): DecisionResponse => {
    switch (decision.kind) {
      case 'priority':
        return { kind: 'priority', action: bestAction(view, decision, weights) };
      case 'mulligan':
        return { kind: 'mulligan', action: mulliganChoice(view, decision) };
      case 'bottomCards':
        return { kind: 'bottomCards', cards: worstCards(view, decision, weights) };
      case 'discard':
        return { kind: 'discard', cards: worstCards(view, decision, weights) };
      case 'declareAttackers':
        return { kind: 'declareAttackers', attackers: attacks(view, decision, weights) };
      case 'declareBlockers':
        return { kind: 'declareBlockers', blocks: blocks(view, decision, weights) };
      case 'orderBlockers':
        // Weakest first, so the attacker's damage kills as many of them as it can.
        return {
          kind: 'orderBlockers',
          order: [...decision.blockers].sort(
            (a, b) => toughnessLeft(view, a) - toughnessLeft(view, b),
          ),
        };
      case 'orderTriggers':
        return { kind: 'orderTriggers', order: decision.triggers };
      case 'chooseOption':
        return { kind: 'chooseOption', chosen: mostValuable(view, decision.options, weights) };
      case 'chooseReplacement':
        return { kind: 'chooseReplacement', effect: decision.options[0] ?? 0 };
    }
  },
});

// --- Priority ---

/** The action whose resulting position scores highest; passing unless something beats it. */
const bestAction = (
  view: PlayerView,
  decision: PriorityDecision,
  weights: Weights,
): PriorityAction => {
  const now = evaluate(view, weights);
  let best: PriorityAction = { kind: 'pass' };
  let bestGain = 0;
  for (const action of decision.options) {
    if (action.kind === 'pass') continue;
    const gain = evaluate(afterAction(view, action), weights) - now + prior(view, action, weights);
    if (gain > bestGain) {
      best = action;
      bestGain = gain;
    }
  }
  return best;
};

/**
 * What greedy credits an action with for the part `afterAction` cannot see: what a spell
 * or ability actually does. See the weights file for each term.
 */
export const prior = (view: PlayerView, action: PriorityAction, weights: Weights): number => {
  if (action.kind === 'activateLoyalty') return weights.loyaltyActivation;
  if (action.kind !== 'cast') return 0;

  const card = view.objects.get(action.object);
  if (card === undefined) return 0;
  if (action.targets.length === 0) {
    return isPermanentCard(card) ? 0 : weights.spellUntargeted * card.manaValue;
  }

  let credit = 0;
  for (const target of action.targets) {
    if (target.kind === 'player') {
      if (target.player !== view.viewer) {
        credit += weights.spellAtOpponent * Math.max(1, card.manaValue);
      }
      continue;
    }
    const object = view.objects.get(target.object);
    if (object === undefined) continue;
    const theirs = object.controller !== view.viewer;
    const worth = object.isCreature
      ? creatureValue(object, weights)
      : weights.otherPermanent * object.manaValue;
    credit += (theirs ? weights.spellAtOpponentCreature : weights.spellAtOwnCreature) * worth;
  }
  return credit;
};

// --- Opening hands (CR 103.4) ---

const isLand = (object: VisibleObject): boolean => object.types.includes('land');

/**
 * docs/04's rule: keep a hand with two to five lands — fewer allowed as the hand shrinks —
 * that can cast something by turn two in the colours its lands make, and never go below
 * five cards.
 */
const mulliganChoice = (view: PlayerView, decision: MulliganDecision): 'keep' | 'mulligan' => {
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

  return enoughLand && earlyPlay ? 'keep' : 'mulligan';
};

// --- Getting rid of cards ---

/**
 * The cards worth least, for putting on the bottom after a mulligan or discarding to hand
 * size. Lands are worth a lot until there are enough of them, counting the ones already on
 * the battlefield; after that, very little. A spell is worth less the more it costs,
 * because a hand that cannot cast it is holding a blank.
 */
const worstCards = (
  view: PlayerView,
  decision: BottomCardsDecision | DiscardDecision,
  weights: Weights,
): readonly ObjectId[] => {
  const inPlay = objectsSeenIn(view, view.you.battlefield).filter(isLand).length;
  let landsKept = inPlay;
  const scored = objectsSeenIn(view, decision.from)
    .map((card) => ({ card, keep: 0 }))
    // Cheaper spells and lands first, so the land count is spent on the lands kept.
    .sort((a, b) => a.card.manaValue - b.card.manaValue);

  for (const entry of scored) {
    if (isLand(entry.card)) {
      entry.keep = landsKept < weights.landTarget ? 10 : 0.1;
      landsKept += 1;
    } else {
      entry.keep = 5 - entry.card.manaValue * 0.5;
    }
  }
  return [...scored]
    .sort((a, b) => a.keep - b.keep)
    .slice(0, decision.count)
    .map((entry) => entry.card.id);
};

// --- Combat ---

const toughnessLeft = (view: PlayerView, id: ObjectId): number => {
  const object = view.objects.get(id);
  return object === undefined ? 0 : (object.toughness ?? 0) - object.damage;
};

const strikesFirst = (object: VisibleObject): boolean =>
  object.keywords.firstStrike || object.keywords.doubleStrike;

/** Whether `a`'s combat damage alone would destroy `b` (CR 702.2 for deathtouch). */
const wouldKill = (a: VisibleObject, b: VisibleObject): boolean => {
  if (b.keywords.indestructible) return false;
  const power = a.power ?? 0;
  if (power <= 0) return false;
  return a.keywords.deathtouch || power >= (b.toughness ?? 0) - b.damage;
};

/** Whether `a` dies fighting `b`, allowing for first strike killing it before it swings. */
const dies = (a: VisibleObject, b: VisibleObject): boolean => {
  if (!wouldKill(b, a)) return false;
  // If `a` strikes first and kills `b` outright, `b` never deals its damage (CR 510.4).
  return !(strikesFirst(a) && !strikesFirst(b) && wouldKill(a, b));
};

const canMeet = (attacker: VisibleObject, blocker: VisibleObject): boolean =>
  !attacker.keywords.flying || blocker.keywords.flying || blocker.keywords.reach;

/**
 * Attack with what cannot be blocked to its death, or whose only deaths are trades worth
 * making — and with everything if the opponent has nothing that can block. Always the
 * defending player, never a planeswalker: choosing between them is the combat solver's.
 */
const attacks = (
  view: PlayerView,
  decision: DeclareAttackersDecision,
  weights: Weights,
): { attacker: ObjectId; defender: DeclareAttackersDecision['defenders'][number] }[] => {
  const defender = decision.defenders.find((target) => target.kind === 'player');
  if (defender === undefined) return [];

  const blockers = objectsSeenIn(view, view.opponent.battlefield).filter(
    (object) => object.isCreature && !object.tapped,
  );

  return objectsSeenIn(view, decision.legal)
    .filter((attacker) => (attacker.power ?? 0) > 0)
    .filter((attacker) => {
      const killers = blockers.filter((b) => canMeet(attacker, b) && dies(attacker, b));
      return killers.every(
        (killer) =>
          dies(killer, attacker) &&
          creatureValue(killer, weights) >= creatureValue(attacker, weights),
      );
    })
    .map((attacker) => ({ attacker: attacker.id, defender }));
};

/**
 * Block to kill an attacker for free first, then to stop damage for free, then to trade
 * down; chump only when what gets through would otherwise be lethal. Never a lone block on
 * a creature with menace (CR 702.110b).
 */
const blocks = (view: PlayerView, decision: DeclareBlockersDecision, weights: Weights): Block[] => {
  const used = new Set<ObjectId>();
  const chosen: Block[] = [];
  const unblocked = new Set<ObjectId>();

  const attackers = [...objectsSeenIn(view, decision.attackers)].sort(
    (a, b) => (b.power ?? 0) - (a.power ?? 0),
  );
  const candidatesFor = (attacker: VisibleObject): VisibleObject[] => [
    ...objectsSeenIn(
      view,
      decision.canBlock
        .filter((entry) => !used.has(entry.blocker) && entry.attackers.includes(attacker.id))
        .map((entry) => entry.blocker),
    ),
  ];

  for (const attacker of attackers) {
    if (attacker.keywords.menace) {
      unblocked.add(attacker.id);
      continue;
    }
    const candidates = candidatesFor(attacker);
    const free = candidates.filter((b) => !dies(b, attacker));
    const pick =
      free.find((b) => dies(attacker, b)) ??
      free.sort((a, b) => creatureValue(a, weights) - creatureValue(b, weights))[0] ??
      candidates.find(
        (b) => dies(attacker, b) && creatureValue(b, weights) <= creatureValue(attacker, weights),
      );
    if (pick === undefined) {
      unblocked.add(attacker.id);
      continue;
    }
    used.add(pick.id);
    chosen.push({ blocker: pick.id, blocking: [attacker.id] });
  }

  // Chump blocks, biggest attacker first, only while what is left would kill.
  const incoming = (): number =>
    attackers
      .filter((attacker) => unblocked.has(attacker.id))
      .reduce((sum, attacker) => sum + Math.max(0, attacker.power ?? 0), 0);

  for (const attacker of attackers) {
    if (incoming() < view.you.life) break;
    if (!unblocked.has(attacker.id) || attacker.keywords.menace) continue;
    const cheapest = candidatesFor(attacker).sort(
      (a, b) => creatureValue(a, weights) - creatureValue(b, weights),
    )[0];
    if (cheapest === undefined) continue;
    used.add(cheapest.id);
    unblocked.delete(attacker.id);
    chosen.push({ blocker: cheapest.id, blocking: [attacker.id] });
  }

  return withoutLoneMenaceBlocks(view, chosen);
};

// --- Everything else ---

/** For the legend rule (CR 704.5j): keep the copy that is worth most as it stands. */
const mostValuable = (
  view: PlayerView,
  options: readonly ObjectId[],
  weights: Weights,
): ObjectId => {
  const worth = (id: ObjectId): number => {
    const object = view.objects.get(id);
    if (object === undefined) return 0;
    if (object.isCreature) return creatureValue(object, weights);
    return (object.loyalty ?? 0) + (object.tapped ? 0 : 0.5);
  };
  return [...options].sort((a, b) => worth(b) - worth(a))[0] ?? (options[0] as ObjectId);
};
