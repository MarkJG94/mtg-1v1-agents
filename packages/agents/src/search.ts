import type {
  Decision,
  DecisionResponse,
  DeclareAttackersDecision,
  DeclareBlockersDecision,
  PlayerView,
  PriorityAction,
  PriorityDecision,
  Rng,
  Simulator,
  World,
  WorldStatus,
} from '@mtg/engine/view';
import { combatPolicy } from './combat/policy.js';
import { chooseBlocks, solveAttacks } from './combat/solver.js';
import { evaluate } from './evaluate.js';
import { greedyAgent } from './greedy.js';
import type { PlayAgent } from './play-agent.js';
import { defaultWeights, type Weights } from './weights.js';

/** The steps a combat decision's line plays through before it is scored. */
const combatSteps: ReadonlySet<PlayerView['step']> = new Set([
  'declareAttackers',
  'declareBlockers',
  'firstStrikeDamage',
  'combatDamage',
]);

/**
 * The `search` and `deep` levels (docs/04 "Architecture: evaluator + bounded search").
 *
 * At a priority decision this plays each candidate action forward in **determinisations**
 * of the game — the game as this player knows it, with the opponent's hand and both
 * libraries sampled (ADR 0012) — using the real rules, and takes the action whose
 * position scores best on the static evaluator once the dust has settled.
 *
 * "Settled" is the **horizon**: the stack is empty and the game has moved on to another
 * step. Everything on the way there is played out — a spell resolves, its triggers fire,
 * state-based actions kill what they kill — so a burn spell is worth exactly the creature
 * it really kills, which is what greedy had to guess at with a prior (ADR 0011).
 *
 * The lines it considers are **depth-2 with a beam**, as docs/04 describes:
 *
 * - **the opponent answers.** Where the opponent could act on the way to the horizon, it
 *   considers their passing and their few most damaging responses, and assumes the worst
 *   of them — "my action, then the opponent's best cheap response";
 * - **its own follow-ups are sequenced.** Where it gets priority again before the
 *   horizon — the creature has resolved and it is still the main phase — it may take
 *   further actions, so "play a land, then cast the two-drop it enables" is one line;
 * - **a beam keeps that affordable.** Every option gets a one-step look first (played to
 *   the horizon with nobody doing anything more), and only the best few are searched
 *   further.
 *
 * **The budget is in engine steps, not milliseconds**, because a game has to be a pure
 * function of its seed and a clock is not. A candidate whose search ran out of budget
 * part-way is not compared on its half-finished score; the decision falls back to the
 * candidates that finished, or to the one-step looks if none did.
 *
 * **Combat** is the combat solver's (roadmap 4.4, `combat/solver.ts`), which works out
 * attacks and blocks from a model of combat damage rather than the engine. The search
 * checks the solver's best few answers the same way it checks priority actions — each
 * played through the real combat in every world, the opponent blocking with the solver
 * too — so what the model cannot see (a prevention shield, a trigger) is still caught.
 *
 * Every other kind of decision — mulligans, discards, ordering — is greedy's.
 */

export interface SearchSettings {
  /** Determinisations per decision. A candidate is scored by its mean over all of them. */
  readonly samples: number;
  /** Own actions searched further at each decision, after a one-step look at every one. */
  readonly beam: number;
  /** How many more of its own actions a line may take after the first — sequencing. */
  readonly followUps: number;
  /** How many opponent decisions along one line are searched rather than passed. */
  readonly replies: number;
  /** Opponent responses considered at each of those, besides passing. */
  readonly responses: number;
  /** Engine steps — decisions applied in a world — that one decision may spend. */
  readonly budget: number;
  /**
   * The combat solver's best attacks checked against the engine at each attack decision
   * (its blocks, no blocks and greedy's blocks at each block decision). Zero leaves combat
   * to greedy's rules of thumb, which is how the solver's own worth is measured.
   */
  readonly combatCandidates: number;
}

/** What one search saw, for a test or a UI that wants to say why it chose what it did. */
export interface SearchReport {
  readonly candidates: readonly {
    readonly action: PriorityAction;
    /** Mean over the worlds of the one-step look: act, then everyone passes to the horizon. */
    readonly shallow: number | null;
    /** Mean over the worlds of the full search, or `null` if the budget did not cover it. */
    readonly deep: number | null;
  }[];
  readonly chosen: PriorityAction;
  /** Engine steps spent, against the budget. */
  readonly spent: number;
}

