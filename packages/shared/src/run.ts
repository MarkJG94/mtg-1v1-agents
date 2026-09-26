import type { Deck75, DeckChange } from './deck-change.js';
import type { DeckSlot } from './eventlog/log.js';
import type { PlayerId } from './game/player.js';
import type { RunSettings } from './settings.js';
import type { AgentCounts, Tally } from './stats.js';

/**
 * What a run is made of, as docs/06 stores it and the UI reads it (roadmap 5.6): the run
 * itself, each deck's lineage, and a record per finished cycle. Plain data throughout, so
 * that it goes into SQLite, over the API and into an export bundle unchanged.
 */

/** docs/05 "Run lifecycle": created → running → paused → running … → stopped. */
export const runStatuses = ['created', 'running', 'paused', 'stopped'] as const;
export type RunStatus = (typeof runStatuses)[number];

export interface RunInfo {
  readonly id: string;
  readonly name: string;
  readonly seed: string;
  readonly settings: RunSettings;
  readonly status: RunStatus;
  readonly createdAt: string;
  /** For a fork (docs/05): the run and the cycle it was taken from. */
  readonly forkedFrom: { readonly run: string; readonly cycle: number } | null;
}

/** Why a deck generation exists (docs/06 `deck_generations.cause`). */
export const deckCauses = ['seed', 'change', 'ban', 'manual'] as const;
export type DeckCause = (typeof deckCauses)[number];

/** One deck as it stood from some point in the run (docs/06 `deck_generations`). */
export interface DeckGeneration {
  readonly agent: PlayerId;
  /** Counts up from 0, the seed deck, per agent. */
  readonly generation: number;
  /** The cycle it was made in: 0 before the first, and a legalisation's own cycle. */
  readonly cycle: number;
  readonly cause: DeckCause;
  readonly deck: Deck75;
  /** The change that made it; `null` for a seed deck. */
  readonly change: DeckChange | null;
}

/** A deck's record on the play and on the draw (docs/04 item 6). */
export interface PlayDrawTally {
  readonly play: Tally;
  readonly draw: Tally;
}

/** A finished cycle (docs/06 `cycles`, with its statistics). */
export interface CycleRecord {
  /** From 1. */
  readonly number: number;
  /** The deck generations the cycle began with. */
  readonly generations: Readonly<Record<PlayerId, number>>;
  readonly matches: number;
  readonly tiebreakMatches: number;
  readonly winRate: Readonly<Record<PlayerId, number>>;
  readonly loser: PlayerId;
  readonly decidedBy: 'winRate' | 'tiebreak' | 'coinFlip';
  /** Each deck's play/draw record as the cycle left it. */
  readonly playDraw: Readonly<Record<PlayerId, PlayDrawTally>>;
  /** Each deck's statistics from this cycle's games (docs/05 "Statistics"). */
  readonly stats: Readonly<Record<PlayerId, AgentCounts>>;
  /** What each deck showed the other. */
  readonly shown: Readonly<Record<PlayerId, readonly DeckSlot[]>>;
  /** The statistics each trial of the deck change recorded, by candidate (docs/05 step 3). */
  readonly trials: Readonly<Record<string, AgentCounts>>;
}
