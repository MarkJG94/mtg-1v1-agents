import type { PlayAgent } from '@mtg/agents';
import type { GameState } from '@mtg/engine';
import { fuzzBoard } from '@mtg/engine/testing';
import type { PlayerId } from '@mtg/shared';
import { playGame } from './game.js';

/**
 * The sanity ladder (docs/09): each agent level must beat the one below it by more than
 * chance allows — `search` beats `greedy` beats `random`. It guards against the failure
 * nothing else would notice, an evaluator or search change that makes the AI *worse*.
 *
 * A rung is a run of games between two agents on fuzz boards, alternating seats so that
 * neither always has the play, and judged by an exact one-sided binomial test over the
 * games that were decided: how likely is a win count this high if the two were equal?
 */

export interface RungOptions {
  readonly stronger: PlayAgent;
  readonly weaker: PlayAgent;
  readonly games: number;
  /** Seeds are `${seed}-${i}`, so a rung is the same games every time it is run. */
  readonly seed: string;
  /** The board each game starts from; three creatures a side by default. */
  readonly board?: (seed: string) => GameState;
}

export interface RungResult {
  readonly wins: number;
  readonly losses: number;
  readonly draws: number;
  /** P(this many wins or more | the two agents are equal), over the decided games. */
  readonly pValue: number;
}

export const defaultRungBoard = (seed: string): GameState =>
  fuzzBoard(seed, { creatures: 3, librarySize: 30 });

export const playRung = (options: RungOptions): RungResult => {
  const board = options.board ?? defaultRungBoard;
  let wins = 0;
  let losses = 0;
  let draws = 0;
  for (let i = 0; i < options.games; i += 1) {
    const seed = `${options.seed}-${i}`;
    const seat: PlayerId = i % 2 === 0 ? 'A' : 'B';
    const agents =
      seat === 'A'
        ? { A: options.stronger, B: options.weaker }
        : { A: options.weaker, B: options.stronger };
    const { result } = playGame(board(seed), agents, seed);
    if (result === null || result.winner === null) draws += 1;
    else if (result.winner === seat) wins += 1;
    else losses += 1;
  }
  return { wins, losses, draws, pValue: tailAtLeast(wins, wins + losses) };
};

/** One-sided exact binomial tail: P(X >= k) for X ~ Binomial(n, 1/2). */
export const tailAtLeast = (k: number, n: number): number => {
  let total = 0;
  let term = 0.5 ** n; // C(n, 0) / 2^n
  for (let i = 0; i <= n; i += 1) {
    if (i >= k) total += term;
    term = (term * (n - i)) / (i + 1);
  }
  return total;
};
