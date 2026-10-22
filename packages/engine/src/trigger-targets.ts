import type { EventTarget } from '@mtg/shared';
import { abilityById } from './cards/definition.js';
import type { ChooseTargetsDecision } from './decision.js';
import { UnexpectedDecisionError } from './decision.js';
import { sameTarget, targetingsFor } from './legal-actions.js';
import type { GameState } from './state/game-state.js';
import { updateState } from './state/update.js';
import type { TriggerInstance } from './triggers.js';

/**
 * A triggered ability's targets (CR 603.3d): chosen by its controller as it is put on the
 * stack, from every legal way of choosing them, and an ability with no legal way is
 * removed from the stack instead — it never gets there.
 *
 * Asked for each queued trigger before the queue is ordered and stacked, rather than in
 * the middle of stacking it: the choices are the same either way, since nothing put on
 * the stack between two triggers of one batch is a legal target for the other, and it
 * keeps "stack these in this order" a single answer. Without it a trigger that targets
 * went on the stack with none, and "When ~ enters, destroy target artifact" did nothing.
 */

const specsOf = (state: GameState, trigger: TriggerInstance) => {
  const definition = state.definitions.get(trigger.lastKnown.definitionId);
  const ability = definition === undefined ? undefined : abilityById(definition, trigger.abilityId);
  return ability?.kind === 'triggered' ? (ability.targets ?? []) : [];
};

/**
 * Settle the targets of the first queued trigger that needs them: ask, take the only
 * way there is, or drop the trigger when there is none. Null when every queued trigger
 * already has what it needs, so the queue can be stacked.
 */
export const settleTriggerTargets = (state: GameState): GameState | null => {
  const index = state.pendingTriggers.findIndex(
    (trigger) => trigger.targets === undefined && specsOf(state, trigger).length > 0,
  );
  const trigger = state.pendingTriggers[index];
  if (trigger === undefined) return null;

  const options = targetingsFor(
    state,
    trigger.controller,
    trigger.source,
    specsOf(state, trigger),
    trigger.lastKnown.colours,
  );
  const [only] = options;
  if (options.length === 0) {
    return updateState(state, {
      pendingTriggers: state.pendingTriggers.filter((_, i) => i !== index),
    });
  }
  if (options.length === 1 && only !== undefined) return withTargets(state, index, only);

  const decision: ChooseTargetsDecision = {
    kind: 'chooseTargets',
    player: trigger.controller,
    source: trigger.source,
    ability: trigger.abilityId,
    options,
  };
  return updateState(state, { pendingDecision: decision });
};

/** The answer: one of the ways offered, given to the trigger it was asked about. */
export const answerTriggerTargets = (
  state: GameState,
  decision: ChooseTargetsDecision,
  targets: readonly EventTarget[],
): GameState => {
  const offered = decision.options.some(
    (option) =>
      option.length === targets.length &&
      option.every((target, i) => sameTarget(target, targets[i] as EventTarget)),
  );
  if (!offered) throw new UnexpectedDecisionError('those targets are not a way that was offered');
  const index = state.pendingTriggers.findIndex(
    (trigger) =>
      trigger.targets === undefined &&
      trigger.source === decision.source &&
      trigger.abilityId === decision.ability,
  );
  if (index === -1) throw new UnexpectedDecisionError('no queued trigger is waiting on targets');
  return withTargets(state, index, targets);
};

const withTargets = (state: GameState, index: number, targets: readonly EventTarget[]): GameState =>
  updateState(state, {
    pendingTriggers: state.pendingTriggers.map((trigger, i) =>
      i === index ? { ...trigger, targets } : trigger,
    ),
  });
