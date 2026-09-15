/**
 * Card scripts: the schema, the loader and (in roadmap 2.4) the auto-scripter.
 *
 * Cards are data, not code (docs/03). A script is YAML in a closed vocabulary; the engine
 * plays `CardDefinition`s. Everything in here is the path between the two, and nothing in
 * here knows how to play Magic — that is the engine's job.
 */

export * from './checks.js';
export * from './files.js';
export * from './json-schema.js';
export * from './load.js';
export * from './ops-spec.js';
export * from './oracle-text.js';
export * from './schema.js';
export * from './scryfall.js';
export * from './smoke.js';
export * from './validate.js';
