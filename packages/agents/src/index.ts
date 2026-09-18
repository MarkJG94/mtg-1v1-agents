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
 * Phase 4 of docs/10-roadmap.md fills the rest in: the evaluator and `greedy` in 4.2,
 * the bounded search in 4.3, the combat solver in 4.4.
 */
export * from './play-agent.js';
