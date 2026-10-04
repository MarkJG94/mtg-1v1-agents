import type { GameState } from '../state/game-state.js';
import type { GameObject } from '../state/object.js';
import { matchesFilter } from './evaluate.js';

/**
 * What an Aura or an Equipment may be attached to (CR 301.5c, 303.4d, 701.3b).
 *
 * One answer for the three places that ask: the `attach` op, which does nothing when the
 * attachment could not legally be there (CR 701.3b); an Aura spell entering attached to
 * its target (CR 303.4f); and the state-based actions, which put an Aura that has come to
 * be on something it could not enchant into its owner's graveyard and take an Equipment
 * off anything that is not a creature (CR 704.5m, 704.5n).
 *
 * An Aura's `enchant` is read with the Aura as the source and its controller as "you",
 * which is what "enchant creature you control" means. An Aura with no definition behind it
 * — one the scenario builder made up — has no restriction to check.
 */
export const canAttach = (state: GameState, attachment: GameObject, host: GameObject): boolean => {
  if (host.id === attachment.id || host.zone !== 'battlefield') return false;
  const context = {
    source: attachment.id,
    controller: attachment.controller,
    targets: {},
    x: 0,
  };
  const subject = { kind: 'object' as const, object: host.id };
  if (attachment.attachment === 'aura') {
    const enchant = state.definitions.get(attachment.definitionId)?.enchant;
    return enchant === undefined || matchesFilter(state, context, enchant, subject);
  }
  if (attachment.attachment === 'equipment') {
    return matchesFilter(state, context, { kind: 'creature' }, subject);
  }
  return true;
};
