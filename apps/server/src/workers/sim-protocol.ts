import type { MessagePort } from 'node:worker_threads';
import type { BanEvent, Deck75, RunSettings, RunStatus } from '@mtg/shared';
import type { BanRequest, RunSnapshot } from '@mtg/sim';

/** What the API process and a simulation worker say to each other (roadmap 5.7). */

export interface SimWorkerData {
  /** Scryfall's projections, one per line (`pnpm fetch:scryfall`). */
  readonly cardsPath: string;
  /** The run store, served by the API process. */
  readonly storePort: MessagePort;
  /** The scripting worker, asked synchronously. */
  readonly scriptPort: MessagePort;
}

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
  /** Ban edits for the run, taken after every game (`BanRequest`s). */
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
