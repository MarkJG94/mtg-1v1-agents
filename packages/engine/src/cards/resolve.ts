import type { ObjectId } from '@mtg/shared';
import type { EventEmitter } from '../events/emitter.js';
import { hasFizzled, resolveTopOfStack, stillTargeted, topOfStack } from '../stack.js';
import type { GameState } from '../state/game-state.js';
import { getObject } from '../state/update.js';
import {
  abilityById,
  bindTargets,
  type CardAbility,
  effectsOf,
  spellAbilityOf,
  targetsOf,
} from './definition.js';
import type { EffectContext } from './evaluate.js';
import { beginResolution } from './program.js';

/**
 * Resolution, with the card script doing the work (CR 608).
 *
 * `stack.ts` owns the mechanics — what fizzles, where the object goes afterwards — and
 * knows nothing about what a card does. This sits on top: it finds the ability that is
 * resolving, runs its effects, and then lets the stack finish the move. A card with no
 * script resolves exactly as it did before card definitions existed, which is what keeps
 * the engine's own tests honest.
 */

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
 * Whether it fizzles is decided here, before anything happens (CR 608.2b). Then its
 * effects run as a program the game can stop in (ADR 0021): a "you may", a discard the
 * player chooses, a replacement choice each leave it waiting with the rest of the
 * effects kept, and `applyDecision` picks it up again. The object leaves the stack only
 * when the program has run out.
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
    // A target that has left the zone it was targeted in is illegal now, and the spell
    // does nothing to it (CR 608.2b); the rest it still does.
    targets: Object.fromEntries(
      Object.entries(bindTargets(targetsOf(ability), object.stack?.targets ?? [])).map(
        ([id, targets]) => [
          id,
          targets.filter((target) => stillTargeted(state, object.stack, target)),
        ],
      ),
    ),
    x: object.stack?.x ?? 0,
  };

  return beginResolution(state, emitter, id, context, effectsOf(ability));
};
