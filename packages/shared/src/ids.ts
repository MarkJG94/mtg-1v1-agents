/**
 * Branded identifier types.
 *
 * These are structurally strings/numbers at runtime; the brand exists only so the
 * compiler stops a `GameId` being passed where a `RunId` is wanted. Construct them
 * through the `asX` helpers so the cast happens in exactly one place.
 */

declare const brand: unique symbol;

type Brand<T, B extends string> = T & { readonly [brand]: B };

/** A single evolutionary experiment. */
export type RunId = Brand<string, 'RunId'>;
/** One batch of matches plus the deck change that follows it. */
export type CycleId = Brand<string, 'CycleId'>;
/** A best-of-three between the two agents' current decks. */
export type MatchId = Brand<string, 'MatchId'>;
/** One game of Magic, recorded as an event log. */
export type GameId = Brand<string, 'GameId'>;
/** Scryfall `oracle_id`: stable across printings, so it is our card identity. */
export type OracleId = Brand<string, 'OracleId'>;
/** An object inside a single game's state. Only meaningful within that game. */
export type ObjectId = Brand<number, 'ObjectId'>;

export const asRunId = (value: string): RunId => value as RunId;
export const asCycleId = (value: string): CycleId => value as CycleId;
export const asMatchId = (value: string): MatchId => value as MatchId;
export const asGameId = (value: string): GameId => value as GameId;
export const asOracleId = (value: string): OracleId => value as OracleId;
export const asObjectId = (value: number): ObjectId => value as ObjectId;

/** The two sides of a 1v1 game. Agent A is always the run's first agent. */
export type AgentSide = 'A' | 'B';

export const otherSide = (side: AgentSide): AgentSide => (side === 'A' ? 'B' : 'A');
