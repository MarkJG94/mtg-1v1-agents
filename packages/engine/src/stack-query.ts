import type { GameState } from './state/game-state.js';
import { getObject, objectsIn } from './state/update.js';

/**
 * Two questions about the stack, on their own.
 *
 * They live here rather than in `stack.ts` for the same reason `keywords.ts` exists:
 * `legal-actions.ts` needs to ask both of them, and `stack.ts` needs to ask
 * `legal-actions.ts` what a player may do once a spell has gone on the stack. Two modules
 * that import each other work in ESM right up until one of them reads a binding during
 * evaluation, and then they fail in a way that depends on which file a program happened
 * to load first. A module that imports nothing but the state breaks the knot.
 *
 * `stack.ts` re-exports both, so nothing else has to know they moved.
 */

export const isStackEmpty = (state: GameState): boolean => objectsIn(state, 'stack').length === 0;

/**
 * Whether a split-second spell is waiting to resolve (CR 702.61a). While one is, players
 * may not cast spells or activate abilities that are not mana abilities.
 */
export const splitSecondActive = (state: GameState): boolean =>
  objectsIn(state, 'stack').some((id) => getObject(state, id).stack?.splitSecond === true);
