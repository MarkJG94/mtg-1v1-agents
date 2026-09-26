import type { MessagePort } from 'node:worker_threads';
import type { BanEvent, Deck75, GameEvent, RunSettings, RunStatus } from '@mtg/shared';
import type { BanRequest, LiveGameEnd, LiveGameStart, RunSnapshot } from '@mtg/sim';

/** What the API process and a simulation worker say to each other (roadmap 5.7). */

export interface SimWorkerData {
  /** Scryfall's projections, one per line (`pnpm fetch:scryfall`). */
  readonly cardsPath: string;
  /** The run store, served by the API process. */
  readonly storePort: MessagePort;
  /** The scripting worker, asked synchronously. */
  readonly scriptPort: MessagePort;
  /** Where a watched game's start, events and end go (docs/07's live stream). */
  readonly livePort: MessagePort;
}

/**
 * What the API process says to a job while it runs, on the job's control port: a ban edit
 * to put into effect after the game in progress, or whether anyone is watching its games.
 * Taken without yielding, between games.
 */
export type ControlMessage = { readonly ban: BanRequest } | { readonly watch: boolean };

/** A watched game, as the worker streams it: its start, its events in batches, its end. */
export type LiveMessage =
  | { readonly runId: string; readonly start: LiveGameStart }
  | { readonly runId: string; readonly events: readonly GameEvent[] }
  | { readonly runId: string; readonly end: LiveGameEnd };

export interface CreateJob {
  readonly job: number;
  readonly kind: 'create';
  readonly id: string;
  readonly name: string;
  readonly settings: RunSettings;
  readonly createdAt: string;
  readonly seedDeck?: Deck75;
  readonly bans?: readonly BanEvent[];
}

export interface DriveJob {
  readonly job: number;
  readonly kind: 'drive';
  readonly runId: string;
  /** Cycles to play at most; the run plays on until paused or stopped if not given. */
  readonly cycles?: number;
  /** `ControlMessage`s for the run: ban edits and whether its games are watched. */
  readonly control: MessagePort;
}

export type SimJob = CreateJob | DriveJob;

export interface DriveOutcome {
  readonly played: number;
  readonly status: RunStatus;
}

export type JobResult =
  | { readonly job: number; readonly created: RunSnapshot }
  | { readonly job: number; readonly drove: DriveOutcome }
  | { readonly job: number; readonly failed: { readonly name: string; readonly message: string } };

export type { BanRequest };
