import type { EventTarget, ObjectId } from '@mtg/shared';
import type { EventEmitter } from '../events/emitter.js';
import { hasFizzled, resolveTopOfStack, topOfStack } from '../stack.js';
import type { GameState } from '../state/game-state.js';
import { getObject } from '../state/update.js';
import {
  abilityById,
  type CardAbility,
  effectsOf,
  spellAbilityOf,
  type TargetSpec,
  targetsOf,
} from './definition.js';
import { applyEffects, EffectsPausedError } from './effects.js';
import type { EffectContext } from './evaluate.js';

/**
 * Resolution, with the card script doing the work (CR 608).
 *
 * `stack.ts` owns the mechanics — what fizzles, where the object goes afterwards — and
 * knows nothing about what a card does. This sits on top: it finds the ability that is
 * resolving, runs its effects, and then lets the stack finish the move. A card with no
 * script resolves exactly as it did before card definitions existed, which is what keeps
 * the engine's own tests honest.
 */

/**
 * Match the flat list of targets on the stack back to the ability's named ones.
 *
 * They were chosen in the order the ability declares them, so they are handed back out
 * the same way: the first spec takes its `count`, the next takes the ones after that. An
 * "up to" spec takes what is left rather than demanding its full number.
 */
export const bindTargets = (
  specs: readonly TargetSpec[],
  chosen: readonly EventTarget[],
): Record<string, readonly EventTarget[]> => {
  const bound: Record<string, readonly EventTarget[]> = {};
  let index = 0;

  for (const spec of specs) {
    const wanted = spec.count ?? 1;
    const take = spec.upTo === true ? Math.min(wanted, chosen.length - index) : wanted;
    bound[spec.id] = chosen.slice(index, index + Math.max(0, take));
    index += Math.max(0, take);
  }

  return bound;
};

/** The ability that is resolving: a named one for an ability, the spell's otherwise. */
const resolvingAbility = (state: GameState, id: ObjectId): CardAbility | undefined => {
  const object = getObject(state, id);
  const definition = state.definitions.get(object.definitionId);
  if (definition === undefined) return undefined;

  const abilityId = object.stack?.abilityId;
  return abilityId === undefined ? spellAbilityOf(definition) : abilityById(definition, abilityId);
};

/**
 * Resolve the top of the stack, running whatever the card says it does first.
 *
 * The one thing that cannot happen here is finishing while the game is still waiting on
 * something: if the effects stopped for a replacement choice, the spell has not finished
 * resolving and must not be moved anywhere, so this says so loudly rather than leaving a
 * half-resolved spell in a graveyard. Resumable effects are the fix, and are the same
 * work as the ops that need a choice of their own (see `effects.ts`).
 */
export const resolveTop = (state: GameState, emitter: EventEmitter): GameState => {
  const id = topOfStack(state);
  if (id === undefined || hasFizzled(state, id)) return resolveTopOfStack(state, emitter);

  const object = getObject(state, id);
  const ability = resolvingAbility(state, id);
  if (ability === undefined) return resolveTopOfStack(state, emitter);

  const context: EffectContext = {
    source: object.stack?.source ?? id,
    controller: object.controller,
    targets: bindTargets(targetsOf(ability), object.stack?.targets ?? []),
    x: object.stack?.x ?? 0,
  };

  const after = applyEffects(state, emitter, context, effectsOf(ability));
  if (after.pendingReplacement !== null) {
    throw new EffectsPausedError(
      'this spell stopped part-way for a replacement choice, so it cannot finish resolving',
    );
  }

  return after.result !== null ? after : resolveTopOfStack(after, emitter);
};
