import type { GameResult, PlayerId, Step } from '@mtg/shared';
import type { Decision, DecisionResponse } from '../decision.js';
import type { Rng } from '../rng.js';
import type { PlayerView } from './player-view.js';

/**
 * The simulator a searching agent is handed (roadmap 4.3, ADR 0012).
 *
 * The `search` level has to play the game forward to see what an action does, and the
 * agents package cannot call the engine (ADR 0009). So the driver hands it one of these
 * with every decision: a way to make **determinisations** of the game as the deciding
 * player knows it, and to run them forward with the real rules.
 *
 * A determinisation is the game with everything this player cannot see replaced by a
 * sample — the opponent's hand drawn from cards the player has seen them play, and both
 * libraries made of cards nobody knows. Its content is a function of the player's view
 * and the generator they sample with, and nothing else; `determinise.test.ts` holds that
 * the same way `player-view.test.ts` holds it for the view, by changing only the hidden
 * cards and requiring an identical result.
 *
 * `World` is opaque on purpose. Underneath it is an engine state, but an agent can only
 * hand it back to the simulator that made it; there is nothing to read that `view` does
 * not already show.
 */

declare const world: unique symbol;

/** A determinised game. Opaque: only the simulator that made it can use it. */
export interface World {
  readonly [world]: true;
}

/** Where a world has got to, cheaply — without building a whole view. */
export interface WorldStatus {
  readonly turn: number;
  readonly step: Step;
  readonly activePlayer: PlayerId;
  /** Objects on the stack. */
  readonly stackSize: number;
  /** Who controls the top of the stack, or `null` when it is empty. */
  readonly topOfStack: PlayerId | null;
  readonly result: GameResult | null;
}

export interface Simulator {
  /** The player this simulator samples for; `sample` hides what they cannot see. */
  readonly viewer: PlayerId;
  /**
   * A fresh determinisation of the game at the decision being made, drawing whatever it
   * samples from `rng`. The same generator state gives the same world.
   */
  sample(rng: Rng): World;
  /** The decision the world is waiting on, or `null` once its game is over. */
  decision(world: World): Decision | null;
  /** Answer the pending decision and run on to the next one — `applyDecision`, in a world. */
  apply(world: World, response: DecisionResponse): World;
  /** The world as one of its players sees it. */
  view(world: World, player: PlayerId): PlayerView;
  status(world: World): WorldStatus;
}
