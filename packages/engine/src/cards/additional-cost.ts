import { type ObjectId, type PlayerId, playerZone } from '@mtg/shared';
import type { GameState } from '../state/game-state.js';
import { objectsIn } from '../state/update.js';
import type { AdditionalCost } from './definition.js';
import { matchesFilter } from './evaluate.js';

/**
 * Who could pay a spell's additional cost, and with what (CR 601.2b, 118.8).
 *
 * Casting checks a payment against these and `legalActions` offers its castings from
 * them, so the two cannot disagree: an action offered is one the engine accepts.
 */

/** Permanents the caster controls that the cost lets them sacrifice. */
export const sacrificeCandidates = (
  state: GameState,
  player: PlayerId,
  source: ObjectId,
  cost: AdditionalCost,
): readonly ObjectId[] => {
  const wanted = cost.sacrifice;
  if (wanted === undefined) return [];
  const context = { source, controller: player, targets: {}, x: 0 };
  // Controlled as the layers make it (CR 613.1b): only your own permanents can be
  // sacrificed (CR 701.21a), and a creature you have taken is one of them.
  const yours = {
    kind: 'and',
    filters: [wanted.filter, { kind: 'controlledBy', player: 'you' }],
  } as const;
  return objectsIn(state, 'battlefield').filter((id) =>
    matchesFilter(state, context, yours, { kind: 'object', object: id }),
  );
};

/** Cards the caster could discard: everything else in their hand. */
export const discardCandidates = (
  state: GameState,
  player: PlayerId,
  source: ObjectId,
): readonly ObjectId[] =>
  objectsIn(state, playerZone(player, 'hand')).filter((id) => id !== source);

/** Whether the caster has the life the cost asks for (CR 119.4). */
export const canPayLife = (state: GameState, player: PlayerId, cost: AdditionalCost): boolean =>
  state.players[player].life >= (cost.life ?? 0);

/**
 * Every way of choosing `count` of these, in order, stopping at `most` — the same
 * under-reporting `legalActions` does for targets: every choice offered is legal, and a
 * legal one left out costs a line, not a crash.
 */
export const choose = (
  from: readonly ObjectId[],
  count: number,
  most: number,
): readonly (readonly ObjectId[])[] => {
  if (count <= 0) return [[]];
  const found: ObjectId[][] = [];
  const walk = (start: number, picked: ObjectId[]): void => {
    if (found.length >= most) return;
    if (picked.length === count) {
      found.push([...picked]);
      return;
    }
    for (let i = start; i < from.length; i += 1) {
      walk(i + 1, [...picked, from[i] as ObjectId]);
      if (found.length >= most) return;
    }
  };
  walk(0, []);
  return found;
};
