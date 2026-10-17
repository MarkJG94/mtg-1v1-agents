import {
  type Colour,
  type EventTarget,
  isMainPhase,
  type ObjectId,
  type PlayerId,
  playerZone,
} from '@mtg/shared';
import {
  canPayLife,
  choose,
  discardCandidates,
  sacrificeCandidates,
} from './cards/additional-cost.js';
import { reducedCost } from './cards/cost-reduction.js';
import type { AdditionalCost, CostReduction, TargetSpec } from './cards/definition.js';
import { matchesFilter } from './cards/evaluate.js';
import type { ManaAbility } from './mana/ability.js';
import type { ManaCost } from './mana/cost.js';
import { canPayFromSources, type PotentialMana } from './mana/payment.js';
import { potentialManaFor } from './mana/potential.js';

export { potentialManaFor };

import { legalLoyaltyAbilities } from './planeswalker.js';
import { isStackEmpty, splitSecondActive } from './stack-query.js';
import type { GameState } from './state/game-state.js';
import { isGameOver } from './state/game-state.js';
import { getObject, objectsIn } from './state/update.js';
import { allTargets, canBeTargeted } from './targeting.js';
import { landsRemainingThisTurn } from './turn/land.js';

/**
 * `legalActions` — the single source of truth for what a player may do right now
 * (docs/02). Nothing else decides legality, so the AI never has to and a fuzzer can pick
 * uniformly from the result. The invariant docs/09 asks for is that it never offers an
 * action the engine would then reject.
 *
 * What a card *is* — whether it is a land, what it costs, whether it is sorcery-speed —
 * comes from its card script, so this reads it through `CardInfoSource`. Roadmap 2.1
 * implements that over real definitions; until then a caller supplies one, which is what
 * the tests do.
 */

export interface CardInfo {
  readonly isLand: boolean;
  readonly manaCost: ManaCost;
  /** Sorceries, creatures and other non-instants: only in your own main phase. */
  readonly sorcerySpeed: boolean;
  /** The spell's colours, which decide what protection stops it. */
  readonly colours: readonly Colour[];
  /** What the spell ability targets (CR 601.2c), so the choices can be enumerated. */
  readonly targets: readonly TargetSpec[];
  /** What it costs beyond its mana (CR 118.8), whose payments are enumerated too. */
  readonly additionalCost?: AdditionalCost;
  /** What its own text takes off its cost (CR 601.2f), counted as it would be cast. */
  readonly costReduction?: CostReduction;
}

export interface CardInfoSource {
  /** `null` for a card the engine has no script for, which is therefore unplayable. */
  infoFor(state: GameState, id: ObjectId): CardInfo | null;
  /** Mana abilities of permanents this player controls; used for cost payability. */
  manaAbilitiesFor?(state: GameState, player: PlayerId): readonly ManaAbility[];
}

export type LegalAction =
  | { readonly kind: 'pass' }
  | { readonly kind: 'playLand'; readonly object: ObjectId }
  | {
      readonly kind: 'cast';
      readonly object: ObjectId;
      readonly cost: ManaCost;
      /**
       * The targets this particular casting would choose, in the order the spell's specs
       * declare them. One entry per legal combination, so a burn spell with three legal
       * targets appears as three actions rather than one with a choice still to make.
       */
      readonly targets: readonly EventTarget[];
      /**
       * How this casting pays an additional cost (CR 601.2b): the permanents it sacrifices
       * and the cards it discards, chosen as part of the action like the targets are.
       * Absent for a spell that has no such cost.
       */
      readonly sacrifice?: readonly ObjectId[];
      readonly discard?: readonly ObjectId[];
      /** The life it pays (CR 119.4), so an agent that sees only the action can price it. */
      readonly life?: number;
    }
  /** A planeswalker's loyalty ability (CR 606). Its cost is counters, not mana. */
  | {
      readonly kind: 'activateLoyalty';
      readonly object: ObjectId;
      readonly ability: string;
      readonly cost: number;
    };

/** Whether a land may be played right now (CR 305.1). */
const canPlayLandNow = (state: GameState, player: PlayerId): boolean =>
  state.activePlayer === player &&
  isMainPhase(state.step) &&
  isStackEmpty(state) &&
  landsRemainingThisTurn(state, player) > 0;