export const searchLevels = {
  search: {
    samples: 2,
    beam: 3,
    followUps: 2,
    replies: 1,
    responses: 2,
    budget: 600,
    combatCandidates: 3,
  },
  deep: {
    samples: 4,
    beam: 5,
    followUps: 3,
    replies: 2,
    responses: 3,
    budget: 4_000,
    combatCandidates: 5,
  },
} as const satisfies Record<'search' | 'deep', SearchSettings>;

export const searchAgent = (
  level: 'search' | 'deep' = 'search',
  weights: Weights = defaultWeights,
  settings: SearchSettings = searchLevels[level],
  observe?: (report: SearchReport) => void,
): PlayAgent => {
  const greedy = greedyAgent(weights);
  const solving = settings.combatCandidates > 0;
  const policy = solving ? combatPolicy(weights) : greedy;
  return {
    level,
    decide: (view, decision, rng, simulator): DecisionResponse => {
      if (
        solving &&
        (decision.kind === 'declareAttackers' || decision.kind === 'declareBlockers')
      ) {
        const candidates = combatCandidates(
          view,
          decision,
          weights,
          settings,
          greedy,
          rng,
          simulator,
        );
        if (candidates.length < 2)
          return candidates[0] ?? policy.decide(view, decision, rng, simulator);
        return new Search(view, simulator, rng, weights, settings, policy).chooseAmong(candidates);
      }
      if (decision.kind !== 'priority') return policy.decide(view, decision, rng, simulator);
      if (decision.options.every((option) => option.kind === 'pass')) return passing;
      const search = new Search(view, simulator, rng, weights, settings, policy);
      const report = search.choose(decision);
      observe?.(report);
      return { kind: 'priority', action: report.chosen };
    },
  };
};

const passing = { kind: 'priority', action: { kind: 'pass' } } as const;

/**
 * The answers worth checking at a combat decision, the solver's choice first: its best
 * few attacks and not attacking; or its blocks, not blocking, and greedy's blocks.
 */
