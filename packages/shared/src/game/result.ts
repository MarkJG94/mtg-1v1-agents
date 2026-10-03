import type { PlayerId } from './player.js';

/** Why a game ended. `turnCap`, `loop` and `decisionCap` are draws by our own rules. */
export const gameEndReasons = [
  'life',
  'decked',
  'poison',
  'effect',
  'concede',
  'turnCap',
  'loop',
  'decisionCap',
] as const;
export type GameEndReason = (typeof gameEndReasons)[number];

export interface GameResult {
  /** `null` is a draw. */
  winner: PlayerId | null;
  reason: GameEndReason;
  turn: number;
}

export const isDraw = (result: GameResult): boolean => result.winner === null;
