import {
  allZoneIds,
  type GameResult,
  type ObjectId,
  type PlayerId,
  playerIds,
  type Step,
  type ZoneId,
} from '@mtg/shared';
import type { CombatState } from '../combat.js';
import type { Decision } from '../decision.js';
import type { ContinuousEffect } from '../layers.js';
import { emptyManaPool, type ManaPool } from '../mana/pool.js';
import type { RngState } from '../rng.js';
import { type Keywords, noKeywords } from '../targeting.js';
import type { DelayedTrigger, TriggerInstance } from '../triggers.js';
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
  /** Players can have hexproof or protection too, e.g. Leyline of Sanctity. */
  readonly keywords: Keywords;
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
  readonly config: GameConfig;
  /**
   * Set when the game is waiting for a player to choose; `null` while it can run on its
   * own. A driver answers it with `applyDecision`.
   */
  readonly pendingDecision: Decision | null;
  /** Non-null only during the combat phase (CR 506). */
  readonly combat: CombatState | null;
  /** Triggers that have fired and go on the stack next time a player would get priority. */
  readonly pendingTriggers: readonly TriggerInstance[];
  /** Triggers set up to fire at a later step (CR 603.7). */
  readonly delayedTriggers: readonly DelayedTrigger[];
  /** `source:abilityId` for each once-each-turn ability that has already fired. */
  readonly triggersFiredThisTurn: readonly string[];
  /** Continuous effects currently in force (CR 613). */
  readonly effects: readonly ContinuousEffect[];
  /** Next id and timestamp for a new continuous effect. */
  readonly nextEffectId: number;
  /**
   * Players owed an extra turn (CR 500.7), oldest first. The next turn goes to the
   * front of this queue if it has one, otherwise to the other player.
   */
  readonly extraTurns: readonly PlayerId[];
  /** Non-null once the game is over. */
  readonly result: GameResult | null;
}

export const DEFAULT_STARTING_LIFE = 20;
export const DEFAULT_TURN_CAP = 40;
export const DEFAULT_MAX_HAND_SIZE = 7;

/**
 * Fixed for the whole game. `turnCap` comes from run settings (docs/05) and makes an
 * unfinished game a draw so a run cannot stall on a board neither agent can break.
 */
export interface GameConfig {
  /** Turns 1..turnCap are played; starting one past it is a draw. */
  readonly turnCap: number;
  /** Maximum hand size, enforced in cleanup (CR 514.1). */
  readonly maxHandSize: number;
  /** Who took the first turn. Needed for the CR 103.7a first-draw skip. */
  readonly playerOnPlay: PlayerId;
}

const emptyPlayerState = (life: number): PlayerState => ({
  life,
  poison: 0,
  manaPool: emptyManaPool,
  landsPlayedThisTurn: 0,
  maxLandsPerTurn: 1,
  drewFromEmptyLibrary: false,
  keywords: noKeywords,
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
  readonly turnCap?: number;
  readonly maxHandSize?: number;
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
    config: {
      turnCap: options.turnCap ?? DEFAULT_TURN_CAP,
      maxHandSize: options.maxHandSize ?? DEFAULT_MAX_HAND_SIZE,
      playerOnPlay: options.onPlay,
    },
    extraTurns: [],
    pendingDecision: null,
    combat: null,
    pendingTriggers: [],
    delayedTriggers: [],
    triggersFiredThisTurn: [],
    effects: [],
    nextEffectId: 1,
    result: null,
  };
};

export const isGameOver = (state: GameState): boolean => state.result !== null;
