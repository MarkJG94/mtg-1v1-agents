import type {
  DeclareAttackersDecision,
  DeclareBlockersDecision,
  PlayerView,
  VisibleObject,
} from '@mtg/engine/view';
import { objectsSeenIn } from '@mtg/engine/view';
import type { ObjectId, PlayerId } from '@mtg/shared';
import { type Block, withoutLoneMenaceBlocks } from '../blocks.js';
import { evaluate } from '../evaluate.js';
import type { Weights } from '../weights.js';
import { type CombatOutcome, type PlannedAttack, projectCombat } from './model.js';

/**
 * The combat solver (docs/04 "Architecture", item 3; roadmap 4.4).
 *
 * Combat gets a solver of its own rather than the generic search, because its choices
 * multiply — every subset of attackers, against every way of blocking them — and because
 * its outcome can be worked out without the engine (`model.ts`). The solver does what
 * docs/04 describes:
 *
 * - **attacking**: enumerate a pruned set of attacks — none, all, each creature alone,
 *   every creature that is worth sending on its own, and everything but one — let the
 *   defender answer each with the block solver, and score the board that results;
 * - **blocking**: improve the blocks one attacker at a time, trying no block, every
 *   single blocker and pairs of blockers, until nothing improves; never a lone blocker on
 *   a creature with menace (CR 702.110b), and a chump block — the blocker dies, the
 *   attacker lives — only when the damage getting through would otherwise be lethal.
 *
 * "Score" is the static evaluator on the board after combat, which is where the attack
 * that leaves nothing home to block pays for it: the evaluator's threat term looks at
 * the counter-attack and the blockers that will be there for it.
 *
 * It sees what the view shows and nothing else. Blocking legality comes from the decision
 * when the viewer is blocking; when it is predicting the opponent's blocks it applies the
 * two rules the view can check — flying and reach, and protection from a colour — which
 * are the engine's own `canBlock` rules (CR 509.1b, 702.9b, 702.17a, 702.16e).
 */

/** Whether a creature could block an attacker, as far as the view can say. */
export const canMeet = (attacker: VisibleObject, blocker: VisibleObject): boolean =>
  blocker.isCreature &&
  !blocker.tapped &&
  (!attacker.keywords.flying || blocker.keywords.flying || blocker.keywords.reach) &&
  !attacker.keywords.protectionFrom.some((colour) => blocker.colours.includes(colour));

export interface BlockProblem {
  readonly view: PlayerView;
  readonly attacks: readonly PlannedAttack[];
  /** The creatures that may block. */
  readonly blockers: readonly VisibleObject[];
  readonly legal: (blocker: ObjectId, attacker: ObjectId) => boolean;
  /**
   * `defending` when the viewer is the one blocking, and wants the best board for
   * itself; `attacking` when the viewer is predicting how the opponent will block it,
   * and assumes they will pick the worst board for the viewer.
   */
  readonly as: 'defending' | 'attacking';
  readonly weights: Weights;
}

export interface BlockSolution {
  /** Each attacker's blockers, in the order its damage will be assigned. */
  readonly blocks: ReadonlyMap<ObjectId, readonly ObjectId[]>;
  readonly outcome: CombatOutcome;
  /** The evaluator on the board after combat, from the viewer's side. */
  readonly score: number;
}

/** How many of an attacker's possible blockers are tried in pairs. */
const PAIRED = 4;
const PASSES = 3;
const EPSILON = 1e-9;

export const solveBlocks = (problem: BlockProblem): BlockSolution => {
  const { view, attacks, weights } = problem;
  const sign = problem.as === 'defending' ? 1 : -1;
  const get = (id: ObjectId) => view.objects.get(id);
  const toughness = (id: ObjectId) => {
    const object = get(id);
    return object === undefined ? 0 : (object.toughness ?? 0) - object.damage;
  };

  // A later pass tries every option again, most of them against blocks it has already
  // scored; the same blocks, in the same order, always project the same (4.8).
  const projected = new Map<string, BlockSolution>();
  const project = (blocks: ReadonlyMap<ObjectId, readonly ObjectId[]>): BlockSolution => {
    const key = [...blocks].map(([attacker, blockers]) => `${attacker}:${blockers}`).join('|');
    const known = projected.get(key);
    if (known !== undefined) return known;
    const solution = projectFresh(blocks);
    projected.set(key, solution);
    return solution;
  };
  const projectFresh = (blocks: ReadonlyMap<ObjectId, readonly ObjectId[]>): BlockSolution => {
    // The attacker will put its damage on the weakest blocker first (greedy's order).
    const ordered = new Map(
      [...blocks].map(([attacker, blockers]) => [
        attacker,
        [...blockers].sort((a, b) => toughness(a) - toughness(b)),
      ]),
    );
    const outcome = projectCombat(view, { attacks, blocks: ordered });
    return { blocks: ordered, outcome, score: evaluate(outcome.view, weights) };
  };

  const defender = attacks[0]?.defender;
  const unblocked = project(new Map());
  if (defender === undefined) return unblocked;
  const life = defender === view.viewer ? view.you.life : view.opponent.life;
  const facingLethal = (unblocked.outcome.damage[defender] ?? 0) >= life;

  let best = unblocked;
  const assigned = new Map<ObjectId, readonly ObjectId[]>();
  const byPower = [...attacks].sort(
    (a, b) => (get(b.attacker)?.power ?? 0) - (get(a.attacker)?.power ?? 0),
  );

  for (let pass = 0; pass < PASSES; pass += 1) {
    let improved = false;
    for (const { attacker } of byPower) {
      const target = get(attacker);
      if (target === undefined) continue;
      const elsewhere = new Set(
        [...assigned].filter(([other]) => other !== attacker).flatMap(([, blockers]) => blockers),
      );
      const free = problem.blockers.filter(
        (blocker) => !elsewhere.has(blocker.id) && problem.legal(blocker.id, attacker),
      );

      const options: ObjectId[][] = [[]];
      if (!target.keywords.menace) for (const blocker of free) options.push([blocker.id]);
      const paired = free.slice(0, PAIRED);
      for (let i = 0; i < paired.length; i += 1) {
        for (let j = i + 1; j < paired.length; j += 1) {
          const [a, b] = [paired[i], paired[j]];
          if (a !== undefined && b !== undefined) options.push([a.id, b.id]);
        }
      }

      for (const option of options) {
        const trial = new Map(assigned);
        if (option.length === 0) trial.delete(attacker);
        else trial.set(attacker, option);
        const candidate = project(trial);
        if (sign * candidate.score <= sign * best.score + EPSILON) continue;
        if (isChump(candidate.outcome, attacker, option) && !facingLethal) continue;
        best = candidate;
        if (option.length === 0) assigned.delete(attacker);
        else assigned.set(attacker, option);
        improved = true;
      }
    }
    if (!improved) break;
  }

  return best;
};

