import type { MessagePort } from 'node:worker_threads';

/**
 * Method calls over a message port (roadmap 5.7). A worker holds a proxy whose methods post
 * `{ call, method, args }` and resolve with the reply; the other side runs the method on
 * the object it serves and answers. Arguments and results are structured-cloned, which is
 * why everything that crosses — a run snapshot, a match, a card definition — is plain data.
 */

/** Something a port can carry: a worker's `parentPort` or either end of a channel. */
export interface Port {
  postMessage(value: unknown, transferList?: readonly MessagePort[]): void;
  on(event: 'message', listener: (value: unknown) => void): unknown;
  off(event: 'message', listener: (value: unknown) => void): unknown;
}

interface Call {
  readonly call: number;
  readonly method: string;
  readonly args: readonly unknown[];
}

interface Reply {
  readonly reply: number;
  readonly result?: unknown;
  readonly error?: { readonly name: string; readonly message: string };
}

const isCall = (value: unknown): value is Call =>
  typeof value === 'object' && value !== null && 'call' in value && 'method' in value;
const isReply = (value: unknown): value is Reply =>
  typeof value === 'object' && value !== null && 'reply' in value;

/** An error that crossed a port, keeping the name it had on the other side. */
export class RemoteError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

/** Every method of `T` that returns a promise, and nothing else. */
export type Remote<T> = {
  [K in keyof T as T[K] extends (...args: never[]) => Promise<unknown> ? K : never]: T[K];
};

/**
 * Answers calls on `port` by running them on `target`. `after` is told of each call that
 * succeeded, after it has — how the API process learns what a worker just wrote. Returns a
 * function that stops serving.
 */
export const serve = <T extends object>(
  port: Port,
  target: T,
  after?: (method: string, args: readonly unknown[], result: unknown) => void,
): (() => void) => {
  const listener = (value: unknown) => {
    if (!isCall(value)) return;
    const method = (target as Record<string, unknown>)[value.method];
    const answer = async (): Promise<Reply> => {
      try {
        if (typeof method !== 'function') throw new Error(`no method ${value.method}`);
        const result = await method.apply(target, value.args);
        after?.(value.method, value.args, result);
        return { reply: value.call, result };
      } catch (error) {
        const { name, message } =
          error instanceof Error ? error : { name: 'Error', message: String(error) };
        return { reply: value.call, error: { name, message } };
      }
    };
    void answer().then((reply) => port.postMessage(reply));
  };
  port.on('message', listener);
  return () => port.off('message', listener);
};

/** A proxy that calls `T`'s asynchronous methods on whatever serves the other end. */
export const client = <T extends object>(port: Port): Remote<T> => {
  let next = 0;
  const waiting = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  port.on('message', (value) => {
    if (!isReply(value)) return;
    const pending = waiting.get(value.reply);
    if (pending === undefined) return;
    waiting.delete(value.reply);
    if (value.error === undefined) pending.resolve(value.result);
    else pending.reject(new RemoteError(value.error.name, value.error.message));
  });
  return new Proxy({} as Remote<T>, {
    get: (_, method) => {
      if (typeof method !== 'string' || method === 'then') return undefined;
      return (...args: unknown[]) =>
        new Promise((resolve, reject) => {
          const call = next++;
          waiting.set(call, { resolve, reject });
          port.postMessage({ call, method, args } satisfies Call);
        });
    },
  });
};
