import type { AgentSide } from '../ids.js';

/**
 * The two players in a game. Identical to `AgentSide`: in a 1v1 run, agent A always
 * plays player A. The alias exists so engine code can read in Magic's vocabulary
 * without pulling the run-level notion of an "agent" into the rules.
 */
export type PlayerId = AgentSide;

export const playerIds = ['A', 'B'] as const satisfies readonly PlayerId[];

export const opponentOf = (player: PlayerId): PlayerId => (player === 'A' ? 'B' : 'A');