/** The blockers die and the attacker does not: a block that only buys time (and life). */
const isChump = (outcome: CombatOutcome, attacker: ObjectId, blockers: readonly ObjectId[]) =>
  blockers.length > 0 &&
  !outcome.died.has(attacker) &&
  blockers.some((blocker) => outcome.died.has(blocker));

export interface AttackCandidate {
  readonly attackers: readonly ObjectId[];
  /** The blocks the defender is expected to answer with. */
  readonly blocks: ReadonlyMap<ObjectId, readonly ObjectId[]>;
  readonly score: number;
}

/**
 * Every attack worth considering, best first, each with the defender's expected blocks.
 * The first is the solver's answer; the search checks the first few against the engine.
 */
export const solveAttacks = (
  view: PlayerView,
  decision: DeclareAttackersDecision,
  weights: Weights,
): readonly AttackCandidate[] => {
  const defender = decision.defenders.find((target) => target.kind === 'player');
  const none: AttackCandidate = {
    attackers: [],
    blocks: new Map(),
    score: evaluate(projectCombat(view, { attacks: [], blocks: new Map() }).view, weights),
  };
  if (defender?.kind !== 'player') return [none];

  const pool = objectsSeenIn(view, decision.legal).filter((object) => (object.power ?? 0) > 0);
  const blockers = objectsSeenIn(view, view.opponent.battlefield).filter(
    (object) => object.isCreature && !object.tapped,
  );
  const get = (id: ObjectId) => view.objects.get(id);

  const tried = new Map<string, AttackCandidate>([['', none]]);
  const attackWith = (ids: readonly ObjectId[]): AttackCandidate => {
    const sorted = [...ids].sort((a, b) => a - b);
    const key = sorted.join(',');
    const known = tried.get(key);
    if (known !== undefined) return known;
    const attacks = sorted.map((attacker) => ({ attacker, defender: defender.player }));
    const solution = solveBlocks({
      view,
      attacks,
      blockers,
      legal: (blocker, attacker) => {
        const [a, b] = [get(attacker), get(blocker)];
        return a !== undefined && b !== undefined && canMeet(a, b);
      },
      as: 'attacking',
      weights,
    });
    const candidate = { attackers: sorted, blocks: solution.blocks, score: solution.score };
    tried.set(key, candidate);
    return candidate;
  };

  const ids = pool.map((object) => object.id);
  const alone = ids.map((id) => attackWith([id]));
  attackWith(ids);
  attackWith(
    alone.filter((candidate) => candidate.score >= none.score).flatMap((c) => c.attackers),
  );
  for (const id of ids) attackWith(ids.filter((other) => other !== id));

  // Best first; on a tie, the attack that risks fewer creatures.
  return [...tried.values()].sort(
    (a, b) => b.score - a.score || a.attackers.length - b.attackers.length,
  );
};

/** The viewer's own blocks, from the decision it has been given. */
export const chooseBlocks = (
  view: PlayerView,
  decision: DeclareBlockersDecision,
  weights: Weights,
): Block[] => {
  const legal = new Map(
    decision.canBlock.map((entry) => [entry.blocker, new Set(entry.attackers)]),
  );
  const attackedPlayer = (attacker: ObjectId): PlayerId =>
    view.combat?.attackers.find((entry) => entry.attacker === attacker)?.defendingPlayer ??
    view.viewer;
  const solution = solveBlocks({
    view,
    attacks: decision.attackers.map((attacker) => ({
      attacker,
      defender: attackedPlayer(attacker),
    })),
    blockers: objectsSeenIn(view, decision.available),
    legal: (blocker, attacker) => legal.get(blocker)?.has(attacker) ?? false,
    as: 'defending',
    weights,
  });
  return withoutLoneMenaceBlocks(view, blocksFrom(solution.blocks));
};

/** The solver's blocks as the engine's declaration: one entry per blocker. */
export const blocksFrom = (blocks: ReadonlyMap<ObjectId, readonly ObjectId[]>): Block[] =>
  [...blocks].flatMap(([attacker, blockers]) =>
    blockers.map((blocker) => ({ blocker, blocking: [attacker] })),
  );
