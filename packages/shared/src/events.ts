import type { ObjectId, PlayerId, Step, ZoneName } from './ids.js';

export const EVENT_LOG_VERSION = 1;

interface Base {
  seq: number;
  turn: number;
  step: Step;
}

export type GameEndReason =
  | 'life'
  | 'poison'
  | 'drawFromEmptyLibrary'
  | 'effect'
  | 'concede'
  | 'turnCap'
  | 'decisionCap'
  | 'loop';

export type GameEventPayload =
  | { type: 'gameStart'; onPlay: PlayerId }
  | { type: 'objectCreated'; object: ObjectId; definition: string; owner: PlayerId; token: boolean }
  | { type: 'mulligan'; player: PlayerId; handSize: number }
  | { type: 'keep'; player: PlayerId; handSize: number; bottomed: number }
  | { type: 'turnStart'; player: PlayerId; extra: boolean }
  | { type: 'stepStart' }
  | { type: 'draw'; player: PlayerId; object: ObjectId }
  | { type: 'playLand'; player: PlayerId; object: ObjectId }
  | {
      type: 'cast';
      player: PlayerId;
      object: ObjectId;
      stackId: number;
      targets: TargetRefLog[];
      x?: number;
    }
  | {
      type: 'activate';
      player: PlayerId;
      source: ObjectId;
      ability: number;
      stackId: number;
      targets: TargetRefLog[];
      mana: boolean;
    }
  | {
      type: 'trigger';
      player: PlayerId;
      source: ObjectId;
      ability: number;
      stackId: number;
      targets: TargetRefLog[];
    }
  | { type: 'resolve'; stackId: number }
  | { type: 'counter'; stackId: number; by?: ObjectId }
  | { type: 'fizzle'; stackId: number }
  | { type: 'moveZone'; object: ObjectId; from: ZoneName; to: ZoneName; owner: PlayerId }
  | { type: 'tap'; object: ObjectId }
  | { type: 'untap'; object: ObjectId }
  | {
      type: 'damage';
      source: ObjectId;
      target: ObjectId | PlayerId;
      amount: number;
      combat: boolean;
    }
  | { type: 'lifeChange'; player: PlayerId; delta: number; life: number }
  | { type: 'poison'; player: PlayerId; delta: number; poison: number }
  | { type: 'counterChange'; object: ObjectId; counter: string; delta: number; total: number }
  | { type: 'attack'; attacker: ObjectId; defender: ObjectId | PlayerId }
  | { type: 'block'; blocker: ObjectId; attacker: ObjectId }
  | { type: 'controlChange'; object: ObjectId; controller: PlayerId }
  | { type: 'attach'; object: ObjectId; to: ObjectId }
  | { type: 'unattach'; object: ObjectId }
  | { type: 'sba'; kind: string; object?: ObjectId; player?: PlayerId }
  | { type: 'effectStart'; effect: number; source: ObjectId }
  | { type: 'effectEnd'; effect: number }
  | { type: 'manaAdded'; player: PlayerId; mana: string }
  | { type: 'manaEmptied'; player: PlayerId }
  | { type: 'shuffle'; player: PlayerId }
  | { type: 'discard'; player: PlayerId; object: ObjectId }
  | { type: 'reveal'; player: PlayerId; objects: ObjectId[] }
  | { type: 'decision'; player: PlayerId; kind: string; summary: string; score?: number }
  | { type: 'gameEnd'; winner: PlayerId | null; reason: GameEndReason };

export type TargetRefLog = ObjectId | PlayerId;

export type GameEvent = Base & GameEventPayload;

export interface GameEventLog {
  version: number;
  gameId: string;
  seed: string;
  players: Record<PlayerId, { deckGen?: string; main: string[]; side: string[] }>;
  events: GameEvent[];
}
