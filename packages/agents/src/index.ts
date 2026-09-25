/**
 * The play AI (evaluator, bounded search, mulligans, sideboarding) and the
 * deck-change AI. See docs/04-agents.md.
 *
 * **This package can only see what a player can see.** It imports `@mtg/engine/view`
 * rather than `@mtg/engine`, so a `GameState` — and with it both hands and both library
 * orders — is not reachable from here at all. `import-boundary.test.ts` enforces it,
 * because the failure it prevents is invisible: an agent that peeked would not crash, it
 * would simply win, and nothing in a run would say why.
 *
 * A searching agent still plays the game forward: the driver hands it a simulator of
 * determinisations built from what it can see (ADR 0012), not the game itself.
 *
 * Phase 4 of docs/10-roadmap.md fills the rest in: the evaluator and all four levels —
 * `random`, `greedy`, `search` and `deep` — are here; the combat solver is 4.4.
 */
export * from './after-action.js';
export * from './evaluate.js';
export * from './greedy.js';
export * from './play-agent.js';
export * from './random.js';
export * from './search.js';
export * from './weights.js';
