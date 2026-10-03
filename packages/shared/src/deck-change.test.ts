import { describe, expect, it } from 'vitest';
import { applyDeckChange, type Deck75, deckDiff, IllegalDeckChangeError } from './deck-change.js';
import { asOracleId } from './ids.js';

/** Applying a deck change (docs/05 "Choosing the change"; roadmap 5.4). */

const id = asOracleId;
const deck: Deck75 = {
  main: [
    { oracleId: id('bear'), count: 4 },
    { oracleId: id('bolt'), count: 4 },
    { oracleId: id('forest'), count: 52 },
  ],
  side: [
    { oracleId: id('naturalize'), count: 4 },
    { oracleId: id('wall'), count: 11 },
  ],
};
const total = (slots: Deck75['main']) => slots.reduce((sum, slot) => sum + slot.count, 0);

describe('a replacement', () => {
  it('takes every copy named out of the zone and puts the new card in, keeping 60/15', () => {
    const after = applyDeckChange(deck, {
      shape: 'replace',
      remove: { oracleId: id('bear'), zone: 'main', count: 4 },
      add: { oracleId: id('wolf'), zone: 'main', count: 4 },
    });
    expect(after.main).toEqual([
      { oracleId: id('bolt'), count: 4 },
      { oracleId: id('forest'), count: 52 },
      { oracleId: id('wolf'), count: 4 },
    ]);
    expect(after.side).toEqual(deck.side);
  });

  it('can take part of a slot, and add to one already there', () => {
    const after = applyDeckChange(deck, {
      shape: 'replace',
      remove: { oracleId: id('forest'), zone: 'main', count: 4 },
      add: { oracleId: id('bolt'), zone: 'main', count: 4 },
    });
    expect(after.main).toContainEqual({ oracleId: id('forest'), count: 48 });
    expect(after.main).toContainEqual({ oracleId: id('bolt'), count: 8 });
    expect(total(after.main)).toBe(60);
  });

  it('works in the sideboard', () => {
    const after = applyDeckChange(deck, {
      shape: 'replace',
      remove: { oracleId: id('naturalize'), zone: 'side', count: 4 },
      add: { oracleId: id('shatter'), zone: 'side', count: 4 },
    });
    expect(after.side.map((slot) => slot.oracleId)).toEqual([id('shatter'), id('wall')]);
    expect(total(after.side)).toBe(15);
  });

  it('refuses to remove copies that are not there, or a different number than it adds', () => {
    expect(() =>
      applyDeckChange(deck, {
        shape: 'replace',
        remove: { oracleId: id('bear'), zone: 'main', count: 5 },
        add: { oracleId: id('wolf'), zone: 'main', count: 5 },
      }),
    ).toThrow(IllegalDeckChangeError);
    expect(() =>
      applyDeckChange(deck, {
        shape: 'replace',
        remove: { oracleId: id('bear'), zone: 'side', count: 4 },
        add: { oracleId: id('wolf'), zone: 'side', count: 4 },
      }),
    ).toThrow(/side deck holds 0/);
    expect(() =>
      applyDeckChange(deck, {
        shape: 'replace',
        remove: { oracleId: id('bear'), zone: 'main', count: 4 },
        add: { oracleId: id('wolf'), zone: 'main', count: 3 },
      }),
    ).toThrow(/as many cards/);
    expect(() =>
      applyDeckChange(deck, {
        shape: 'replace',
        remove: { oracleId: id('bear'), zone: 'main', count: 4 },
        add: { oracleId: id('wolf'), zone: 'side', count: 4 },
      }),
    ).toThrow(/one zone/);
  });
});

describe('a swap', () => {
  it('trades a main-deck card and a sideboard card between the two', () => {
    const after = applyDeckChange(deck, {
      shape: 'swap',
      remove: { oracleId: id('bear'), zone: 'main', count: 4 },
      add: { oracleId: id('naturalize'), zone: 'main', count: 4 },
    });
    expect(after.main).toContainEqual({ oracleId: id('naturalize'), count: 4 });
    expect(after.main.some((slot) => slot.oracleId === id('bear'))).toBe(false);
    expect(after.side).toContainEqual({ oracleId: id('bear'), count: 4 });
    expect(after.side.some((slot) => slot.oracleId === id('naturalize'))).toBe(false);
    expect([total(after.main), total(after.side)]).toEqual([60, 15]);
  });

  it('refuses a card the sideboard does not hold', () => {
    expect(() =>
      applyDeckChange(deck, {
        shape: 'swap',
        remove: { oracleId: id('bear'), zone: 'main', count: 4 },
        add: { oracleId: id('wolf'), zone: 'main', count: 4 },
      }),
    ).toThrow(/side deck holds 0 of wolf/);
  });
});

describe('the difference between two decks', () => {
  const before: Deck75 = {
    main: [
      { oracleId: id('bolt'), count: 4 },
      { oracleId: id('shock'), count: 4 },
      { oracleId: id('mountain'), count: 52 },
    ],
    side: [{ oracleId: id('pyro'), count: 15 }],
  };

  it('is a replacement’s slot out and slot in', () => {
    const after = applyDeckChange(before, {
      shape: 'replace',
      remove: { oracleId: id('shock'), zone: 'main', count: 4 },
      add: { oracleId: id('chain'), zone: 'main', count: 4 },
    });
    expect(deckDiff(before, after)).toEqual({
      removed: [{ oracleId: id('shock'), zone: 'main', count: 4 }],
      added: [{ oracleId: id('chain'), zone: 'main', count: 4 }],
    });
  });

  it('counts copies, zone by zone: a card moved to the side is out of one and into the other', () => {
    const after: Deck75 = {
      main: [
        { oracleId: id('bolt'), count: 1 },
        { oracleId: id('shock'), count: 4 },
        { oracleId: id('mountain'), count: 52 },
        { oracleId: id('pyro'), count: 3 },
      ],
      side: [
        { oracleId: id('pyro'), count: 12 },
        { oracleId: id('bolt'), count: 3 },
      ],
    };
    expect(deckDiff(before, after)).toEqual({
      removed: [
        { oracleId: id('bolt'), zone: 'main', count: 3 },
        { oracleId: id('pyro'), zone: 'side', count: 3 },
      ],
      added: [
        { oracleId: id('pyro'), zone: 'main', count: 3 },
        { oracleId: id('bolt'), zone: 'side', count: 3 },
      ],
    });
    expect(deckDiff(before, before)).toEqual({ removed: [], added: [] });
  });
});
