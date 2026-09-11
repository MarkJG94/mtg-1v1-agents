import { describe, expect, it } from 'vitest';
import { playGame } from '../src/testing/index.js';
import { blueBlackDeck, CARDS, greenWhiteDeck, redDeck } from './fixtures/cards.js';

describe('random games (smoke)', () => {
  it('plays red mirror games to completion with invariants', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const r = playGame({
        definitions: CARDS,
        decks: { A: redDeck(), B: redDeck() },
        seed,
        invariants: true,
      });
      expect(r.state.result).not.toBeNull();
    }
  });

  it('plays mixed-deck games to completion with invariants', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const r = playGame({
        definitions: CARDS,
        decks: { A: greenWhiteDeck(), B: blueBlackDeck() },
        seed,
        invariants: true,
      });
      expect(r.state.result).not.toBeNull();
    }
  });
});
