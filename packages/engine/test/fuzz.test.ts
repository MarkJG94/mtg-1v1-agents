import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { playGame, replayGame } from '../src/testing/index.js';
import { blueBlackDeck, CARDS, greenWhiteDeck, redDeck } from './fixtures/cards.js';

const DECKS = { red: redDeck(), gw: greenWhiteDeck(), ub: blueBlackDeck() };
type DeckName = keyof typeof DECKS;

/**
 * Invariant fuzzing (docs/09-testing.md §4): random supported decks, the random agent for both players, and the
 * structural invariants checked after every engine step. FUZZ_RUNS raises the budget for nightly runs.
 */
describe('invariant fuzzing', () => {
  const runs = Number(process.env.FUZZ_RUNS ?? 40);

  it('random games never violate invariants and always terminate', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<DeckName>('red', 'gw', 'ub'),
        fc.constantFrom<DeckName>('red', 'gw', 'ub'),
        fc.nat({ max: 1_000_000 }),
        (a, b, seed) => {
          const r = playGame({
            definitions: CARDS,
            decks: { A: DECKS[a], B: DECKS[b] },
            seed: `fuzz-${a}-${b}-${seed}`,
            invariants: true,
          });
          expect(r.state.result).not.toBeNull();
          expect(r.state.turn).toBeLessThanOrEqual(r.state.config.turnCap + 1);
        },
      ),
      { numRuns: runs, verbose: false },
    );
  });

  it('every game replays to an identical event log from its answers', () => {
    for (let seed = 1; seed <= 3; seed++) {
      const opts = {
        definitions: CARDS,
        decks: { A: DECKS.gw, B: DECKS.ub },
        seed: `replay-${seed}`,
      };
      const r = playGame(opts);
      const rep = replayGame(opts, r.answers);
      expect(rep.events).toEqual(r.events);
    }
  });
});
