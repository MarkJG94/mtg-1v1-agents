import type { GameEvent, PlayerId } from '@mtg/shared';
import type { CardDefinition } from '../definition.js';
import { createGame, step } from '../game.js';
import { Rng } from '../rng.js';
import type { Decision, DecisionAnswer, GameConfig, GameState } from '../state.js';
import { checkInvariants } from './invariants.js';
import { randomAnswer } from './random.js';

export interface PlayResult {
  state: GameState;
  events: GameEvent[];
  decisions: number;
  answers: DecisionAnswer[];
}

export type Chooser = (state: GameState, decision: Decision, rng: Rng) => DecisionAnswer;

export interface PlayOptions {
  definitions: Record<string, CardDefinition>;
  decks: Record<PlayerId, string[]>;
  seed: string | number;
  config?: Partial<GameConfig>;
  onPlay?: PlayerId;
  /** Per-player chooser; defaults to the random agent. */
  choosers?: Partial<Record<PlayerId, Chooser>>;
  /** Check invariants after every step (slow; for fuzzing). */
  invariants?: boolean;
  /** Bias toward passing priority for the random agent, so games progress. */
  passBias?: number;
}

/** Plays a whole game with the given choosers (random by default) and returns the final state and event log. */
export function playGame(opts: PlayOptions): PlayResult {
  const setup: Parameters<typeof createGame>[0] = {
    definitions: opts.definitions,
    decks: opts.decks,
    seed: opts.seed,
  };
  if (opts.config) setup.config = opts.config;
  if (opts.onPlay) setup.onPlay = opts.onPlay;
  let { state, events } = createGame(setup);
  const log: GameEvent[] = events.slice();
  const rng = Rng.from(`${opts.seed}:agent`);
  const deckSizes = { A: opts.decks.A.length, B: opts.decks.B.length };
  const answers: DecisionAnswer[] = [];
  let decisions = 0;
  const defaultChooser: Chooser = (s, dec, r) =>
    randomAnswer(s, dec, r, { passBias: opts.passBias ?? 0.3 });
  if (opts.invariants) checkInvariants(state, deckSizes);
  while (!state.result) {
    const dec = state.pendingDecision;
    if (!dec) throw new Error('no decision and no result');
    const chooser = opts.choosers?.[dec.player] ?? defaultChooser;
    const answer = chooser(state, dec, rng);
    answers.push(answer);
    decisions++;
    const r = step(state, answer);
    state = r.state;
    log.push(...r.events);
    if (opts.invariants) checkInvariants(state, deckSizes);
  }
  return { state, events: log, decisions, answers };
}

/** Replays a recorded answer sequence; used to check determinism. */
export function replayGame(
  opts: Omit<PlayOptions, 'choosers'>,
  answers: DecisionAnswer[],
): PlayResult {
  const setup: Parameters<typeof createGame>[0] = {
    definitions: opts.definitions,
    decks: opts.decks,
    seed: opts.seed,
  };
  if (opts.config) setup.config = opts.config;
  if (opts.onPlay) setup.onPlay = opts.onPlay;
  let { state, events } = createGame(setup);
  const log: GameEvent[] = events.slice();
  let i = 0;
  while (!state.result && i < answers.length) {
    const r = step(state, answers[i++]!);
    state = r.state;
    log.push(...r.events);
  }
  return { state, events: log, decisions: i, answers: answers.slice(0, i) };
}
