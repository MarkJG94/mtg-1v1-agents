import { asOracleId, parseDecklist, type ResolvedCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { checkPastedDeck, nameKey, namesToResolve } from './deck-paste.js';

/** A pasted 75, checked card by card (docs/08 "New run"). */

const card = (
  name: string,
  support: ResolvedCard['support'] = 'supported',
  query = name,
): ResolvedCard => ({ query, oracleId: `id-${name}`, name, support });
const missing = (query: string): ResolvedCard => ({
  query,
  oracleId: null,
  name: null,
  support: null,
});

const known = (...cards: ResolvedCard[]) =>
  new Map(cards.map((each) => [nameKey(each.query), each]));

const LIST = '20 Mountain\n40 Lightning Bolt\n\n15 Pyroblast';
const all = known(card('Mountain'), card('Lightning Bolt'), card('Pyroblast'));

describe('checking a pasted deck', () => {
  it('makes the 75 when every card is known, playable and the counts are right', () => {
    const checked = checkPastedDeck(parseDecklist(LIST), all, new Map());
    expect(checked.problems).toEqual([]);
    expect(checked.deck).toEqual({
      main: [
        { oracleId: 'id-Mountain', count: 20 },
        { oracleId: 'id-Lightning Bolt', count: 40 },
      ],
      side: [{ oracleId: 'id-Pyroblast', count: 15 }],
    });
  });

  it('adds up a card listed twice, and one written in another case', () => {
    const resolved = known(
      card('Mountain'),
      card('Lightning Bolt', 'supported', 'lightning bolt'),
      card('Pyroblast'),
    );
    const checked = checkPastedDeck(
      parseDecklist('20 Mountain\n30 lightning bolt\n10 Lightning Bolt\nSideboard\n15 Pyroblast'),
      resolved,
      new Map(),
    );
    expect(checked.deck?.main).toEqual([
      { oracleId: 'id-Mountain', count: 20 },
      { oracleId: 'id-Lightning Bolt', count: 40 },
    ]);
  });

  it('waits for names not yet looked up, without calling them wrong', () => {
    const checked = checkPastedDeck(parseDecklist(LIST), known(card('Mountain')), new Map());
    expect(checked.pending).toBe(2);
    expect(checked.problems).toEqual([]);
    expect(checked.deck).toBeNull();
  });

  it('says which line names no card, and which card the engine cannot play', () => {
    const checked = checkPastedDeck(
      parseDecklist(LIST),
      known(card('Mountain'), missing('Lightning Bolt'), card('Pyroblast', 'partial')),
      new Map(),
    );
    expect(checked.problems).toEqual([
      'line 2: no card is named “Lightning Bolt”',
      'line 4: Pyroblast cannot be played yet (its script is partial)',
    ]);
    expect(checked.deck).toBeNull();
  });

  it('holds the counts to sixty and fifteen', () => {
    const checked = checkPastedDeck(
      parseDecklist('20 Mountain\n39 Lightning Bolt\n\n16 Pyroblast'),
      all,
      new Map(),
    );
    expect(checked.problems).toEqual([
      'the main deck has 59 cards, not 60',
      'the sideboard has 16 cards, not 15',
    ]);
    expect([checked.mainCount, checked.sideCount]).toEqual([59, 16]);
    expect(checked.deck).toBeNull();
    // Short is as wrong as long.
    const short = checkPastedDeck(
      parseDecklist('20 Mountain\n41 Lightning Bolt\n\n14 Pyroblast'),
      all,
      new Map(),
    );
    expect(short.problems).toEqual([
      'the main deck has 61 cards, not 60',
      'the sideboard has 14 cards, not 15',
    ]);
  });

  it('holds the deck to the initial ban list, main and side together', () => {
    const banned = checkPastedDeck(
      parseDecklist(LIST),
      all,
      new Map([[asOracleId('id-Pyroblast'), 'banned' as const]]),
    );
    expect(banned.problems).toEqual(['Pyroblast is banned']);
    const restricted = checkPastedDeck(
      parseDecklist('20 Mountain\n39 Lightning Bolt\n1 Pyroblast\n\n14 Pyroblast\n1 Mountain'),
      all,
      new Map([[asOracleId('id-Pyroblast'), 'restricted' as const]]),
    );
    expect(restricted.problems).toEqual([
      'Pyroblast is restricted to one copy, and the deck has 15',
    ]);
    expect(restricted.deck).toBeNull();
  });

  it('passes on the parser’s problems with their lines', () => {
    const checked = checkPastedDeck(parseDecklist(`${LIST}\n4x`), all, new Map());
    expect(checked.problems).toEqual(['line 5: no card name']);
  });

  it('asks for each name once, whatever its case', () => {
    expect(namesToResolve(parseDecklist('4 Island\n2 island\nSideboard\n1 ISLAND\n3 Bog'))).toEqual(
      ['Island', 'Bog'],
    );
  });
});
