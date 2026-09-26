import type { ApiError } from '@mtg/shared';
import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

/**
 * docs/07's errors: `{ error: { code, message, details? } }` with a status to match, and
 * a request that does not parse is a 400 carrying zod's issues. Routes throw; this turns
 * what they throw into the response.
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const notFound = (what: string): HttpError =>
  new HttpError(404, 'not_found', `${what} not found`);

const body = (code: string, message: string, details?: unknown): ApiError => ({
  error: { code, message, ...(details === undefined ? {} : { details }) },
});

/** Errors from the run layer, by name — they may have crossed a worker's port. */
const byName: Readonly<Record<string, { status: number; code: string }>> = {
  RunError: { status: 409, code: 'conflict' },
  IllegalDeckChangeError: { status: 409, code: 'conflict' },
};

export const registerErrors = (app: FastifyInstance): void => {
  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.status).send(body(error.code, error.message, error.details));
    }
    if (error instanceof ZodError) {
      return reply
        .status(400)
        .send(body('invalid_request', 'the request does not match the API', error.issues));
    }
    if (error.name === 'SupervisorError') {
      const missing = error.message.startsWith('no run');
      return reply
        .status(missing ? 404 : 409)
        .send(body(missing ? 'not_found' : 'conflict', error.message));
    }
    const known = byName[error.name];
    if (known !== undefined) {
      return reply.status(known.status).send(body(known.code, error.message));
    }
    // Fastify's own: a body that is not JSON, one too large, and the like.
    const status = 'statusCode' in error ? error.statusCode : undefined;
    if (status !== undefined && status >= 400 && status < 500) {
      const code = 'code' in error && typeof error.code === 'string' ? error.code : 'bad_request';
      return reply.status(status).send(body(code, error.message));
    }
    request.log.error(error);
    return reply.status(500).send(body('internal', 'something went wrong'));
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send(body('not_found', `no route ${request.method} ${request.url}`)),
  );
};
