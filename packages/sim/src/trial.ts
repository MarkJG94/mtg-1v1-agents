import type { TrialResult, TrialRunner } from '@mtg/agents';
import type { CardDefinition } from '@mtg/engine';
import type { AgentCounts, Deck75, OracleId } from '@mtg/shared';
import { type AgentFactory, type CycleSettings, runCycle } from './cycle.js';

/**
 * Trial batches (docs/05 "Choosing the change", step 3; roadmap 5.4): a candidate deck
 * plays `trialMatches` best-of-three matches against the opponent's current deck, and the
 * deck agent keeps the candidate that wins most.
 *
 * A trial is a short cycle — the same matches, the same alternating first choice, the
 * same sideboarding, the same statistics — with the tie rules switched off, since nobody
 * loses a trial. Its games count toward the candidate's statistics (docs/05: "trial
 * results are recorded and count toward the candidate card's statistics"): `countsFor`
 * hands back what each candidate's trial recorded, for the caller to add to the deck's.
 */

export interface TrialOptions {
  /** The opponent's deck as it stands. */
  readonly opponent: Deck75;
  /** Definitions of every card either deck may hold, asked afresh for each trial. */
  readonly definitions: () => ReadonlyMap<OracleId, CardDefinition>;
  readonly agents: AgentFactory;
  /** docs/05 `trialMatches`. */
  readonly matches: number;
  readonly settings: Pick<CycleSettings, 'turnCap' | 'maxSideboardSwaps'>;
  /** Each trial's seed is `${seed}:${candidate}`. */
  readonly seed: string;
  /** The generations the logs and matchup statistics are filed under. */
  readonly generations?: { readonly candidate: number; readonly opponent: number };
}

export interface Trials {
  readonly run: TrialRunner;
  /** The statistics a candidate's trial recorded for its deck, if it had one. */
  countsFor(candidate: OracleId): AgentCounts | undefined;
}

export const trials = (options: TrialOptions): Trials => {
  const recorded = new Map<OracleId, AgentCounts>();
  const run = async (deck: Deck75, candidate: OracleId): Promise<TrialResult> => {
    const cycle = runCycle({
      decks: { A: deck, B: options.opponent },
      definitions: options.definitions(),
      seed: `${options.seed}:${candidate}`,
      settings: {
        matchesPerCycle: options.matches,
        tieMargin: 0,
        tiebreakMatches: 0,
        turnCap: options.settings.turnCap,
        maxSideboardSwaps: options.settings.maxSideboardSwaps,
      },
      agents: options.agents,
      ...(options.generations === undefined
        ? {}
        : { generations: { A: options.generations.candidate, B: options.generations.opponent } }),
    });
    recorded.set(candidate, cycle.stats.A);
    return { matches: cycle.matches.length, winRate: cycle.winRate.A };
  };
  return { run, countsFor: (candidate) => recorded.get(candidate) };
};
