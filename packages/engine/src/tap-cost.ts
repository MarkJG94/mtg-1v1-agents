import type { ObjectId } from '@mtg/shared';
import { characteristicsOf } from './characteristics.js';
import type { GameState } from './state/game-state.js';

/**
 * Whether a permanent can pay {T} now (CR 302.6, 602.5a): it has to be untapped, and a
 * creature has to have been under its controller's control continuously since their most
 * recent turn began — which `summoningSick` records — unless it has haste (CR 702.10).
 *
 * One rule for every {T}: a mana ability, an activated ability, and what `legalActions`
 * counts as mana a player could still make. A creature that taps for mana used to be able
 * to the turn it entered, because only attacking asked.
 */
export const canPayTap = (state: GameState, id: ObjectId): boolean => {
  const object = state.objects.get(id);
  if (object === undefined || object.tapped) return false;
  if (!object.summoningSick) return true;
  // Characteristics only for the rare permanent still sick: this is on the mana path.
  const traits = characteristicsOf(state, id);
  return !traits.isCreature || traits.keywords.haste;
};
