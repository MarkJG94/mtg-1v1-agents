import {
  allZoneIds,
  type GameResult,
  type ObjectId,
  type PlayerId,
  playerIds,
  type Step,
  type ZoneId,
} from '@mtg/shared';
import type { RngState } from '../rng.js';
import { emptyManaPool, type ManaPool } from './mana.js';
import type { GameObject } from './object.js';

/**
 * Per-player state. Anything that belongs to a player rather than to an object.
 */
export interface PlayerState {
  readonly life: number;
  /** Ten or more is a loss (CR 704.5c). */
  readonly poison: number;
  readonly manaPool: ManaPool;
  readonly landsPlayedThisTurn: number;
  /** Normally 1; effects such as Exploration raise it (CR 305.2). */
  readonly maxLandsPerTurn: number;
  /**
   * Set when a draw from an empty library is attempted. The player does not lose
   * immediately; they lose the next time state-based actions are checked (CR 704.5b).
   */
  readonly drewFromEmptyLibrary: boolean;
}

/**
 * The whole game (docs/02 "State model").
 *
 * Immutable by convention: never mutate a `GameState`, always go through the helpers in
 * `./update.js`, which return a new state with `version` bumped. The version is what
 * `characteristics()` memoisation keys on, so a mutation that skipped the helpers would
 * silently serve stale characteristics.
 *
 * Two representational choices differ from the original sketch in docs/02, both
 * recorded in ADR 0002: the battlefield, stack, exile and command zone are shared
 * rather than per player, and the stack is simply the contents of the `stack` zone
 * rather than a second parallel array.
 *
 * Fields that later phases add: `pendingDecision` (1.4), `combat` (1.6),
 * `pendingTriggers` and `delayedTriggers` (1.8), `effects` (1.9).
 */
export interface GameState {
  /** Bumped by every update; the memoisation key for derived characteristics. */
  readonly version: number;
  readonly rng: RngState;
  readonly turn: number;
  readonly activePlayer: PlayerId;
  readonly step: Step;
  /** `null` in steps where no player receives priority (untap, cleanup). */
  readonly priority: PlayerId | null;
  /** Successive priority passes; two in a row resolves or advances (CR 117.4). */
  readonly passesInARow: number;
  readonly players: Readonly<Record<PlayerId, PlayerState>>;
  readonly objects: ReadonlyMap<ObjectId, GameObject>;
  /** Zone contents in order. For the library, index 0 is the top; for the stack, the bottom. */
  readonly zones: Readonly<Record<ZoneId, readonly ObjectId[]>>;
  /** Next id to hand out; object ids are never reused within a game. */
  readonly nextObjectId: number;
  /** Next layer-system timestamp (CR 613.7). */
  readonly nextTimestamp: number;
  /** Non-null once the game is over. */
  readonly result: GameResult | null;
}

export const DEFAULT_STARTING_LIFE = 20;

const emptyPlayerState = (life: number): PlayerState => ({
  life,
  poison: 0,
  manaPool: emptyManaPool,
  landsPlayedThisTurn: 0,
  maxLandsPerTurn: 1,
  drewFromEmptyLibrary: false,
});

const emptyZones = (): Record<ZoneId, readonly ObjectId[]> => {
  const zones = {} as Record<ZoneId, readonly ObjectId[]>;
  for (const zone of allZoneIds) zones[zone] = [];
  return zones;
};

export interface CreateGameStateOptions {
  readonly rng: RngState;
  /** The player who takes the first turn. */
  readonly onPlay: PlayerId;
  readonly startingLife?: number;
}

/**
 * An empty game: no objects, no cards, turn 0. Libraries are filled and the opening
 * hands drawn by the game setup in roadmap 1.12; this is the container they act on.
 */
export const createGameState = (options: CreateGameStateOptions): GameState => {
  const life = options.startingLife ?? DEFAULT_STARTING_LIFE;
  const players = {} as Record<PlayerId, PlayerState>;
  for (const player of playerIds) players[player] = emptyPlayerState(life);

  return {
    version: 0,
    rng: options.rng,
    turn: 0,
    activePlayer: options.onPlay,
    step: 'untap',
    priority: null,
    passesInARow: 0,
    players,
    objects: new Map(),
    zones: emptyZones(),
    nextObjectId: 1,
    nextTimestamp: 1,
    result: null,
  };
};

export const isGameOver = (state: GameState): boolean => state.result !== null;
