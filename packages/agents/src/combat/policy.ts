import type { DecisionResponse } from '@mtg/engine/view';
import { type AgentKnowledge, greedyAgent } from '../greedy.js';
import type { PlayAgent } from '../play-agent.js';
import { defaultWeights, type Weights } from '../weights.js';
import { chooseBlocks, solveAttacks } from './solver.js';

/**
 * Greedy, with the combat solver answering attacks and blocks (roadmap 4.4).
 *
 * This is what the search plays *inside* its worlds — for the opponent's blocks when it
 * tries an attack, and for any combat a line runs into — and what it falls back on when
 * it has no budget to check the solver against the engine. It is not a level of its own:
 * `greedy` keeps its rules of thumb, as the baseline the ladder measures the others by.
 */
export const combatPolicy = (
  weights: Weights = defaultWeights,
  knowledge: AgentKnowledge = {},
): PlayAgent => {
  const greedy = greedyAgent(weights, knowledge);
  return {
    level: 'search',
    decide: (view, decision, rng, simulator): DecisionResponse => {
      if (decision.kind === 'declareAttackers') {
        const defender = decision.defenders.find((target) => target.kind === 'player');
        const [best] = solveAttacks(view, decision, weights);
        if (defender === undefined || best === undefined) {
          return { kind: 'declareAttackers', attackers: [] };
        }
        return {
          kind: 'declareAttackers',
          attackers: best.attackers.map((attacker) => ({ attacker, defender })),
        };
      }
      if (decision.kind === 'declareBlockers') {
        return { kind: 'declareBlockers', blocks: chooseBlocks(view, decision, weights) };
      }
      return greedy.decide(view, decision, rng, simulator);
    },
  };
};
