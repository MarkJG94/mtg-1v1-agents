import { describe, expect, it } from 'vitest';
import { normalizeOracleText, splitSentences } from '../src/normalize.js';

describe('oracle text normalisation', () => {
  it('replaces the card name (and short name) with ~ and drops reminder text', () => {
    const n = normalizeOracleText(
      'Isamaru, Hound of Konda gets +1/+1. (Reminder.) Isamaru attacks.',
      'Isamaru, Hound of Konda',
    );
    expect(n.sentences).toEqual(['~ gets +1/+1.', '~ attacks.']);
  });

  it('splits lines and sentences without breaking on P/T or mana symbols', () => {
    expect(splitSentences('{T}: Add {R} or {G}. Karplusan Forest deals 1 damage to you.')).toEqual([
      '{T}: Add {R} or {G}.',
      'Karplusan Forest deals 1 damage to you.',
    ]);
    const n = normalizeOracleText('Flying, vigilance\n+2: Each player draws a card.', 'X');
    expect(n.lines).toEqual([['Flying, vigilance'], ['+2: Each player draws a card.']]);
  });

  it('reminder-only text normalises to nothing', () => {
    expect(normalizeOracleText('({T}: Add {G}.)', 'Forest').sentences).toEqual([]);
  });
});
