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
  simulatorFor,
  viewFor,
} from '@mtg/engine';
import type { PlayerView } from '@mtg/engine/view';
import type { GameEvent, GameResult, PlayerId } from '@mtg/shared';

/**
 * Play one game between two agents (the core of roadmap 5.1's match runner).
 *
 * This is the one place a view is made (ADR 0009): each time the engine stops with a
 * question, the player it is asking gets `viewFor(state, player)` and nothing else, and
 * whatever they answer goes straight back into `applyDecision`. An agent never holds the
 * state, so it cannot look at the opponent's hand however it is written. A searching
 * agent is handed a simulator as well, whose worlds are determinisations — the game with
 * everything that player cannot see sampled afresh (ADR 0012).
 *
 * Each seat draws from its own generator, forked from the game's seed by seat, so one
 * agent's randomness cannot shift the other's and a game is a pure function of its seed
 * and its two agents.
 */

export interface PlayedGame {
  readonly result: GameResult | null;
  readonly decisions: readonly DecisionResponse[];
  readonly state: GameState;
  /** Everything the engine emitted, oldest first — what an event log is made of. */
  readonly events: readonly GameEvent[];
}

export interface PlayOptions {
  /** A game still going after this many decisions is stalled (default 5,000). */
  readonly maxDecisions?: number;
  /**
   * Score each position for the player about to decide, and record the decision with its
   * score as a `decision` event — docs/05's `impact` statistic is read off these. The
   * scorer sees the same view the agent does, so the log records nothing hidden from it.
   */
  readonly score?: (view: PlayerView) => number;
  /** Handed each event as the engine emits it, for a live viewer (docs/07 `gameEvents`). */
  readonly onEvent?: (event: GameEvent) => void;
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
  options: PlayOptions = {},
): PlayedGame => {
  const maxDecisions = options.maxDecisions ?? 5_000;
  const emitter = createEventEmitter(
    options.onEvent === undefined ? {} : { onEvent: options.onEvent },
  );
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
    const view = viewFor(state, decision.player);
    const response = agents[decision.player].decide(
      view,
      decision,
      seats[decision.player],
      simulatorFor(state, decision.player),
    );
    decisions.push(response);
    if (options.score !== undefined) {
      emitter.emit(state, {
        type: 'decision',
        player: decision.player,
        kind: decision.kind,
        chosen: response,
        score: options.score(view),
      });
    }
    state = applyDecision(state, emitter, response);
  }

  return { result: state.result, decisions, state, events: emitter.events };
};
