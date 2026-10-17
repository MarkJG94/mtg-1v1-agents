import type { ObjectId, PlayerId } from '@mtg/shared';
import type { ManaCost } from '../mana/cost.js';
import type { GameState } from '../state/game-state.js';
import type { CostReduction } from './definition.js';
import { evaluateQuantity, holds } from './evaluate.js';

/**
 * What a spell costs to cast once its own reduction is taken off (CR 601.2f).
 *
 * Only the generic part goes down, and never below nothing: "costs {2} less" on a spell
 * that costs {1}{R} leaves {R}, not a credit. The count is made now, as the spell is cast
 * — "for each artifact you control" counts the artifacts there are as it is paid — and a
 * condition that does not hold takes nothing off.
 *
 * Casting pays this and `legalActions` prices with it, so the two agree: a spell is
 * offered exactly when the reduced cost is one the caster can pay.
 */
export const reducedCost = (
  state: GameState,
  player: PlayerId,
  source: ObjectId,
  cost: ManaCost,
  reduction: CostReduction | undefined,
): ManaCost => {
  if (reduction === undefined || cost.generic === 0) return cost;
  const context = { source, controller: player, targets: {}, x: 0 };
  if (reduction.if !== undefined && !holds(state, context, reduction.if)) return cost;
  const off = Math.max(0, evaluateQuantity(state, context, reduction.generic));
  return off === 0 ? cost : { ...cost, generic: Math.max(0, cost.generic - off) };
};
