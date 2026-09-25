import type { PlayAgent } from '@mtg/agents';
import {
  applyDecision,
  createEventEmitter,
  createRng,
  type DecisionResponse,
  type GameState,
  isGameOver,
  type Rng,
  setUpGame,
  viewFor,
} from '@mtg/engine';
import type { GameResult, PlayerId } from '@mtg/shared';

/**
 * Play one game between two agents (the core of roadmap 5.1's match runner).
 *
 * This is the one place a view is made (ADR 0009): each time the engine stops with a
 * question, the player it is asking gets `viewFor(state, player)` and nothing else, and
 * whatever they answer goes straight back into `applyDecision`. An agent never holds the
 * state, so it cannot look at the opponent's hand however it is written.
 *
 * Each seat draws from its own generator, forked from the game's seed by seat, so one
 * agent's randomness cannot shift the other's and a game is a pure function of its seed
 * and its two agents.
 */

export interface PlayedGame {
  readonly result: GameResult | null;
  readonly decisions: readonly DecisionResponse[];
  readonly state: GameState;
}

export class StalledGameError extends Error {
  constructor(seed: string, decisions: number) {
    super(`game "${seed}" was still going after ${decisions} decisions`);
    this.name = 'StalledGameError';
  }
}

/**
 * `board` is a game not yet set up — libraries filled, nothing dealt — so the opening
 * hands and the mulligans are decided by the agents too, like everything else.
 */
export const playGame = (
  board: GameState,
  agents: Readonly<Record<PlayerId, PlayAgent>>,
  seed: string,
  maxDecisions = 5_000,
): PlayedGame => {
  const emitter = createEventEmitter();
  const seats: Record<PlayerId, Rng> = {
    A: createRng(`${seed}:seat:A`),
    B: createRng(`${seed}:seat:B`),
  };
  const decisions: DecisionResponse[] = [];
  let state = setUpGame(board, emitter);

  while (!isGameOver(state)) {
    const decision = state.pendingDecision;
    if (decision === null || decisions.length >= maxDecisions) {
      throw new StalledGameError(seed, decisions.length);
    }
    const response = agents[decision.player].decide(
      viewFor(state, decision.player),
      decision,
      seats[decision.player],
    );
    decisions.push(response);
    state = applyDecision(state, emitter, response);
  }

  return { result: state.result, decisions, state };
};
