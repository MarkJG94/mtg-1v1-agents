import {
  allZoneIds,
  type GameResult,
  type ObjectId,
  type OracleId,
  type PlayerId,
  playerIds,
  type Step,
  type ZoneId,
} from '@mtg/shared';
import type { CardDefinition } from '../cards/definition.js';
import type { CombatState } from '../combat.js';
import type { Decision } from '../decision.js';
import type { ContinuousEffect } from '../layers.js';
import { emptyManaPool, type ManaPool } from '../mana/pool.js';
import type { ReplacementEffect, ReplacementProgress } from '../replacement.js';
import type { RngState } from '../rng.js';
import type { MulliganState } from '../setup.js';
import { type Keywords, noKeywords } from '../targeting.js';
import type { DelayedTrigger, TriggerInstance } from '../triggers.js';
import { ObjectStore } from './object-store.js';

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
 * `pendingTriggers` and `delayedTriggers` (1.8), `effects` (1.9),
 * `replacements` and `pendingReplacement` (1.10), `loyaltyActivatedThisTurn` (1.11).
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
  readonly objects: ObjectStore;
  /** Zone contents in order. For the library, index 0 is the top; for the stack, the bottom. */
  readonly zones: Readonly<Record<ZoneId, readonly ObjectId[]>>;
  /** Next id to hand out; object ids are never reused within a game. */
  readonly nextObjectId: number;
  /** Next layer-system timestamp (CR 613.7). */
  readonly nextTimestamp: number;
  readonly config: GameConfig;
  /**
   * The cards in this game, by oracle id (ADR 0006). Immutable and shared: every object
   * points at its definition rather than carrying a copy, and an update never touches
   * this map, so structural sharing keeps it free.
   */
  readonly definitions: ReadonlyMap<OracleId, CardDefinition>;
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
  /**
   * Planeswalkers that have already had a loyalty ability activated this turn. At most
   * one per permanent per turn, whoever controlled it at the time (CR 606.3).
   */
  readonly loyaltyActivatedThisTurn: readonly ObjectId[];
  /** Continuous effects currently in force (CR 613). */
  readonly effects: readonly ContinuousEffect[];
  /** Replacement and prevention effects currently in force (CR 614-616). */
  readonly replacements: readonly ReplacementEffect[];
  /** Next id for a continuous or replacement effect; shared so log ids never clash. */
  readonly nextEffectId: number;
  /**
   * A batch of events stopped part-way because a player must choose which of several
   * applicable replacement effects applies first (CR 616.1). Plain data, so a replay
   * reproduces the pause exactly.
   */
  readonly pendingReplacement: ReplacementProgress | null;
  /**
   * Players owed an extra turn (CR 500.7), oldest first. The next turn goes to the
   * front of this queue if it has one, otherwise to the other player.
   */
  readonly extraTurns: readonly PlayerId[];
  /**
   * Where the game is in the London mulligan (CR 103.4); `null` once the opening hands
   * are settled, which is every moment after the game has actually begun.
   */
  readonly mulligans: MulliganState | null;
  /**
   * Hashes of the states reached this turn. A repeat is a loop and so a draw (CR 726).
   * Cleared as each turn begins, because a position recurring across turns is ordinary.
   */
  readonly statesThisTurn: readonly number[];
  /** Decisions answered so far, against `config.decisionCap`. */
  readonly decisionsMade: number;
  /** Decisions answered in the current turn, against `config.loopCheckAfter`. */
  readonly decisionsThisTurn: number;
  /** Non-null once the game is over. */
  readonly result: GameResult | null;
}

export const DEFAULT_STARTING_LIFE = 20;
export const DEFAULT_TURN_CAP = 40;
export const DEFAULT_MAX_HAND_SIZE = 7;
export const DEFAULT_OPENING_HAND_SIZE = 7;
/** Seven mulligans leaves a hand of nothing, so there is no eighth worth taking. */
export const DEFAULT_MAX_MULLIGANS = 7;
/**
 * The backstop docs/02 asks for. Generous: a 40-turn game of real Magic answers a few
 * hundred decisions, so reaching this means something is looping that loop detection
 * could not see.
 */
