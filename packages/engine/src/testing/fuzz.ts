import { asOracleId, playerIds, playerZone, skipsPriority } from '@mtg/shared';
import { characteristicsOf, remainingToughness } from '../characteristics.js';
import type { Decision, DecisionResponse } from '../decision.js';
import { createEventEmitter } from '../events/emitter.js';
import { createRng } from '../rng.js';
import { legendGroups } from '../sba.js';
import { setUpGame } from '../setup.js';
import { isStackEmpty } from '../stack.js';
import {
  type CreateGameStateOptions,
  createGameState,
  type GameState,
  isGameOver,
} from '../state/game-state.js';
import { checkStateInvariants, createObject, getObject, objectsIn } from '../state/update.js';
import { applyDecision } from '../turn/turn.js';
import { fuzzDeck, fuzzLand } from './fuzz-cards.js';
import { randomDecision } from './random-agent.js';

/**
 * The invariant fuzzer (docs/09 "Invariant fuzzing").
 *
 * Play many random games and assert, after every single decision, that the game is still
 * a legal position. The value is not the coverage — it is that a random player reaches
 * lines nobody would deliberately write a test for, and that when it breaks, the seed
 * reproduces it exactly.
 *
 * A failure reports the seed, the turn, and how many decisions in it happened, which is
 * everything needed to replay it. Automatic minimisation to the shortest failing decision
 * prefix is docs/09's next refinement and wants the shrinking that a property-testing
 * library gives; the seed alone has been enough so far.
 *
 * It used to exercise only the framework — the turn loop, priority, mulligans, combat,
 * state-based actions, cleanup, the caps and loop detection — because nothing could be
 * cast: the priority decision offered only `pass`. 4.2 wired `legalActions` into that
 * decision and dealt the fuzzer a small deck (`fuzz-cards.ts`), so games now pay costs,
 * choose targets, put spells and triggered abilities on the stack and resolve them. That
 * is a different and much larger surface, which is the point.
 */

export interface FuzzOptions extends Partial<CreateGameStateOptions> {
  /** Cards dealt into each library before the game is set up. */
  readonly librarySize?: number;
  /** Creatures put onto each battlefield, so combat actually happens. */
  readonly creatures?: number;
  /** Stop a runaway game; a fuzz game that needs more than this is itself a finding. */
  readonly maxDecisions?: number;
}

export interface FuzzResult {
  readonly seed: string;
  readonly state: GameState;
  /** Every decision answered, in order, so the game can be replayed exactly. */
  readonly decisions: readonly DecisionResponse[];
  readonly turns: number;
}

export class InvariantViolation extends Error {
  constructor(
    readonly seed: string,
    readonly decisionsMade: number,
    readonly problems: readonly string[],
    readonly state: GameState,
  ) {
    super(
      `invariants violated in fuzz game "${seed}" after ${decisionsMade} decision(s) ` +
        `on turn ${state.turn} (${state.step}):\n  ${problems.join('\n  ')}`,
    );
    this.name = 'InvariantViolation';
  }
}

/**
 * The rules invariants docs/09 asks for, on top of the structural ones in
 * `checkStateInvariants`. These need the layer system and the state-based actions, which
 * is why they live here rather than beside the state.
 *
 * All of them are checked at a decision point, which is the only moment they are all
 * supposed to hold: mid-resolution a creature may briefly have lethal damage, and that is
 * not a bug.
 */
export const checkRulesInvariants = (state: GameState): string[] => {
  const problems = [...checkStateInvariants(state)];
  if (isGameOver(state)) return problems;

  // State-based actions have run, so no creature is left on the battlefield with zero
  // toughness (CR 704.5f) or lethal damage marked (CR 704.5g). Indestructible survives
  // the second but not the first, which is the distinction worth catching.
  for (const id of objectsIn(state, 'battlefield')) {
    const traits = characteristicsOf(state, id);
    if (!traits.isCreature) continue;

    if ((traits.toughness ?? 1) <= 0) {
      problems.push(`creature ${id} is on the battlefield with toughness ${traits.toughness}`);
      continue;
    }
    if (!traits.keywords.indestructible && remainingToughness(state, id) <= 0) {
      problems.push(
        `creature ${id} is on the battlefield with lethal damage (${getObject(state, id).damage} marked, toughness ${traits.toughness})`,
      );
    }
  }

  // CR 704.5j: and no two legendary permanents with the same name under one controller.
  for (const group of legendGroups(state)) {
    problems.push(
      `${group.player} controls ${group.objects.length} legendary permanents named "${group.name}"`,
    );
  }

  const decision = state.pendingDecision;
  if (decision) {
    // A decision must belong to a real player, or nobody can answer it.
    if (!playerIds.includes(decision.player)) {
      problems.push(`a ${decision.kind} decision is pending for unknown player ${decision.player}`);
    }
    // CR 117.1: whoever has priority is the one being asked.
    if (decision.kind === 'priority' && state.priority !== decision.player) {
      problems.push(
        `${decision.player} was asked for a priority decision but priority is with ${state.priority}`,
      );
    }
    // No player receives priority in untap or cleanup (CR 502.3, 514.3).
    if (decision.kind === 'priority' && skipsPriority(state.step)) {
      problems.push(`priority was granted in the ${state.step} step`);
    }
  }

  // The stack cannot survive a step boundary: a step only ends when it is empty
  // (CR 500.2), so anything on it belongs to the step it was cast in.
  if (state.turn > 0 && !isStackEmpty(state) && skipsPriority(state.step)) {
    problems.push(`the stack is not empty in the ${state.step} step`);
  }

  return problems;
};

