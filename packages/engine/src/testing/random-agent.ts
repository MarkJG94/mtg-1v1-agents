import type { ObjectId } from '@mtg/shared';
import { keywordsOfObject } from '../characteristics.js';
import { canBlock } from '../combat.js';
import type { Decision, DecisionResponse } from '../decision.js';
import type { Rng } from '../rng.js';
import type { GameState } from '../state/game-state.js';

/**
 * The `random` agent level (docs/04): answer every decision uniformly at random from its
 * legal options.
 *
 * It exists to be a fuzzer, not a player. Its value is that it must be able to answer
 * *every* decision kind the engine can raise — an unanswerable decision would look like
 * an engine hang — and that it explores lines a sensible player never would, which is
 * exactly where rules bugs hide.
 *
 * It draws from an injected generator rather than `Math.random`, so a failing game can be
 * replayed exactly from its seed. That is the whole point: a fuzz failure is only useful
 * if it reproduces.
 */

/** A random subset, each element included with probability `p`. */
const subset = <T>(rng: Rng, items: readonly T[], p = 0.5): T[] =>
  items.filter(() => rng.nextBoolean(p));

export const randomDecision = (
  state: GameState,
  decision: Decision,
  rng: Rng,
): DecisionResponse => {
  switch (decision.kind) {
    case 'priority':
      // Only passing is offered until card definitions let `legalActions` feed this
      // decision's options (roadmap 2.1); the fuzzer casts nothing for the same reason.
      return { kind: 'priority', action: rng.pick(decision.options) };

    case 'mulligan':
      return { kind: 'mulligan', action: rng.pick(decision.options) };

    case 'bottomCards':
      return { kind: 'bottomCards', cards: rng.shuffled(decision.from).slice(0, decision.count) };

    case 'discard':
      return { kind: 'discard', cards: rng.shuffled(decision.from).slice(0, decision.count) };

    case 'declareAttackers': {
      const attacking = subset(rng, decision.legal);
      return {
        kind: 'declareAttackers',
        attackers: attacking.map((attacker) => ({
          attacker,
          defender: rng.pick(decision.defenders),
        })),
      };
    }

    case 'declareBlockers': {
      // Blocks have to be legal one at a time *and* as a whole — menace needs two
      // blockers — so build the declaration and drop it wholesale if it does not hold.
      const blocks = subset(rng, decision.available)
        .map((blocker) => {
          const canTake = decision.attackers.filter((attacker) =>
            canBlock(state, blocker, attacker),
          );
          return canTake.length === 0
            ? null
            : { blocker, blocking: [rng.pick(canTake)] as readonly ObjectId[] };
        })
        .filter(
          (block): block is { blocker: ObjectId; blocking: readonly ObjectId[] } => block !== null,
        );

      return { kind: 'declareBlockers', blocks: legalAsAWhole(state, blocks) };
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
};

/**
 * Drop any block that menace would make illegal (CR 702.110b). Declaring no blocks is
 * always legal, so falling back to that keeps the fuzzer from failing on its own choice
 * rather than on an engine bug.
 */
const legalAsAWhole = (
  state: GameState,
  blocks: readonly { readonly blocker: ObjectId; readonly blocking: readonly ObjectId[] }[],
): readonly { readonly blocker: ObjectId; readonly blocking: readonly ObjectId[] }[] => {
  const countByAttacker = new Map<ObjectId, number>();
  for (const block of blocks) {
    for (const attacker of block.blocking) {
      countByAttacker.set(attacker, (countByAttacker.get(attacker) ?? 0) + 1);
    }
  }

  const underBlocked = new Set(
    [...countByAttacker]
      .filter(([attacker, count]) => count < 2 && hasMenace(state, attacker))
      .map(([attacker]) => attacker),
  );
  if (underBlocked.size === 0) return blocks;

  return blocks.filter((block) => !block.blocking.some((attacker) => underBlocked.has(attacker)));
};

/** Read the computed keyword, not the printed one: an effect can grant menace. */
const hasMenace = (state: GameState, attacker: ObjectId): boolean =>
  state.objects.has(attacker) && keywordsOfObject(state, attacker).menace;