export const DEFAULT_DECISION_CAP = 20_000;
/**
 * Decisions into a turn before loop detection starts hashing (CR 726). Ordinary turns
 * are far shorter than this — the 1.14 benchmarks put the 99th percentile at 22 — and a
 * loop by definition never ends, so a detector that starts late still catches it. See
 * ADR 0005: hashing every position of every turn was nine tenths of a game's time.
 */
export const DEFAULT_LOOP_CHECK_AFTER = 200;

/**
 * Fixed for the whole game. `turnCap` comes from run settings (docs/05) and makes an
 * unfinished game a draw so a run cannot stall on a board neither agent can break.
 */
export interface GameConfig {
  /** Turns 1..turnCap are played; starting one past it is a draw. */
  readonly turnCap: number;
  /** Maximum hand size, enforced in cleanup (CR 514.1). */
  readonly maxHandSize: number;
  /** Cards dealt to each player at the start (CR 103.2). */
  readonly openingHandSize: number;
  /** How many times a player may mulligan before they must keep (CR 103.4). */
  readonly maxMulligans: number;
  /** Decisions after which an unfinished game is a draw; the loop-detection backstop. */
  readonly decisionCap: number;
  /** Whether a state repeating within a turn ends the game as a draw (CR 726). */
  readonly detectLoops: boolean;
  /**
   * How many decisions a turn must run before positions are hashed and compared. A turn
   * shorter than this cannot be an endless loop, and a loop never stops being one.
   */
  readonly loopCheckAfter: number;
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
  /** The cards this game is played with. Anything not in here has no script (docs/03). */
  readonly definitions?: Iterable<CardDefinition>;
  /** The player who takes the first turn. */
  readonly onPlay: PlayerId;
  readonly startingLife?: number;
  readonly turnCap?: number;
  readonly maxHandSize?: number;
  readonly openingHandSize?: number;
  readonly maxMulligans?: number;
  readonly decisionCap?: number;
  readonly detectLoops?: boolean;
  readonly loopCheckAfter?: number;
}

/**
 * An empty game: no objects, no cards, turn 0. Libraries are filled and the opening
 * hands drawn by the game setup in roadmap 1.12; this is the container they act on.
 */
export const createGameState = (options: CreateGameStateOptions): GameState => {
  const life = options.startingLife ?? DEFAULT_STARTING_LIFE;
  const players = {} as Record<PlayerId, PlayerState>;
  for (const player of playerIds) players[player] = emptyPlayerState(life);

  const definitions = new Map<OracleId, CardDefinition>();
  for (const definition of options.definitions ?? [])
    definitions.set(definition.oracleId, definition);

  return {
    version: 0,
    rng: options.rng,
    turn: 0,
    activePlayer: options.onPlay,
    step: 'untap',
    priority: null,
    passesInARow: 0,
    players,
    objects: ObjectStore.empty,
    zones: emptyZones(),
    nextObjectId: 1,
    nextTimestamp: 1,
    definitions,
    config: {
      turnCap: options.turnCap ?? DEFAULT_TURN_CAP,
      maxHandSize: options.maxHandSize ?? DEFAULT_MAX_HAND_SIZE,
      openingHandSize: options.openingHandSize ?? DEFAULT_OPENING_HAND_SIZE,
      maxMulligans: options.maxMulligans ?? DEFAULT_MAX_MULLIGANS,
      decisionCap: options.decisionCap ?? DEFAULT_DECISION_CAP,
      detectLoops: options.detectLoops ?? true,
      loopCheckAfter: options.loopCheckAfter ?? DEFAULT_LOOP_CHECK_AFTER,
      playerOnPlay: options.onPlay,
    },
    extraTurns: [],
    pendingDecision: null,
    combat: null,
    pendingTriggers: [],
    delayedTriggers: [],
    triggersFiredThisTurn: [],
    loyaltyActivatedThisTurn: [],
    effects: [],
    replacements: [],
    nextEffectId: 1,
    pendingReplacement: null,
    mulligans: null,
    statesThisTurn: [],
    decisionsMade: 0,
    decisionsThisTurn: 0,
    result: null,
  };
};

export const isGameOver = (state: GameState): boolean => state.result !== null;