const combatCandidates = (
  view: PlayerView,
  decision: DeclareAttackersDecision | DeclareBlockersDecision,
  weights: Weights,
  settings: SearchSettings,
  greedy: PlayAgent,
  rng: Rng,
  simulator: Simulator,
): DecisionResponse[] => {
  const responses: DecisionResponse[] = [];
  if (decision.kind === 'declareAttackers') {
    const defender = decision.defenders.find((target) => target.kind === 'player');
    if (defender === undefined) return [{ kind: 'declareAttackers', attackers: [] }];
    const ranked = solveAttacks(view, decision, weights);
    const chosen = [...ranked.slice(0, settings.combatCandidates)];
    if (!chosen.some((candidate) => candidate.attackers.length === 0)) {
      chosen.push({ attackers: [], blocks: new Map(), score: 0 });
    }
    for (const candidate of chosen) {
      responses.push({
        kind: 'declareAttackers',
        attackers: candidate.attackers.map((attacker) => ({ attacker, defender })),
      });
    }
  } else {
    responses.push(
      { kind: 'declareBlockers', blocks: chooseBlocks(view, decision, weights) },
      { kind: 'declareBlockers', blocks: [] },
      greedy.decide(view, decision, rng, simulator),
    );
  }
  const seen = new Set<string>();
  return responses.filter((response) => {
    const key = JSON.stringify(response);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** One decision's search: its worlds, its budget, and the horizon it plays to. */
class Search {
  private spent = 0;
  private readonly me;
  private readonly root;

  constructor(
    view: PlayerView,
    private readonly simulator: Simulator,
    private readonly rng: Rng,
    private readonly weights: Weights,
    private readonly settings: SearchSettings,
    private readonly policy: PlayAgent,
  ) {
    this.me = view.viewer;
    // A priority decision is settled once the game leaves its step; a combat decision
    // once combat damage has been dealt, which takes several steps to reach.
    const combat = view.step === 'declareAttackers' || view.step === 'declareBlockers';
    this.root = { turn: view.turn, stays: combat ? combatSteps : new Set([view.step]) };
  }

  /**
   * Answer a combat decision: each candidate played through the real combat in every
   * world, the mean kept, the best taken — and, if the budget runs out first, the
   * solver's own choice, which is the first candidate.
   */
  chooseAmong(candidates: readonly DecisionResponse[]): DecisionResponse {
    const worlds: World[] = [];
    for (let i = 0; i < this.settings.samples; i += 1) {
      worlds.push(this.simulator.sample(this.rng.fork(`world:${i}`)));
    }
    const scores: number[] = [];
    for (const candidate of candidates) {
      let total = 0;
      for (const world of worlds) {
        if (this.exhausted()) return candidates[0] ?? candidate;
        this.spent += 1;
        total += this.value(this.simulator.apply(world, candidate), 0, 0);
      }
      if (this.exhausted()) return candidates[0] ?? candidate;
      scores.push(total / Math.max(1, worlds.length));
    }
    let best = 0;
    for (let i = 1; i < scores.length; i += 1) {
      if ((scores[i] ?? 0) > (scores[best] ?? 0)) best = i;
    }
    return candidates[best] ?? passing;
  }

  choose(decision: PriorityDecision): SearchReport {
    const worlds: World[] = [];
    for (let i = 0; i < this.settings.samples; i += 1) {
      worlds.push(this.simulator.sample(this.rng.fork(`world:${i}`)));
    }
    const first = worlds[0];
    if (first === undefined) return this.report([], null, null, { kind: 'pass' });

    // One-step looks at everything, in the first world, to choose what to search.
    const looks = decision.options.map((action) => ({
      action,
      look: this.quickLook(first, action),
    }));
    const shortlist = this.shortlist(looks, this.settings.beam, 'best');

    // Candidates are only ever compared at a depth every one of them reached: the
    // one-step look in every world, then the full search if the budget covers all of it.
    // Comparing a finished candidate with one the budget cut short would favour whichever
    // was searched first, which is passing.
    const shallow = this.scoreAll(shortlist, worlds, 0, 0);
    if (shallow === null) {
      const chosen = argmax(
        looks.map((entry) => entry.action),
        looks.map((entry) => entry.look),
      );
      return this.report(shortlist, null, null, chosen);
    }
    const deep = this.scoreAll(shortlist, worlds, this.settings.followUps, this.settings.replies);
    // A tie at depth is common — the opponent's most damaging reply is often a different
    // one in each line and costs the same — and is broken by the one-step look, so a land
    // that is plainly worth playing is not passed over because both lines end equal.
    const chosen = deep === null ? argmax(shortlist, shallow) : argmax(shortlist, deep, shallow);
    return this.report(shortlist, shallow, deep, chosen);
  }

  private report(
    candidates: readonly PriorityAction[],
    shallow: readonly number[] | null,
    deep: readonly number[] | null,
    chosen: PriorityAction,
  ): SearchReport {
    return {
      candidates: candidates.map((action, i) => ({
        action,
        shallow: shallow?.[i] ?? null,
        deep: deep?.[i] ?? null,
      })),
      chosen,
      spent: this.spent,
    };
  }

  /** Every candidate's mean value over the worlds, or `null` if the budget ran out first. */
  private scoreAll(
    candidates: readonly PriorityAction[],
    worlds: readonly World[],
    followUps: number,
    replies: number,
  ): number[] | null {
    const scores: number[] = [];
    for (const action of candidates) {
      let total = 0;
      for (const world of worlds) {
        if (this.exhausted()) return null;
        total += this.value(this.act(world, action), followUps, replies);
      }
      if (this.exhausted()) return null;
      scores.push(total / worlds.length);
    }
    return scores;
  }

  /**
   * The value of a world to the searcher, once it has been run to the horizon. `followUps`
   * and `replies` are what this line may still spend on its own actions and on searching
   * the opponent's.
   */
  private value(world: World, followUps: number, replies: number): number {
    let current = world;
    for (;;) {
      if (this.exhausted()) return this.score(current);
      const decision = this.simulator.decision(current);
      if (decision === null) return this.score(current);
      const status = this.simulator.status(current);
      if (this.atHorizon(status)) return this.score(current);

      if (decision.kind !== 'priority') {
        current = this.answer(current, decision);
        continue;
      }
      const choices = decision.options.some((option) => option.kind !== 'pass');
      if (choices && decision.player === this.me) {
        // Never respond to its own spell: it is the one that wanted it to resolve.
        if (followUps > 0 && status.topOfStack !== this.me) {
          return this.bestOf(current, decision, followUps - 1, replies);
        }
      } else if (choices && replies > 0) {
        return this.worstOf(current, decision, followUps, replies - 1);
      }
      current = this.act(current, { kind: 'pass' });
    }
  }

  /** The searcher's own choice: the best of passing and its beam of actions. */
  private bestOf(
    world: World,
    decision: PriorityDecision,
    followUps: number,
    replies: number,
  ): number {
    const looks = decision.options.map((action) => ({
      action,
      look: this.quickLook(world, action),
    }));
    if (followUps === 0 && replies === 0) return Math.max(...looks.map((entry) => entry.look));
    let best = Number.NEGATIVE_INFINITY;
    for (const action of this.shortlist(looks, this.settings.beam, 'best')) {
      if (this.exhausted()) break;
      best = Math.max(best, this.value(this.act(world, action), followUps, replies));
    }
    return Number.isFinite(best) ? best : this.score(world);
  }

  /** The opponent's choice: the worst for the searcher of passing and a few responses. */
  private worstOf(
    world: World,
    decision: PriorityDecision,
    followUps: number,
    replies: number,
  ): number {
    const looks = decision.options.map((action) => ({
      action,
      look: this.quickLook(world, action),
    }));
    let worst = Number.POSITIVE_INFINITY;
    for (const action of this.shortlist(looks, this.settings.responses, 'worst')) {
      if (this.exhausted()) break;
      worst = Math.min(worst, this.value(this.act(world, action), followUps, replies));
    }
    return Number.isFinite(worst) ? worst : this.score(world);
  }

  /** Take the action and play to the horizon with nobody choosing anything more. */
  private quickLook(world: World, action: PriorityAction): number {
    if (this.exhausted()) return this.score(world);
    return this.value(this.act(world, action), 0, 0);
  }

  /**
   * Passing, plus the `width` actions whose one-step looks are best (or worst, for the
   * opponent) — passing first, so that on a tie nothing beats doing nothing.
   */
  private shortlist(
    looks: readonly { readonly action: PriorityAction; readonly look: number }[],
    width: number,
    want: 'best' | 'worst',
  ): PriorityAction[] {
    const ranked = looks
      .filter((entry) => entry.action.kind !== 'pass')
      .sort((a, b) => (want === 'best' ? b.look - a.look : a.look - b.look))
      .slice(0, width)
      .map((entry) => entry.action);
    return [{ kind: 'pass' }, ...ranked];
  }

  /** Settled: the stack is empty and the game has left the step (or the combat) it was in. */
  private atHorizon(status: WorldStatus): boolean {
    if (status.result !== null) return true;
    if (status.stackSize > 0) return false;
    return status.turn !== this.root.turn || !this.root.stays.has(status.step);
  }

  private act(world: World, action: PriorityAction): World {
    this.spent += 1;
    return this.simulator.apply(world, { kind: 'priority', action });
  }

  /** Anything that is not a priority decision, answered by the policy: greedy, and the solver. */
  private answer(world: World, decision: Exclude<Decision, PriorityDecision>): World {
    this.spent += 1;
    const view = this.simulator.view(world, decision.player);
    return this.simulator.apply(
      world,
      this.policy.decide(view, decision, this.rng, this.simulator),
    );
  }

  private score(world: World): number {
    return evaluate(this.simulator.view(world, this.me), this.weights);
  }

  private exhausted(): boolean {
    return this.spent >= this.settings.budget;
  }
}

/**
 * The candidate with the highest score, ties broken by `then` where it is given and
 * after that by order — and passing always comes first, so nothing beats doing nothing
 * without a reason.
 */
const argmax = (
  candidates: readonly PriorityAction[],
  scores: readonly number[],
  then: readonly number[] = scores,
): PriorityAction => {
  const at = (list: readonly number[], i: number) => list[i] ?? Number.NEGATIVE_INFINITY;
  let best = 0;
  for (let i = 1; i < scores.length; i += 1) {
    const ahead = at(scores, i) - at(scores, best);
    if (ahead > 0 || (ahead === 0 && at(then, i) > at(then, best))) best = i;
  }
  return candidates[best] ?? { kind: 'pass' };
};
