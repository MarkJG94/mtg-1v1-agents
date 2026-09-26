import { type MessagePort, receiveMessageOnPort } from 'node:worker_threads';
import type { CardProjection, RequestContext, Resolution, ScriptResolver } from '@mtg/cards';
import type { ScriptAnswer, ScriptRequest } from './script-protocol.js';

/**
 * The resolver as a simulation worker sees it: `resolve` asks the scripting worker and
 * blocks this thread until it answers (ADR 0016). Blocking is what the in-process resolver
 * did too — a game cannot be played before its cards are scripted — and it keeps the
 * interface synchronous for the seed deck, the pool and legalisation.
 *
 * The port must have no `message` listener: the answer is taken off it with
 * `receiveMessageOnPort`, and a listener would take it first.
 */
export class ScriptClient implements Pick<ScriptResolver, 'resolve'> {
  private readonly signal = new Int32Array(new SharedArrayBuffer(4));
  private next = 0;

  constructor(
    private readonly port: MessagePort,
    /** How long to wait for an answer before deciding the scripting worker is gone. */
    private readonly timeoutMs = 120_000,
  ) {}

  resolve(card: CardProjection, request: RequestContext = {}): Resolution {
    const id = this.next++;
    Atomics.store(this.signal, 0, 0);
    this.port.postMessage({ id, card, request, signal: this.signal } satisfies ScriptRequest);
    if (Atomics.wait(this.signal, 0, 0, this.timeoutMs) === 'timed-out') {
      throw new Error(`the scripting worker did not answer for ${card.name} in time`);
    }
    const received = receiveMessageOnPort(this.port);
    const answer = received?.message as ScriptAnswer | undefined;
    if (answer === undefined || answer.id !== id) {
      throw new Error(`the scripting worker's answer for ${card.name} went missing`);
    }
    if ('error' in answer) throw new Error(`scripting ${card.name} failed: ${answer.error}`);
    return answer.resolution;
  }
}
