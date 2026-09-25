import {
  greedyAgent,
  type PlayAgent,
  parseWeights,
  searchAgent,
  tunableTerms,
  type Weights,
  weightTuning,
} from '@mtg/agents';
import { createRng, type GameState, type Rng } from '@mtg/engine';
import { playRung, type RungResult } from './ladder.js';

/**
 * The weight-tuning harness (docs/04 item 1, roadmap 4.7): play one set of evaluator
 * weights against another, and improve a set by hill-climbing — each step a single term
 * moved, kept only if it wins by more than chance.
 *
 * Nothing here changes a code path. A tuned set is a weights file like any other, let in
 * by `parseWeights`, and played by the same agents the ladder plays.
 *
 * **Winner's curse.** A climb that tries twenty proposals at 5% will accept about one that
 * is no better than what it replaced, and the games that accepted a proposal are the games
 * that flattered it. So a climb ends by playing what it found against where it started on
 * seeds no trial played, and reports that — the only number here that is not chosen by the
 * search that produced it.
 */

export type TuningLevel = 'greedy' | 'search' | 'deep';

/** An agent of the given level playing with the given weights. */
export const agentWith = (level: TuningLevel, weights: Weights): PlayAgent =>
  level === 'greedy' ? greedyAgent(weights) : searchAgent(level, weights);

export interface CompareOptions {
  readonly challenger: Weights;
  readonly incumbent: Weights;
  readonly level: TuningLevel;
  /** Even, so every board is played from both seats. */
  readonly games: number;
  readonly seed: string;
  readonly board?: (seed: string) => GameState;
}

/**
 * The challenger against the incumbent, each board played twice with the seats swapped.
 * `pValue` is the chance of the challenger winning this often if the two were equal.
 */
export const compareWeights = (options: CompareOptions): RungResult =>
  playRung({
    stronger: agentWith(options.level, options.challenger),
    weaker: agentWith(options.level, options.incumbent),
    games: options.games,
    seed: options.seed,
    mirrored: true,
    ...(options.board === undefined ? {} : { board: options.board }),
  });

export interface Proposal {
  readonly term: keyof Weights;
  readonly from: number;
  readonly to: number;
  readonly weights: Weights;
}

/**
 * One term moved one step: a scaled term multiplied or divided by `factor` and rounded to
 * four significant figures, a count moved by one. The direction is a coin flip; if that
 * way breaks a rule `parseWeights` holds a set to, does not move the term at all, or is a
 * move already `refused` from these weights (see `moveKey`), the other way is tried, and
 * if neither works another term is drawn. `null` when no term has a move left.
 */
export const propose = (
  weights: Weights,
  terms: readonly (keyof Weights)[],
  factor: number,
  rng: Rng,
  refused: ReadonlySet<string> = new Set(),
): Proposal | null => {
  const untried = [...terms];
  while (untried.length > 0) {
    const term = untried.splice(rng.nextInt(untried.length), 1)[0] as keyof Weights;
    const up = rng.nextBoolean();
    for (const direction of up ? [1, -1] : [-1, 1]) {
      const to = moved(term, weights[term], direction, factor);
      if (to === weights[term] || refused.has(moveKey(term, to))) continue;
      try {
        return { term, from: weights[term], to, weights: parseWeights({ ...weights, [term]: to }) };
      } catch {
        // This way breaks a rule; try the other.
      }
    }
  }
  return null;
};

/** How a move is remembered once it has been played and refused. */
export const moveKey = (term: keyof Weights, to: number): string => `${term}=${to}`;

const moved = (term: keyof Weights, value: number, direction: number, factor: number): number => {
  const tuning = weightTuning[term];
  switch (tuning.kind) {
    case 'fixed':
      return value;
    case 'count':
      return Math.max(tuning.min, value + direction);
    case 'scale':
      return Number((direction > 0 ? value * factor : value / factor).toPrecision(4));
  }
};

export interface ClimbOptions {
  readonly start: Weights;
  readonly level: TuningLevel;
  readonly seed: string;
  /** How many proposals to play. */
  readonly trials: number;
  /** Games per proposal, against the current best; even. */
  readonly gamesPerTrial: number;
  /** A proposal is kept if it wins at a one-sided p below this. */
  readonly alpha: number;
  /** What a scaled term is multiplied or divided by; 1.25 by default. */
  readonly factor?: number;
  /** Games in the held-out match between the result and the start; even. */
  readonly confirmGames: number;
  /** The terms to move; every tunable term by default. */
  readonly terms?: readonly (keyof Weights)[];
  readonly board?: (seed: string) => GameState;
  /** Told of each trial as it finishes, for a progress line. */
  readonly observe?: (trial: Trial) => void;
}

export interface Trial {
  readonly index: number;
  readonly term: keyof Weights;
  readonly from: number;
  readonly to: number;
  readonly seed: string;
  readonly result: RungResult;
  readonly accepted: boolean;
}

export interface Climb {
  readonly start: Weights;
  readonly weights: Weights;
  readonly trials: readonly Trial[];
  /**
   * Whether the climb stopped because every move from where it ended had been played and
   * refused — a local optimum at this step size and bar — rather than for want of trials.
   */
  readonly converged: boolean;
  /**
   * What the climb found against where it started, on seeds no trial played. `null` when
   * nothing was accepted, since the result is then the start.
   */
  readonly confirmation: (RungResult & { readonly seed: string }) | null;
}

export const hillClimb = (options: ClimbOptions): Climb => {
  const rng = createRng(`${options.seed}:proposals`);
  const terms = options.terms ?? tunableTerms;
  const factor = options.factor ?? 1.25;
  const trials: Trial[] = [];
  // A move refused from the current best is not played again until the best changes: the
  // same move against the same weights asks the same question, and a second sample of it
  // is a second chance for luck to pass what the first refused.
  const refused = new Set<string>();
  let best = options.start;
  let converged = false;

  for (let index = 0; index < options.trials; index += 1) {
    const proposal = propose(best, terms, factor, rng, refused);
    if (proposal === null) {
      converged = true;
      break;
    }
    const seed = `${options.seed}:trial-${index}`;
    const result = compareWeights({
      challenger: proposal.weights,
      incumbent: best,
      level: options.level,
      games: options.gamesPerTrial,
      seed,
      ...(options.board === undefined ? {} : { board: options.board }),
    });
    const accepted = result.pValue < options.alpha;
    if (accepted) {
      best = proposal.weights;
      refused.clear();
    } else {
      refused.add(moveKey(proposal.term, proposal.to));
    }
    const trial: Trial = {
      index,
      term: proposal.term,
      from: proposal.from,
      to: proposal.to,
      seed,
      result,
      accepted,
    };
    trials.push(trial);
    options.observe?.(trial);
  }

  if (best === options.start)
    return { start: options.start, weights: best, trials, converged, confirmation: null };
  const seed = `${options.seed}:confirm`;
  const confirmation = compareWeights({
    challenger: best,
    incumbent: options.start,
    level: options.level,
    games: options.confirmGames,
    seed,
    ...(options.board === undefined ? {} : { board: options.board }),
  });
  return {
    start: options.start,
    weights: best,
    trials,
    converged,
    confirmation: { ...confirmation, seed },
  };
};
