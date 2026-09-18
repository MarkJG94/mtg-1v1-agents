import type { Decision, DecisionResponse, PlayerView, Rng } from '@mtg/engine/view';
import type { AgentLevel } from '@mtg/shared';

/**
 * The play agent (docs/04 "Play agent").
 *
 * One method, because that is all an agent is: the engine stops with a question, the
 * agent answers it, the engine carries on. Everything else — the evaluator, the search,
 * the combat solver — is how a particular agent arrives at the answer, and none of it is
 * the engine's business.
 *
 * **It is given a view, not a state** (ADR 0009). docs/04 originally wrote this as
 * `decide(state, decision, view, rng)`, which hands the agent the very thing the view
 * exists to withhold; an agent that reached past the view would be indistinguishable from
 * one that played well. The state is not a parameter here, and the agents package cannot
 * import the module it lives in — `import-boundary.test.ts` is what holds that.
 *
 * The RNG is injected for the same reason everything else in the system is: a run is a
 * pure function of its seed, and an agent that reached for `Math.random` would make a
 * failing game unreproducible.
 */
export interface PlayAgent {
  /** Which strategy this is, for the run settings and for the sanity ladder (docs/09). */
  readonly level: AgentLevel;
  /**
   * Answer one decision. Must return a response of the decision's own kind and must not
   * mutate the view — it is this agent's copy, but the objects inside are shared.
   */
  decide(view: PlayerView, decision: Decision, rng: Rng): DecisionResponse;
}

/**
 * Raised when an agent is asked something it has no answer for.
 *
 * Every agent must answer every decision kind the engine can raise, including the ones
 * its strategy never expects: an unanswered decision stops the game, and a game that
 * stops mid-run looks exactly like an engine hang. Failing loudly here is what makes the
 * difference visible.
 */
export class UnansweredDecisionError extends Error {
  constructor(level: AgentLevel, kind: Decision['kind']) {
    super(`the ${level} agent has no answer for a "${kind}" decision`);
    this.name = 'UnansweredDecisionError';
  }
}