/** Whether a spell of this speed may be cast right now (CR 307.1, 601.3a). */
const canCastNow = (state: GameState, player: PlayerId, sorcerySpeed: boolean): boolean =>
  !sorcerySpeed ||
  (state.activePlayer === player && isMainPhase(state.step) && isStackEmpty(state));

export const legalActions = (
  state: GameState,
  player: PlayerId,
  cards: CardInfoSource,
): readonly LegalAction[] => {
  // Only the player with priority acts, and a finished game has no actions at all.
  if (isGameOver(state) || state.priority !== player) return [];

  // Passing is always available to whoever holds priority (CR 117.4).
  const actions: LegalAction[] = [{ kind: 'pass' }];

  // While a split-second spell waits, nothing else can be cast or activated (CR 702.61a).
  if (splitSecondActive(state)) return actions;

  // Loyalty abilities need no card script: what they cost is on the permanent itself.
  for (const { source, ability } of legalLoyaltyAbilities(state, player)) {
    actions.push({
      kind: 'activateLoyalty',
      object: source,
      ability: ability.id,
      cost: ability.cost,
    });
  }

  // Priced lazily: working out what the board could still tap for means walking every
  // permanent, and most priority grants are answered without anyone casting anything —
  // an empty hand, or a hand of nothing but lands in a step where lands cannot be played.
  const pool = state.players[player].manaPool;
  let potential: readonly PotentialMana[] | null = null;
  const payable = new Map<ManaCost, boolean>();
  const targetings = new Map<readonly TargetSpec[], readonly (readonly EventTarget[])[]>();
  const canPay = (cost: ManaCost): boolean => {
    const known = payable.get(cost);
    if (known !== undefined) return known;
    potential ??= potentialManaFor(state, player, cards.manaAbilitiesFor?.(state, player) ?? []);
    // Cards come by their cost from their definition, so four copies of one card in hand
    // share the object this is keyed on and the solver runs once for all of them.
    const answer = canPayFromSources(pool, potential, cost, { life: state.players[player].life });
    payable.set(cost, answer);
    return answer;
  };

  for (const id of objectsIn(state, playerZone(player, 'hand'))) {
    const info = cards.infoFor(state, id);
    if (!info) continue;

    if (info.isLand) {
      // Playing a land is a special action, not a spell: no cost, no stack (CR 115.2a).
      if (canPlayLandNow(state, player)) actions.push({ kind: 'playLand', object: id });
      continue;
    }

    if (!canCastNow(state, player, info.sorcerySpeed)) continue;
    // The cost as it would be paid now. A reduced cost is a new object each time, so the
    // payability cache below simply misses for it; the printed one still shares.
    const cost = reducedCost(state, player, id, info.manaCost, info.costReduction);
    if (!canPay(cost)) continue;

    // Four copies of one card in hand ask the same question, and the answer depends only
    // on the board — so the enumeration is keyed on the spec list, which comes from the
    // definition and is therefore the same object for every copy.
    let choices = targetings.get(info.targets);
    if (choices === undefined) {
      choices = targetChoices(state, player, id, info);
      targetings.set(info.targets, choices);
    }
    if (info.additionalCost === undefined) {
      for (const targets of choices) {
        actions.push({ kind: 'cast', object: id, cost, targets });
      }
      continue;
    }
    actions.push(...withAdditionalCost(state, player, id, cost, info.additionalCost, choices));
  }

  return actions;
};

/**
 * How many castings of one spell are offered when its targets can be chosen several ways.
 *
 * A cap rather than a complete enumeration, because the combinations multiply: a spell
 * with two targets on a board of ten permanents has ninety of them, and a search that had
 * to score all ninety would spend the whole turn on one card. Truncating **under-reports**,
 * which is the direction this file is already committed to — every action offered is one
 * the engine will accept, and a play that is legal but not offered costs a better line
 * rather than a crash.
 */
const MOST_TARGETINGS = 24;

/**
 * The castings of a spell with an additional cost: each targeting with each way of paying
 * it, up to the same cap targetings have. None at all when it cannot be paid — too few
 * creatures to sacrifice, too few other cards to discard, too little life (CR 601.2b).
 *
 * A permanent that is one of the spell's own targets is not offered as its sacrifice.
 * Sacrificing it is legal and leaves the spell nothing to do (CR 608.2b), so leaving it
 * out under-reports by moves that only throw a card away.
 */
