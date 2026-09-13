import {
  type ObjectId,
  opponentOf,
  type PlayerId,
  playerIds,
  playerZone,
  type Step,
  steps,
} from '@mtg/shared';
import type { EventEmitter } from '../events/emitter.js';
import { emptyManaPool, isManaPoolEmpty } from '../mana/pool.js';
import type { GameState } from '../state/game-state.js';
import { isGameOver } from '../state/game-state.js';
import {
  getObject,
  moveObject,
  objectsIn,
  updateObjects,
  updatePlayer,
  updateState,
} from '../state/update.js';

/**
 * Turn structure (CR 500): walking the steps, and the turn-based actions that happen
 * automatically as each one begins.
 *
 * Priority is not here — a step's turn-based actions run, and then the step ends. Roadmap
 * 1.4 inserts priority rounds between them, which is why `advanceStep` is the seam: it
 * performs one step's automatic actions and stops, rather than running a whole turn.
 */

export interface TurnOptions {
  /**
   * Which cards the active player discards in cleanup when over the hand-size limit
   * (CR 514.1). This is a genuine player choice, so the engine cannot invent it; roadmap
   * 1.4 replaces this hook with a `pendingDecision` the driver answers. Until then a game
   * that reaches cleanup with a full hand and no chooser fails loudly rather than
   * silently discarding the wrong cards.
   */
  readonly chooseDiscards?: (
    state: GameState,
    player: PlayerId,
    count: number,
  ) => readonly ObjectId[];
}

/**
 * The first-strike damage step exists only when a creature with first or double strike
 * is in combat (CR 510.5). Combat arrives in roadmap 1.6; until then there are never any
 * attackers, so the step is always skipped.
 */
const isStepSkipped = (_state: GameState, step: Step): boolean => step === 'firstStrikeDamage';

/** The next step in the turn, or `null` when the turn is over. */
export const nextStep = (state: GameState, from: Step): Step | null => {
  for (let index = steps.indexOf(from) + 1; index < steps.length; index += 1) {
    const step = steps[index];
    if (step && !isStepSkipped(state, step)) return step;
  }
  return null;
};

// --- Turn-based actions ---

/**
 * Untap step (CR 502.1): the active player untaps the permanents they control. Nothing
 * else happens and no player receives priority (CR 502.3).
 *
 * This is also where summoning sickness wears off: a creature can attack once it has been
 * under its controller's control since their turn began (CR 302.6), and their turn has
 * just begun.
 */
const performUntap = (state: GameState, emitter: EventEmitter): GameState => {
  const active = state.activePlayer;
  const patches: Array<readonly [ObjectId, { tapped?: boolean; summoningSick?: boolean }]> = [];

  for (const id of objectsIn(state, 'battlefield')) {
    const object = getObject(state, id);
    if (object.controller !== active) continue;
    if (object.tapped) patches.push([id, { tapped: false, summoningSick: false }]);
    else if (object.summoningSick) patches.push([id, { summoningSick: false }]);
  }

  const untapped = updateObjects(state, patches);
  for (const [id, patch] of patches) {
    if (patch.tapped === false) emitter.emit(untapped, { type: 'untap', object: id });
  }
  return untapped;
};

/**
 * Draw step (CR 504.1). In a two-player game the player who goes first skips the draw
 * step of the first turn (CR 103.7a).
 */
const performDraw = (state: GameState, emitter: EventEmitter): GameState => {
  if (state.turn === 1 && state.activePlayer === state.config.playerOnPlay) return state;
  return drawCard(state, emitter, state.activePlayer);
};

/**
 * Draw one card. A player who tries to draw from an empty library does not lose on the
 * spot: they are flagged and lose the next time state-based actions are checked
 * (CR 120.3, 704.5b), which roadmap 1.7 adds.
 */
export const drawCard = (state: GameState, emitter: EventEmitter, player: PlayerId): GameState => {
  const library = objectsIn(state, playerZone(player, 'library'));
  const top = library[0];
  if (top === undefined) {
    return state.players[player].drewFromEmptyLibrary
      ? state
      : updatePlayer(state, player, { drewFromEmptyLibrary: true });
  }

  const drawn = moveObject(state, top, playerZone(player, 'hand'));
  emitter.emit(drawn, { type: 'draw', player, object: top });
  return drawn;
};

/**
 * Cleanup step (CR 514). The active player discards down to their maximum hand size, and
 * simultaneously all damage is removed from permanents and "until end of turn" effects
 * end. Those effects arrive with the layer system in roadmap 1.9.
 */
const performCleanup = (
  state: GameState,
  emitter: EventEmitter,
  options: TurnOptions,
): GameState => {
  const discarded = discardToHandSize(state, emitter, options);

  const patches = objectsIn(discarded, 'battlefield')
    .map((id) => [id, getObject(discarded, id)] as const)
    .filter(([, object]) => object.damage !== 0)
    .map(([id]) => [id, { damage: 0 }] as const);

  return updateObjects(discarded, patches);
};

