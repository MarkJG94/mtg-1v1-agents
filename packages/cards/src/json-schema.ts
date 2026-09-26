import { z } from 'zod';
import { cardScriptSchema } from './schema.js';

/**
 * JSON Schema for card scripts, so an editor can complete and check YAML as it is typed
 * (docs/03 "Script schema").
 *
 * It describes the *input* shape — the friendly one a person writes, `filter: any` and
 * `to: $t` — rather than the tagged unions the loader turns those into. That is the whole
 * point: the schema an author is helped by is the one they are typing.
 */
export const cardScriptJsonSchema = (): Record<string, unknown> =>
  z.toJSONSchema(cardScriptSchema, {
    io: 'input',
    target: 'draft-2020-12',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
