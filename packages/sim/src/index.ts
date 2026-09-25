/**
 * Match, cycle and run orchestration, statistics aggregation and ban
 * legalisation. See docs/05-evolution.md.
 *
 * Phase 5 of docs/10-roadmap.md fills this in. What is here so far is the single game
 * between two agents that the rest will be built on, which roadmap 4.3 needed first so
 * that an agent could be played at all, and the sanity ladder that plays agent levels
 * against each other (docs/09). Until phase 5 brings decks, the ladder plays on the
 * engine's fuzz boards.
 */
export * from './cycle.js';
export * from './deck.js';
export * from './event-log.js';
export * from './game.js';
export * from './ladder.js';
export * from './match.js';
export * from './sideboard-cards.js';
export * from './stats.js';
export * from './tuning.js';
