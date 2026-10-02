import { describe, expect, it } from 'vitest';
import { fuzzReplay } from './replay-check.js';

/**
 * docs/09: the event log replays to the engine's own board — after every decision, not
 * only at the end, so a fact the log loses is caught where it is lost.
 */
describe('replay(log) == state', () => {
  it('holds after every decision of random games', () => {
    const games = Array.from({ length: 150 }, (_, i) => fuzzReplay(`replay-${i}`));
    // They were real games: long enough, and some of them over by damage.
    expect(games.reduce((sum, game) => sum + game.turns, 0)).toBeGreaterThan(150 * 5);
  });
});