const discardToHandSize = (
  state: GameState,
  emitter: EventEmitter,
  options: TurnOptions,
): GameState => {
  const player = state.activePlayer;
  const hand = playerZone(player, 'hand');
  const excess = objectsIn(state, hand).length - state.config.maxHandSize;
  if (excess <= 0) return state;

  const chooser = options.chooseDiscards;
  if (!chooser) {
    throw new Error(
      `player ${player} must discard ${excess} card(s) in cleanup, but no chooseDiscards ` +
        `was supplied; roadmap 1.4 replaces this hook with a pendingDecision`,
    );
  }

  const chosen = chooser(state, player, excess);
  if (chosen.length !== excess) {
    throw new Error(`chooseDiscards returned ${chosen.length} card(s), expected ${excess}`);
  }

  const inHand = new Set(objectsIn(state, hand));
  let next = state;
  for (const id of chosen) {
    if (!inHand.has(id)) {
      throw new Error(`chooseDiscards returned ${id}, which is not in ${player}'s hand`);
    }
    inHand.delete(id);
    next = moveObject(next, id, playerZone(player, 'graveyard'));
    emitter.emit(next, {
      type: 'moveZone',
      object: id,
      from: hand,
      to: playerZone(player, 'graveyard'),
      cause: 'discard',
    });
  }
  return next;
};

const performTurnBasedActions = (
  state: GameState,
  emitter: EventEmitter,
  options: TurnOptions,
): GameState => {
  switch (state.step) {
    case 'untap':
      return performUntap(state, emitter);
    case 'draw':
      return performDraw(state, emitter);
    case 'cleanup':
      return performCleanup(state, emitter, options);
    default:
      return state;
  }
};

// --- Turns ---

/** Who takes the turn after this one: whoever is owed an extra turn, else the opponent. */
const nextTurnPlayer = (
  state: GameState,
): { player: PlayerId; extraTurns: readonly PlayerId[] } => {
  const [owed, ...rest] = state.extraTurns;
  return owed === undefined
    ? { player: opponentOf(state.activePlayer), extraTurns: state.extraTurns }
    : { player: owed, extraTurns: rest };
};

/** Give a player an extra turn after this one (CR 500.7). */
export const grantExtraTurn = (state: GameState, player: PlayerId): GameState =>
  updateState(state, { extraTurns: [...state.extraTurns, player] });

const enterStep = (
  state: GameState,
  emitter: EventEmitter,
  step: Step,
  options: TurnOptions,
): GameState => {
  // Unused mana empties as a step or phase ends (CR 500.4). Clearing it as the next step
  // begins is the same thing, and keeps mana available for the whole step that made it.
  let entered = updateState(state, { step, passesInARow: 0 });
  for (const id of playerIds) {
    if (!isManaPoolEmpty(entered.players[id].manaPool)) {
      entered = updatePlayer(entered, id, { manaPool: emptyManaPool });
    }
  }

  emitter.emit(entered, { type: 'stepStart' });
  return performTurnBasedActions(entered, emitter, options);
};

const beginTurn = (
  state: GameState,
  emitter: EventEmitter,
  player: PlayerId,
  extraTurns: readonly PlayerId[],
  options: TurnOptions,
): GameState => {
  const turn = state.turn + 1;
  if (turn > state.config.turnCap) {
    const ended = updateState(state, {
      result: { winner: null, reason: 'turnCap', turn: state.turn },
    });
    emitter.emit(ended, { type: 'gameEnd', winner: null, reason: 'turnCap' });
    return ended;
  }

  // "This turn" bookkeeping resets for both players, not only the active one: effects
  // can let a player play lands on someone else's turn.
  let started = updateState(state, { turn, activePlayer: player, extraTurns, passesInARow: 0 });
  for (const id of playerIds) started = updatePlayer(started, id, { landsPlayedThisTurn: 0 });

  emitter.emit(started, { type: 'turnStart', activePlayer: player });
  return enterStep(started, emitter, 'untap', options);
};

/**
 * Begin turn 1 for the player on the play, running the untap step's turn-based actions.
 * Mulligans and opening hands are roadmap 1.12; this assumes the game is already set up.
 */
export const startFirstTurn = (
  state: GameState,
  emitter: EventEmitter,
  options: TurnOptions = {},
): GameState => {
  if (state.turn !== 0) throw new Error(`the game has already started (turn ${state.turn})`);
  return beginTurn(state, emitter, state.config.playerOnPlay, state.extraTurns, options);
};

/**
 * Advance to the next step, running its turn-based actions, rolling over into the next
 * turn after cleanup. A finished game is returned unchanged.
 */
export const advanceStep = (
  state: GameState,
  emitter: EventEmitter,
  options: TurnOptions = {},
): GameState => {
  if (isGameOver(state)) return state;
  if (state.turn === 0) throw new Error('the game has not started; call startFirstTurn first');

  const following = nextStep(state, state.step);
  if (following) return enterStep(state, emitter, following, options);

  const { player, extraTurns } = nextTurnPlayer(state);
  return beginTurn(state, emitter, player, extraTurns, options);
};

/** Advance until the game ends or `limit` steps have passed. Mostly for tests. */
export const advanceUntilGameOver = (
  state: GameState,
  emitter: EventEmitter,
  options: TurnOptions = {},
  limit = 100_000,
): GameState => {
  let current = state;
  for (let i = 0; i < limit && !isGameOver(current); i += 1) {
    current = advanceStep(current, emitter, options);
  }
  return current;
};
