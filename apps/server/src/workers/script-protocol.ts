import type { MessagePort } from 'node:worker_threads';
import type {
  CachedScript,
  CardProjection,
  RequestContext,
  Resolution,
  UnsupportedRequest,
} from '@mtg/cards';

/**
 * What passes between the scripting worker and those it serves (roadmap 5.7).
 *
 * A request carries the card and, from a simulation worker, a one-slot shared buffer the
 * scripting worker sets and notifies once it has posted the answer: the simulation worker
 * waits on it and takes the answer off its port synchronously, so the resolver it is
 * handed keeps the synchronous interface the seed deck, the pool and legalisation call
 * (ADR 0016). The API process asks without a buffer and awaits the reply.
 */

export interface ScriptRequest {
  readonly id: number;
  readonly card: CardProjection;
  readonly request: RequestContext;
  readonly signal?: Int32Array;
  /** Script it afresh, as if nothing were cached (`POST /api/cards/:id/script`). */
  readonly force?: boolean;
}

export type ScriptAnswer =
  | { readonly id: number; readonly resolution: Resolution }
  | { readonly id: number; readonly error: string };

/** The scripting worker to the API process: the writes it cannot make itself. */
export type ScriptWrite =
  | { readonly put: CachedScript }
  | { readonly unsupported: UnsupportedRequest };

/** The API process to the scripting worker: a port to answer on. */
export interface ScriptConnect {
  readonly connect: MessagePort;
}
