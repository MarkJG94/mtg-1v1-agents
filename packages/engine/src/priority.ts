import type { PlayerId } from '@mtg/shared';
import { cardsInPlay } from './cards/registry.js';
import type { PriorityDecision } from './decision.js';
import { legalActions } from './legal-actions.js';
import type { GameState } from './state/game-state.js';
import { updateState } from './state/update.js';

/**
 * Handing a player priority, with the list of what they may actually do (CR 117.1).
 *
 * Roadmap 1.5 built `legalActions` and left this connection open, because deciding what a
 * card *is* needed the card definitions that arrived in 2.1. Until it was made, the only
 * option on a priority decision was `pass` — so the fuzzer never cast a spell, and an
 * agent could not have if it wanted to.
 *
 * The two steps are in this order on purpose: `legalActions` refuses to answer for a
 * player who does not hold priority, so priority is granted first and the options are
 * computed from the state that results. Computing them from the state *before* would ask
 * about a player who is not yet holding it, and get an empty list.
 */

/** What this player may do right now, as the options of a priority decision. */
export const priorityOptions = (state: GameState, player: PlayerId): PriorityDecision => ({
  kind: 'priority',
  player,
  options: legalActions(state, player, cardsInPlay),
});

/**
 * Give `player` priority and stop for their decision.
 *
 * `extra` is merged in first, for the callers that also reset the pass count — putting a
 * spell on the stack restarts it (CR 117.3c) — so the options are computed from a state
 * that is already complete rather than from one mid-update.
 */
export const withPriority = (
  state: GameState,
  player: PlayerId,
  extra: Partial<GameState> = {},
): GameState => {
  const holding = updateState(state, { ...extra, priority: player });
  return updateState(holding, { pendingDecision: priorityOptions(holding, player) });
};