const withAdditionalCost = (
  state: GameState,
  player: PlayerId,
  id: ObjectId,
  manaCost: ManaCost,
  cost: AdditionalCost,
  targetings: readonly (readonly EventTarget[])[],
): readonly LegalAction[] => {
  if (!canPayLife(state, player, cost)) return [];
  const sacrifices = choose(
    sacrificeCandidates(state, player, id, cost),
    cost.sacrifice?.count ?? 0,
    MOST_TARGETINGS,
  );
  const discards = choose(discardCandidates(state, player, id), cost.discard ?? 0, MOST_TARGETINGS);

  const actions: LegalAction[] = [];
  for (const targets of targetings) {
    const aimedAt = new Set(
      targets.flatMap((target) => (target.kind === 'object' ? [target.object] : [])),
    );
    for (const sacrifice of sacrifices) {
      if (sacrifice.some((each) => aimedAt.has(each))) continue;
      for (const discard of discards) {
        if (actions.length >= MOST_TARGETINGS) return actions;
        actions.push({
          kind: 'cast',
          object: id,
          cost: manaCost,
          targets,
          ...(sacrifice.length > 0 ? { sacrifice } : {}),
          ...(discard.length > 0 ? { discard } : {}),
          ...((cost.life ?? 0) > 0 ? { life: cost.life } : {}),
        });
      }
    }
  }
  return actions;
};

/**
 * Every way this spell could have its targets chosen, or `[[]]` for one that has none.
 *
 * Targets are chosen as the spell is cast (CR 601.2c), and the engine has no separate
 * "now choose targets" decision — so the choice has to be part of the action rather than
 * something answered afterwards. Each combination is checked exactly the way casting will
 * check it, filter and targetability both, so an offered action cannot be refused.
 *
 * A spell whose targets *must* be chosen and cannot legally be is not offered at all
 * (CR 601.2c): "destroy target creature" with no creature on the board is not castable,
 * and offering it with an empty list would be offering an illegal cast.
 */
const targetChoices = (
  state: GameState,
  player: PlayerId,
  source: ObjectId,
  info: CardInfo,
): readonly (readonly EventTarget[])[] => {
  if (info.targets.length === 0) return [[]];

  const card = { controller: player, colours: info.colours };
  const candidates = allTargets(state).filter((target) => canBeTargeted(state, target, card).legal);
  const context = { source, controller: player, targets: {}, x: 0 };

  // One list of candidates per slot: a spec taking two targets contributes two slots that
  // draw from the same pool, and the duplicate check below keeps them distinct.
  const slots: (readonly EventTarget[])[] = [];
  for (const spec of info.targets) {
    const allowed = candidates.filter((target) =>
      matchesFilter(state, context, spec.filter, target),
    );
    for (let i = 0; i < (spec.count ?? 1); i += 1) slots.push(allowed);
  }

  let combinations: EventTarget[][] = [[]];
  for (const slot of slots) {
    const grown: EventTarget[][] = [];
    for (const so_far of combinations) {
      for (const target of slot) {
        // CR 601.2c: the same target cannot be chosen twice for one instance of "target".
        if (so_far.some((chosen) => sameTarget(chosen, target))) continue;
        grown.push([...so_far, target]);
        if (grown.length >= MOST_TARGETINGS) break;
      }
      if (grown.length >= MOST_TARGETINGS) break;
    }
    combinations = grown;
    if (combinations.length === 0) break;
  }

  // "Up to N" is satisfied by choosing none, and that is sometimes the only legal choice
  // (CR 601.2c). A spell whose targets are all optional therefore always has at least one
  // way to be cast, even on an empty board.
  if (info.targets.every((spec) => spec.upTo === true)) {
    return [[], ...combinations.filter((each) => each.length > 0)];
  }
  return combinations;
};

const sameTarget = (left: EventTarget, right: EventTarget): boolean =>
  left.kind === 'player' && right.kind === 'player'
    ? left.player === right.player
    : left.kind === 'object' && right.kind === 'object' && left.object === right.object;

/** Whether the object is one the player could cast right now. */
export const canCast = (
  state: GameState,
  player: PlayerId,
  id: ObjectId,
  cards: CardInfoSource,
): boolean =>
  legalActions(state, player, cards).some(
    (action) => action.kind === 'cast' && action.object === id,
  );

/** Permanents a player controls, the usual starting point for a candidate target set. */
export const permanentsControlledBy = (state: GameState, player: PlayerId): readonly ObjectId[] =>
  objectsIn(state, 'battlefield').filter((id) => getObject(state, id).controller === player);
