import type { EventTarget, ObjectId, PlayerId } from '@mtg/shared';
import type { BlockDeclaration } from './combat.js';
import type { RulesEvent } from './events/rules-event.js';
import type { LegalAction } from './legal-actions.js';

/**
 * Decisions (docs/01 "Engine execution model", docs/02 "Decisions").
 *
 * The engine never blocks. When a player must choose, it stops with `pendingDecision`
 * describing the choice, and a driver — the simulation loop, a test, or later a human UI —
 * answers with `applyDecision`. That is what makes a game a pure function of its seed and
 * the sequence of decisions, and so replayable.
 *
 * Only the kinds the engine can currently raise are modelled. The rest listed in docs/02
 * arrive with the subsystems that need them: `chooseTargets` in 1.5, `declareAttackers`
 * and friends in 1.6, `orderTriggers` in 1.8, `chooseReplacement` in 1.10,
 * `mulligan` and `bottomCards` in 1.12.
 */

/**
 * What a player may do while holding priority — which is exactly `legalActions`, since
 * that is the single source of truth for legality (docs/02) and a second list would be a
 * second opinion.
 */
export type PriorityAction = LegalAction;

export interface PriorityDecision {
  readonly kind: 'priority';
  readonly player: PlayerId;
  /**
   * Everything the engine knows this player may do: pass, play a land, cast a spell with
   * its targets already chosen, activate a loyalty ability. Built by `priorityOptions`,
   * and the invariant docs/09 asks for is that nothing offered here is then refused.
   */
  readonly options: readonly PriorityAction[];
}

/** Keeping or mulliganing an opening hand (CR 103.4). */
export interface MulliganDecision {
  readonly kind: 'mulligan';
  readonly player: PlayerId;
  readonly hand: readonly ObjectId[];
  /** Mulligans already taken, which is how many cards keeping will cost (CR 103.4b). */
  readonly taken: number;
  /** `'mulligan'` is absent once the player has taken as many as the game allows. */
  readonly options: readonly ('keep' | 'mulligan')[];
}

/**
 * Choosing who takes the first turn (CR 103.1), asked of the player who won the right to
 * choose — at random in the first game of a match, the loser of the previous game after
 * that. Asked before any card is dealt, because the choice decides who declares a
 * mulligan first (CR 103.4) and who skips their first draw (CR 103.7a).
 */
export interface PlayOrDrawDecision {
  readonly kind: 'playOrDraw';
  readonly player: PlayerId;
  /** `play`: the chooser takes the first turn. `draw`: the opponent does. */
  readonly options: readonly ('play' | 'draw')[];
}

/** Paying for a kept mulligan by putting cards under the library (CR 103.4b). */
export interface BottomCardsDecision {
  readonly kind: 'bottomCards';
  readonly player: PlayerId;
  readonly count: number;
  /** The cards that may be chosen — the player's hand. */
  readonly from: readonly ObjectId[];
}

/** Discarding to maximum hand size in cleanup (CR 514.1). */
export interface DiscardDecision {
  readonly kind: 'discard';
  readonly player: PlayerId;
  readonly count: number;
  /** The cards that may be chosen — the player's hand. */
  readonly from: readonly ObjectId[];
}

/** Declaring attackers (CR 508.1). Declaring none is a legal answer. */
export interface DeclareAttackersDecision {
  readonly kind: 'declareAttackers';
  readonly player: PlayerId;
  /** Creatures that could attack. */
  readonly legal: readonly ObjectId[];
  /**
   * Who they may attack (CR 508.1a): the defending player, and each planeswalker they
   * control. Every attacker picks from this list independently.
   */
  readonly defenders: readonly EventTarget[];
}