const assertInvariants = (state: GameState, seed: string, decisionsMade: number): void => {
  const problems = checkRulesInvariants(state);
  if (problems.length > 0) throw new InvariantViolation(seed, decisionsMade, problems, state);
};

/** Build the starting position: libraries, and some creatures so combat happens. */
const buildBoard = (seed: string, options: FuzzOptions): GameState => {
  const rng = createRng(`${seed}:board`);
  let state = createGameState({
    rng: createRng(seed).save(),
    onPlay: rng.pick(playerIds),
    definitions: fuzzDeck,
    ...options,
  });

  const definitionId = asOracleId('fuzz-card');

  for (const player of playerIds) {
    for (let i = 0; i < (options.librarySize ?? 30); i += 1) {
      // Half lands, half spells: a deck that cannot pay for anything fuzzes the same
      // passing-only game the fuzzer played before it had cards at all.
      const card = i % 2 === 0 ? fuzzLand : rng.pick(fuzzDeck);
      state = createObject(state, {
        definitionId: card.oracleId,
        owner: player,
        zone: playerZone(player, 'library'),
      }).state;
    }
    for (let i = 0; i < (options.creatures ?? 3); i += 1) {
      const created = createObject(state, {
        definitionId,
        owner: player,
        zone: 'battlefield',
        power: rng.nextIntBetween(0, 4),
        toughness: rng.nextIntBetween(1, 4),
      });
      state = created.state;
    }
  }

  return state;
};

/**
 * Play one random game from a seed. `check` runs on the state after every decision: the
 * fuzzer asserts the invariants there, and the benchmarks pass a no-op, because checking
 * them costs several times what playing the game does and is not engine time.
 *
 * Both take the same path and draw from the same generator, so a benchmark game and a
 * fuzz game from one seed are the same game.
 */
const playGame = (
  seed: string,
  options: FuzzOptions,
  check: (state: GameState, decisionsMade: number) => void,
): FuzzResult => {
  const rng = createRng(`${seed}:play`);
  const emitter = createEventEmitter();
  const decisions: DecisionResponse[] = [];
  const maxDecisions = options.maxDecisions ?? 5_000;

  let state = setUpGame(buildBoard(seed, options), emitter);
  check(state, 0);

  while (!isGameOver(state) && decisions.length < maxDecisions) {
    const decision: Decision | null = state.pendingDecision;
    if (!decision) {
      throw new InvariantViolation(
        seed,
        decisions.length,
        ['the game is neither over nor waiting on a decision'],
        state,
      );
    }

    const response = randomDecision(state, decision, rng);
    decisions.push(response);
    state = applyDecision(state, emitter, response);
    check(state, decisions.length);
  }

  if (!isGameOver(state)) {
    throw new InvariantViolation(
      seed,
      decisions.length,
      [`the game did not finish within ${maxDecisions} decisions`],
      state,
    );
  }

  return { seed, state, decisions, turns: state.turn };
};

const noCheck = (): void => {};

/**
 * Play a random game and check nothing, which is what `bench/` measures: the invariant
 * checks are the fuzzer's job and would otherwise be most of the time recorded.
 */
export const playRandomGame = (seed: string, options: FuzzOptions = {}): FuzzResult =>
  playGame(seed, options, noCheck);

/** Play one random game from a seed, asserting the invariants after every decision. */
export const fuzzGame = (seed: string, options: FuzzOptions = {}): FuzzResult =>
  playGame(seed, options, (state, decisionsMade) => assertInvariants(state, seed, decisionsMade));

/**
 * Replay a recorded game and check it lands in the same place.
 *
 * This is the engine's own contract from docs/01 — a game is a pure function of its seed
 * and its decisions — and it is the one docs/09 asks the fuzzer to hold. The stronger
 * `replay(log) == state`, rebuilding from the event log rather than the decisions, needs
 * a log consumer that does not exist yet and belongs with the replay viewer.
 */
export const replayIsIdentical = (result: FuzzResult, options: FuzzOptions = {}): boolean => {
  const emitter = createEventEmitter();
  let state = setUpGame(buildBoard(result.seed, options), emitter);

  for (const response of result.decisions) {
    if (isGameOver(state) || state.pendingDecision === null) break;
    state = applyDecision(state, emitter, response);
  }

  return sameState(state, result.state);
};

/**
 * Compare two states by everything that matters, which is what the loop detector already
 * knows how to do — with the turn and result on top, since those differ between games
 * the detector would call the same position.
 */
const sameState = (a: GameState, b: GameState): boolean =>
  a.turn === b.turn &&
  a.step === b.step &&
  a.result?.winner === b.result?.winner &&
  a.result?.reason === b.result?.reason &&
  playerIds.every((player) => a.players[player].life === b.players[player].life) &&
  a.objects.size === b.objects.size &&
  sameZones(a, b);

const sameZones = (a: GameState, b: GameState): boolean =>
  objectsIn(a, 'battlefield').length === objectsIn(b, 'battlefield').length &&
  playerIds.every((player) =>
    (['hand', 'graveyard', 'library'] as const).every(
      (kind) =>
        objectsIn(a, playerZone(player, kind)).length ===
        objectsIn(b, playerZone(player, kind)).length,
    ),
  );

/** Run many games, returning what each finished as. Throws on the first violation. */
export const fuzzGames = (
  count: number,
  options: FuzzOptions & { readonly seedPrefix?: string } = {},
): readonly FuzzResult[] => {
  const prefix = options.seedPrefix ?? 'fuzz';
  return Array.from({ length: count }, (_, i) => fuzzGame(`${prefix}-${i}`, options));
};
