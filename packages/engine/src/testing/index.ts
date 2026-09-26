/**
 * Test and fuzzing support for the engine (`@mtg/engine/testing`).
 *
 * A separate entry point on purpose. The engine ships with zero third-party runtime
 * dependencies and a bundle small enough to run inside a search loop; a scenario builder
 * and a fuzzer belong to neither, so they are built separately and never reach the
 * runtime bundle. `no-runtime-deps.test.ts` checks that guarantee against `index.ts`.
 */
export * from './fuzz.js';
export * from './fuzz-cards.js';
export * from './random-agent.js';
export * from './scenario.js';
export * from './unseen.js';