/** Declaring blockers (CR 509.1). Declaring none is a legal answer. */
export interface DeclareBlockersDecision {
  readonly kind: 'declareBlockers';
  readonly player: PlayerId;
  readonly attackers: readonly ObjectId[];
  /** Untapped creatures the defending player controls. */
  readonly available: readonly ObjectId[];
  /**
   * For each available blocker, the attackers it may legally block on its own (CR 509.1b)
   * — evasion and protection already applied, in the order of `available`.
   *
   * Every decision carries its full list of legal options (docs/02), and without this one
   * did not: an agent had the blockers and the attackers but not which could meet which,
   * so it had to redo flying and protection from the view and would throw whenever it got
   * them wrong. Menace is not here because it is not a fact about one pairing — it is a
   * rule about the whole declaration (CR 702.110b), and the attacker's keywords say so.
   */
  readonly canBlock: readonly {
    readonly blocker: ObjectId;
    readonly attackers: readonly ObjectId[];
  }[];
}

/** Ordering the blockers of one attacker for damage assignment (CR 509.2). */
export interface OrderBlockersDecision {
  readonly kind: 'orderBlockers';
  readonly player: PlayerId;
  readonly attacker: ObjectId;
  readonly blockers: readonly ObjectId[];
}

/**
 * A choice between objects that the rules force but do not decide, such as which of two
 * legendary permanents with the same name to keep (CR 704.5j).
 */
export interface ChooseOptionDecision {
  readonly kind: 'chooseOption';
  readonly player: PlayerId;
  /** Why the choice is being made, so a driver can answer sensibly. */
  readonly reason: 'legendRule';
  readonly options: readonly ObjectId[];
}

/**
 * Putting several of one player's triggers on the stack, which they order (CR 603.3b).
 * The last one put on the stack resolves first.
 */
export interface OrderTriggersDecision {
  readonly kind: 'orderTriggers';
  readonly player: PlayerId;
  /** Ability ids, in the order they fired. */
  readonly triggers: readonly string[];
}

/**
 * Which of several applicable replacement effects applies first (CR 616.1). The affected
 * player chooses — the damaged player, the dying creature's controller — and the rest are
 * reconsidered afterwards, since the one just applied may have changed what still applies.
 */
export interface ChooseReplacementDecision {
  readonly kind: 'chooseReplacement';
  readonly player: PlayerId;
  /** Ids of the replacement effects in force that all apply to `event`. */
  readonly options: readonly number[];
  /** What is about to happen, so a driver can weigh the options. */
  readonly event: RulesEvent;
}

export type Decision =
  | MulliganDecision
  | PlayOrDrawDecision
  | BottomCardsDecision
  | ChooseOptionDecision
  | ChooseReplacementDecision
  | OrderTriggersDecision
  | PriorityDecision
  | DiscardDecision
  | DeclareAttackersDecision
  | DeclareBlockersDecision
  | OrderBlockersDecision;

export type DecisionResponse =
  | { readonly kind: 'priority'; readonly action: PriorityAction }
  | { readonly kind: 'mulligan'; readonly action: 'keep' | 'mulligan' }
  | { readonly kind: 'playOrDraw'; readonly choice: 'play' | 'draw' }
  | { readonly kind: 'bottomCards'; readonly cards: readonly ObjectId[] }
  | { readonly kind: 'discard'; readonly cards: readonly ObjectId[] }
  | {
      readonly kind: 'declareAttackers';
      readonly attackers: readonly {
        readonly attacker: ObjectId;
        readonly defender: EventTarget;
      }[];
    }
  | { readonly kind: 'declareBlockers'; readonly blocks: readonly BlockDeclaration[] }
  | { readonly kind: 'orderBlockers'; readonly order: readonly ObjectId[] }
  | { readonly kind: 'chooseOption'; readonly chosen: ObjectId }
  | { readonly kind: 'chooseReplacement'; readonly effect: number }
  | { readonly kind: 'orderTriggers'; readonly order: readonly string[] };

export class UnexpectedDecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnexpectedDecisionError';
  }
}

/**
 * A priority decision with nothing but passing on it.
 *
 * Kept for the places that build a decision without a state to ask — tests about the
 * decision pipeline itself. Real play goes through `priorityOptions`, which fills the
 * options in from `legalActions`.
 */
export const priorityDecision = (player: PlayerId): PriorityDecision => ({
  kind: 'priority',
  player,
  options: [{ kind: 'pass' }],
});
