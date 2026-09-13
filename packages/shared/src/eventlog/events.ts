import type { DecisionKind } from '../game/decisions.js';
import type { PlayerId } from '../game/player.js';
import type { GameEndReason } from '../game/result.js';
import type { Step } from '../game/steps.js';
import type { ZoneId } from '../game/zones.js';
import type { ObjectId, OracleId } from '../ids.js';

/**
 * The game event log (docs/02 "Event log", docs/06 "Event log format").
 *
 * Every state change emits one of these. The log is the replay source for the UI and
 * the statistics source for the evolution loop, so events are compact, typed, and
 * reference objects by id rather than embedding card data. Hidden information (library
 * order, the opponent's hand) *is* recorded; the UI decides what to reveal.
 */

/** Stamped onto every event by the emitter. */
export interface EventEnvelope {
  /** Monotonic within a game, starting at 0. */
  seq: number;
  turn: number;
  step: Step;
}

/** Damage and targeting can address a player or an object (a creature or planeswalker). */
export type EventTarget =
  | { readonly kind: 'player'; readonly player: PlayerId }
  | { readonly kind: 'object'; readonly object: ObjectId };

/** Why an object changed zones; drives statistics such as "died" vs "discarded". */
export const moveCauses = [
  'draw',
  'play',
  'cast',
  'resolve',
  'destroy',
  'sacrifice',
  'discard',
  'mill',
  'exile',
  'return',
  'tutor',
  'shuffle',
  'tokenCreated',
  'tokenCeased',
  'stateBasedAction',
  'effect',
] as const;
export type MoveCause = (typeof moveCauses)[number];

/** State-based actions (CR 704) worth recording individually. */
export const sbaKinds = [
  'playerLosesLife',
  'playerDrewFromEmptyLibrary',
  'playerPoisoned',
  'creatureZeroToughness',
  'creatureLethalDamage',
  'creatureDeathtouched',
  'planeswalkerZeroLoyalty',
  'legendRule',
  'auraIllegallyAttached',
  'equipmentIllegallyAttached',
  'tokenNotOnBattlefield',
  'counterAnnihilation',
] as const;
export type SbaKind = (typeof sbaKinds)[number];

/** Counter kinds we name explicitly; anything else is a free-form keyword counter. */
export type CounterKind = '+1/+1' | '-1/-1' | 'loyalty' | 'charge' | 'poison' | (string & {});

interface StartingDeck {
  readonly library: readonly ObjectId[];
  readonly hand: readonly ObjectId[];
}

export type GameEventBody =
  // --- Framework ---
  | {
      readonly type: 'gameStart';
      readonly onPlay: PlayerId;
      readonly startingLife: number;
      readonly decks: Readonly<Record<PlayerId, StartingDeck>>;
    }
  | { readonly type: 'mulligan'; readonly player: PlayerId; readonly toHandSize: number }
  | {
      readonly type: 'keep';
      readonly player: PlayerId;
      readonly handSize: number;
      /** London mulligan: cards put on the bottom (CR 103.4). */
      readonly bottomed: readonly ObjectId[];
    }
  | { readonly type: 'turnStart'; readonly activePlayer: PlayerId }
  | { readonly type: 'stepStart' }
  | { readonly type: 'gameEnd'; readonly winner: PlayerId | null; readonly reason: GameEndReason }

  // --- Playing cards ---
  | { readonly type: 'draw'; readonly player: PlayerId; readonly object: ObjectId }
  | { readonly type: 'playLand'; readonly player: PlayerId; readonly object: ObjectId }
  | {
      readonly type: 'cast';
      readonly player: PlayerId;
      readonly object: ObjectId;
      readonly targets: readonly EventTarget[];
      readonly x?: number;
    }
  | {
      readonly type: 'activate';
      readonly player: PlayerId;
      readonly source: ObjectId;
      readonly abilityIndex: number;
      readonly targets: readonly EventTarget[];
    }
  | {
      readonly type: 'trigger';
      readonly controller: PlayerId;
      readonly source: ObjectId;
      readonly abilityIndex: number;
    }

  // --- The stack ---
  | { readonly type: 'putOnStack'; readonly object: ObjectId }
  | { readonly type: 'resolve'; readonly object: ObjectId }
  | { readonly type: 'counter'; readonly object: ObjectId; readonly by: ObjectId }
  | { readonly type: 'fizzle'; readonly object: ObjectId; readonly reason: string }

  // --- Objects ---
  | {
      readonly type: 'moveZone';
      readonly object: ObjectId;
      readonly from: ZoneId;
      readonly to: ZoneId;
      readonly cause: MoveCause;
      /** New object id when the move creates a new object (CR 400.7). */
      readonly becomes?: ObjectId;
    }
  | { readonly type: 'tap'; readonly object: ObjectId }
  | { readonly type: 'untap'; readonly object: ObjectId }
  | {
      readonly type: 'counterChange';
      readonly object: ObjectId;
      readonly counter: CounterKind;
      readonly from: number;
      readonly to: number;
    }

  // --- Damage and life ---
  | {
      readonly type: 'damage';
      readonly source: ObjectId;
      readonly target: EventTarget;
      readonly amount: number;
      readonly combat: boolean;
      readonly deathtouch?: boolean;
    }
  | {
      readonly type: 'lifeChange';
      readonly player: PlayerId;
      readonly from: number;
      readonly to: number;
      readonly reason: string;
    }

  // --- Combat ---
  | { readonly type: 'attack'; readonly attacker: ObjectId; readonly defender: EventTarget }
  | {
      readonly type: 'block';
      readonly blocker: ObjectId;
      readonly blocking: readonly ObjectId[];
    }
  /** Batch marker: all damage in this step is dealt simultaneously (CR 510.2). */
  | { readonly type: 'combatDamage'; readonly firstStrike: boolean }

  // --- Rules machinery ---
  | { readonly type: 'sba'; readonly kind: SbaKind; readonly objects: readonly ObjectId[] }
  | { readonly type: 'effectStart'; readonly effect: number; readonly source: ObjectId }
  | { readonly type: 'effectEnd'; readonly effect: number }
  | {
      readonly type: 'decision';
      readonly player: PlayerId;
      readonly kind: DecisionKind;
      /** Compact description of what was chosen; shape depends on `kind`. */
      readonly chosen: unknown;
      /** The agent's evaluation of the chosen line, when it reported one. */
      readonly score?: number;
    };

export type GameEventType = GameEventBody['type'];

export type GameEvent = EventEnvelope & GameEventBody;

/** Narrow a `GameEvent` to one type without a cast. */
export const isEvent = <T extends GameEventType>(
  event: GameEvent,
  type: T,
): event is GameEvent & { type: T } => event.type === type;

/**
 * Header row mapping an object id to what it actually is, so the UI can render a
 * replay without the engine or the card database in the loop (docs/06).
 */
export interface EventLogObject {
  readonly id: ObjectId;
  readonly oracleId: OracleId;
  readonly owner: PlayerId;
  /** Tokens have no card in a deck; they are created during the game. */
  readonly token?: boolean;
}
