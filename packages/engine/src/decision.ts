import type { EventTarget, ObjectId, PlayerId } from '@mtg/shared';
import type { BlockDeclaration } from './combat.js';

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
 * and friends in 1.6, `orderTriggers` in 1.8, `mulligan` in 1.12.
 */

/** What a player may do while holding priority. */
export type PriorityAction = { readonly kind: 'pass' };

export interface PriorityDecision {
  readonly kind: 'priority';
  readonly player: PlayerId;
  /**
   * The actions the engine knows are legal. For now that is only passing: enumerating
   * what can be cast, activated or played is `legalActions`, which is roadmap 1.5. Until
   * then a driver holding priority calls `putOnStack` directly.
   */
  readonly options: readonly PriorityAction[];
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
  /** Who they would attack; planeswalkers join this in roadmap 1.11. */
  readonly defender: EventTarget;
}

/** Declaring blockers (CR 509.1). Declaring none is a legal answer. */
export interface DeclareBlockersDecision {
  readonly kind: 'declareBlockers';
  readonly player: PlayerId;
  readonly attackers: readonly ObjectId[];
  /** Untapped creatures the defending player controls. */
  readonly available: readonly ObjectId[];
}

/** Ordering the blockers of one attacker for damage assignment (CR 509.2). */
export interface OrderBlockersDecision {
  readonly kind: 'orderBlockers';
  readonly player: PlayerId;
  readonly attacker: ObjectId;
  readonly blockers: readonly ObjectId[];
}

export type Decision =
  | PriorityDecision
  | DiscardDecision
  | DeclareAttackersDecision
  | DeclareBlockersDecision
  | OrderBlockersDecision;

export type DecisionResponse =
  | { readonly kind: 'priority'; readonly action: PriorityAction }
  | { readonly kind: 'discard'; readonly cards: readonly ObjectId[] }
  | {
      readonly kind: 'declareAttackers';
      readonly attackers: readonly {
        readonly attacker: ObjectId;
        readonly defender: EventTarget;
      }[];
    }
  | { readonly kind: 'declareBlockers'; readonly blocks: readonly BlockDeclaration[] }
  | { readonly kind: 'orderBlockers'; readonly order: readonly ObjectId[] };

export class UnexpectedDecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnexpectedDecisionError';
  }
}

/** The decision handed to whoever receives priority (CR 117.1). */
export const priorityDecision = (player: PlayerId): PriorityDecision => ({
  kind: 'priority',
  player,
  options: [{ kind: 'pass' }],
});
