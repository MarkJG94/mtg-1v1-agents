import {
  allZoneIds,
  type Board,
  type BoardObject,
  emptyBoard,
  kindOfZone,
  playerIds,
  replayEvents,
} from '@mtg/shared';
import { isCreature } from '../characteristics.js';
import type { DecisionResponse } from '../decision.js';
import { createEventEmitter } from '../events/emitter.js';
import { createRng } from '../rng.js';
import { setUpGame } from '../setup.js';
import { type GameState, isGameOver } from '../state/game-state.js';
import { objectsIn } from '../state/update.js';
import { applyDecision } from '../turn/turn.js';
import { type FuzzOptions, type FuzzResult, fuzzBoard, InvariantViolation } from './fuzz.js';
import { randomDecision } from './random-agent.js';

/**
 * docs/09's `replay(log) == state`: what the event log says the board is, held against
 * what the engine says it is. Each difference is a fact the log failed to record — or
 * recorded wrongly — and so a replay would draw wrongly.
 *
 * Compared: every zone's contents (a library as a set, since its shuffled order is hidden
 * and never logged; the stack in order, since its order is what resolves first), each
 * permanent's tapped state and counters, marked damage on creatures, life, poison, the
 * turn, the step, the active player and the result.
 */
export const boardDifferences = (board: Board, state: GameState): string[] => {
  const differences: string[] = [];
  const note = (what: string, logged: unknown, engine: unknown) => {
    if (JSON.stringify(logged) !== JSON.stringify(engine)) {
      differences.push(`${what}: log ${JSON.stringify(logged)}, engine ${JSON.stringify(engine)}`);
    }
  };

  note('turn', board.turn, state.turn);
  note('step', board.step, state.turn === 0 ? board.step : state.step);
  if (state.turn > 0) note('active player', board.activePlayer, state.activePlayer);
  note(
    'result',
    board.result,
    state.result === null ? null : { winner: state.result.winner, reason: state.result.reason },
  );
  for (const player of playerIds) {
    note(`${player} life`, board.players[player].life, state.players[player].life);
    note(`${player} poison`, board.players[player].poison, state.players[player].poison);
  }

  for (const zone of allZoneIds) {
    const logged = [...board.zones[zone]];
    const engine = [...objectsIn(state, zone)];
    if (kindOfZone(zone) === 'stack') note(`${zone}`, logged, engine);
    else
      note(
        `${zone}`,
        [...logged].sort((a, b) => a - b),
        [...engine].sort((a, b) => a - b),
      );
  }

  for (const id of objectsIn(state, 'battlefield')) {
    const logged: BoardObject | undefined = board.objects.get(id);
    const object = state.objects.get(id);
    if (logged === undefined || object === undefined) continue;
    note(`object ${id} tapped`, logged.tapped, object.tapped);
    note(`object ${id} counters`, sortedCounters(logged.counters), sortedCounters(object.counters));
    if (isCreature(state, id)) note(`object ${id} damage`, logged.damage, object.damage);
  }
  return differences;
};

const sortedCounters = (counters: Readonly<Record<string, number>>) =>
  Object.entries(counters)
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => a.localeCompare(b));

/**
 * The board a log starts from when the game did not: a test board can put permanents on
 * the battlefield before the game is set up, and nothing logs those. A real game's
 * battlefield starts empty, and so does its replay.
 */
export const boardBefore = (state: GameState): Board => {
  const objects = new Map(emptyBoard.objects);
  const ids = objectsIn(state, 'battlefield');
  for (const id of ids) {
    const object = state.objects.get(id);
    if (object === undefined) continue;
    objects.set(id, {
      id,
      zone: 'battlefield',
      tapped: object.tapped,
      counters: { ...object.counters },
      damage: object.damage,
      deathtouched: object.deathtouched,
      attacking: null,
      blocking: [],
      ability: false,
    });
  }
  return { ...emptyBoard, objects, zones: { ...emptyBoard.zones, battlefield: [...ids] } };
};

/**
 * Play a game from `start` with random decisions and, after every one, fold the events
 * it logged into a board and hold that against the engine's state. Throws on the first
 * difference, with the seed and how many decisions in, which replays it exactly.
 */
export const replayCheckedGame = (
  seed: string,
  start: GameState,
  maxDecisions = 5_000,
): FuzzResult => {
  const rng = createRng(`${seed}:play`);
  const emitter = createEventEmitter();
  const decisions: DecisionResponse[] = [];

  let state = setUpGame(start, emitter);
  let board = replayEvents(emitter.drain(), boardBefore(start));
  const check = () => {
    const differences = boardDifferences(board, state);
    if (differences.length > 0) {
      throw new InvariantViolation(seed, decisions.length, differences, state);
    }
  };
  check();

  while (!isGameOver(state) && decisions.length < maxDecisions) {
    const decision = state.pendingDecision;
    if (decision === null) break;
    const response = randomDecision(state, decision, rng);
    decisions.push(response);
    state = applyDecision(state, emitter, response);
    board = replayEvents(emitter.drain(), board);
    check();
  }

  return { seed, state, decisions, turns: state.turn };
};

/** `replayCheckedGame` on a fuzz board. */
export const fuzzReplay = (seed: string, options: FuzzOptions = {}): FuzzResult =>
  replayCheckedGame(seed, fuzzBoard(seed, options), options.maxDecisions);
