import type { Decision, DecisionResponse, PlayerView, Rng } from '@mtg/engine/view';
import { type Block, withoutLoneMenaceBlocks } from './blocks.js';
import type { PlayAgent } from './play-agent.js';

/**
 * The `random` level (docs/04), for an agent that plays through a view.
 *
 * The engine has a random agent of its own in `@mtg/engine/testing`, and that one is a
 * fuzzer: it reads the whole `GameState`, because hunting rules bugs is its job and it has
 * no opponent to be fair to. This one is a *player* — the bottom rung of the sanity ladder
 * (docs/09: search beats greedy beats random) — so it gets what every player gets, a view
 * and a decision, and nothing else. Everything it needs to stay legal is in the decision.
 */
export const randomAgent: PlayAgent = {
  level: 'random',
  decide: (view: PlayerView, decision: Decision, rng: Rng): DecisionResponse => {
    switch (decision.kind) {
      case 'priority':
        return { kind: 'priority', action: rng.pick(decision.options) };
      case 'playOrDraw':
        return { kind: 'playOrDraw', choice: rng.pick(decision.options) };
      case 'mulligan':
        return { kind: 'mulligan', action: rng.pick(decision.options) };
      case 'bottomCards':
        return { kind: 'bottomCards', cards: rng.shuffled(decision.from).slice(0, decision.count) };
      case 'discard':
        return { kind: 'discard', cards: rng.shuffled(decision.from).slice(0, decision.count) };
      case 'declareAttackers':
        return {
          kind: 'declareAttackers',
          attackers: decision.legal
            .filter(() => rng.nextBoolean())
            .map((attacker) => ({ attacker, defender: rng.pick(decision.defenders) })),
        };
      case 'declareBlockers': {
        const blocks: Block[] = decision.canBlock
          .filter((entry) => entry.attackers.length > 0 && rng.nextBoolean())
          .map((entry) => ({ blocker: entry.blocker, blocking: [rng.pick(entry.attackers)] }));
        return { kind: 'declareBlockers', blocks: withoutLoneMenaceBlocks(view, blocks) };
      }
      case 'orderBlockers':
        return { kind: 'orderBlockers', order: rng.shuffled(decision.blockers) };
      case 'orderTriggers':
        return { kind: 'orderTriggers', order: rng.shuffled(decision.triggers) };
      case 'chooseOption':
        return { kind: 'chooseOption', chosen: rng.pick(decision.options) };
      case 'chooseReplacement':
        return { kind: 'chooseReplacement', effect: rng.pick(decision.options) };
    }
  },
};
