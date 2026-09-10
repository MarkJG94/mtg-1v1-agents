import type { ObjectId, PlayerId } from '@mtg/shared';
import type { CostDef, Effect, TargetSpec } from './definition.js';
import type { Characteristics, ObjectRef, TargetRef, TriggerInstance } from './state.js';

export interface EffectContext {
  source: ObjectRef;
  controller: PlayerId;
  targets: Record<string, TargetRef[]>;
  x: number;
  bindings: Record<string, TargetRef | number | TargetRef[]>;
  sourceLki: Characteristics | null;
  stackId: number | null;
  /** Damage dealt by the most recent damage effect, for "that much" quantities. */
  lastDamage: number;
}

/**
 * Frames of the resumable interpreter. `step()` executes the top frame; a frame that needs a
 * player decision sets `pendingDecision` and stays on the stack with its `stage` recorded, and
 * is re-entered with the answer on the next `step()`.
 */
export type Frame =
  | { k: 'resolveTop' }
  | { k: 'effects'; effects: Effect[]; i: number; ctx: EffectContext; stage: EffectStage | null }
  | {
      k: 'cast';
      player: PlayerId;
      object: ObjectId;
      abilityIndex: number;
      alternative: boolean;
      stage: CastStage;
      modes: number[];
      targetSpecs: TargetSpec[];
      targets: Record<string, TargetRef[]>;
      x: number;
      costPaid: CostPaymentState;
    }
  | {
      k: 'activate';
      player: PlayerId;
      source: ObjectId;
      abilityIndex: number;
      loyalty: boolean;
      stage: CastStage;
      targetSpecs: TargetSpec[];
      targets: Record<string, TargetRef[]>;
      x: number;
      costPaid: CostPaymentState;
    }
  | { k: 'activateMana'; player: PlayerId; source: ObjectId; abilityIndex: number; option: number }
  | {
      k: 'putTriggers';
      stage: 'order' | 'targets';
      player: PlayerId | null;
      items: TriggerInstance[];
    }
  | { k: 'declareAttackers'; stage: 'declare' | 'done' }
  | { k: 'declareBlockers'; stage: 'declare' | 'order'; orderQueue: ObjectId[] }
  | { k: 'activateManaChoice'; player: PlayerId; source: ObjectId; abilityIndex: number }
  | {
      k: 'combatDamage';
      firstStrike: boolean;
      queue: ObjectId[];
      assignments: Record<ObjectId, { id: ObjectId | PlayerId; amount: number }[]>;
    }
  | { k: 'cleanupDiscard' }
  | { k: 'mulligan'; player: PlayerId; stage: 'ask' | 'bottom' }
  | { k: 'advanceStep' }
  | { k: 'beginStep' }
  | { k: 'finishSpell'; object: ObjectId }
  | {
      k: 'unlessPay';
      player: PlayerId;
      cost: CostDef;
      source: ObjectId;
      effects: Effect[];
      ctx: EffectContext;
      stage: 'ask' | 'pay';
    }
  | { k: 'legendRule'; player: PlayerId; objects: ObjectId[] };

export type CastStage =
  | 'modes'
  | 'targets'
  | 'x'
  | 'sacrifice'
  | 'discard'
  | 'exileFromGraveyard'
  | 'tapOther'
  | 'mana'
  | 'done';

export interface CostPaymentState {
  sacrificed: ObjectId[];
  discarded: ObjectId[];
  exiled: ObjectId[];
  tappedOthers: ObjectId[];
  manaPaid: boolean;
  lifePaid: number;
  x: number;
}

export function emptyCostPayment(): CostPaymentState {
  return {
    sacrificed: [],
    discarded: [],
    exiled: [],
    tappedOthers: [],
    manaPaid: false,
    lifePaid: 0,
    x: 0,
  };
}

export type EffectStage =
  | { kind: 'chooseObjects'; effectIndex: number; purpose: string }
  | { kind: 'yesNo'; effectIndex: number }
  | { kind: 'chooseOption'; effectIndex: number }
  | { kind: 'search'; effectIndex: number }
  | { kind: 'scry'; effectIndex: number }
  | { kind: 'unlessPay'; effectIndex: number; frameDepth: number }
  | { kind: 'distribute'; effectIndex: number }
  | { kind: 'chooseTargets'; effectIndex: number }
  | { kind: 'forEachPlayer'; effectIndex: number; remaining: PlayerId[] };
