import type { ObjectId } from '@mtg/shared';
import type { ContinuousEffect } from '../layers.js';
import type { ReplacementEffect } from '../replacement.js';
import type { GameState } from '../state/game-state.js';
import type { CardDefinition } from './definition.js';

/**
 * Static and replacement abilities, derived rather than registered.
 *
 * A static ability creates a continuous effect that exists for as long as its source is
 * on the battlefield (CR 604.1) — so rather than adding an effect when a permanent enters
 * and remembering to remove it when it leaves, the effects a battlefield implies are
 * computed from what is out there. Nothing to register, nothing to leak, and a permanent
 * that changes controller or is blinked behaves correctly without a special case.
 *
 * Their ids are negative, so they can never collide with the effects the game has
 * actually registered, and they are stable for as long as the object is: the CR 614.5
 * bookkeeping that stops one replacement applying twice to the same event identifies
 * effects by id, so an id that moved would be a rules bug.
 */

const idFor = (object: ObjectId, index: number): number => -(object * 64 + index + 1);

const definitionsOnBattlefield = (
  state: GameState,
): readonly { readonly object: ObjectId; readonly definition: CardDefinition }[] =>
  state.zones.battlefield.flatMap((object) => {
    const found = state.objects.get(object);
    if (found === undefined) return [];
    const definition = state.definitions.get(found.definitionId);
    return definition === undefined ? [] : [{ object, definition }];
  });

/** Every continuous effect the static abilities of permanents in play are making. */
export const staticEffects = (state: GameState): readonly ContinuousEffect[] => {
  const effects: ContinuousEffect[] = [];

  for (const { object, definition } of definitionsOnBattlefield(state)) {
    const timestamp = state.objects.get(object)?.timestamp ?? 0;
    definition.abilities.forEach((ability, index) => {
      if (ability.kind !== 'static') return;
      effects.push({
        id: idFor(object, index),
        source: object,
        timestamp,
        layer: layerOf(ability.change),
        affects: ability.affects,
        change: ability.change,
        duration: ability.duration ?? { kind: 'whileSourceOnBattlefield' },
      });
    });
  }

  return effects;
};

/** Every replacement effect the permanents in play are making. */
export const staticReplacements = (state: GameState): readonly ReplacementEffect[] => {
  const replacements: ReplacementEffect[] = [];

  for (const { object, definition } of definitionsOnBattlefield(state)) {
    const controller = state.objects.get(object)?.controller;
    if (controller === undefined) continue;
    definition.abilities.forEach((ability, index) => {
      if (ability.kind !== 'replacement') return;
      replacements.push({
        id: idFor(object, index),
        source: object,
        controller,
        applies: ability.applies,
        change: ability.change,
        duration: { kind: 'whileSourceOnBattlefield' },
        ...(ability.selfReplacement !== undefined
          ? { selfReplacement: ability.selfReplacement }
          : {}),
      });
    });
  }

  return replacements;
};

/**
 * Which layer a change belongs in. Imported lazily as a plain switch rather than through
 * `layerFor`, because `layers.ts` is where the layer system lives and this file is read
 * by it — a static ability is data about a card, not part of the layer machinery.
 */
const layerOf = (change: ContinuousEffect['change']): ContinuousEffect['layer'] => {
  switch (change.kind) {
    case 'changeControl':
      return '2-control';
    case 'becomesCreature':
      return '4-type';
    case 'setColours':
      return '5-colour';
    case 'addKeyword':
    case 'removeAllAbilities':
      return '6-ability';
    case 'setPowerToughness':
      return '7b-set';
    case 'modifyPowerToughness':
      return '7c-modify';
    case 'switchPowerToughness':
      return '7e-switch';
  }
};
