import { describe, expect, it } from 'vitest';
import {
  affected,
  banMarkers,
  colourShare,
  cycleOfGame,
  formatDelta,
  groupDeck,
  groupOf,
  held,
  manaCurve,
  pipsOf,
} from './dashboard.js';

/** What the run dashboard works out (docs/08 "Run dashboard"; roadmap 6.4). */

const facts = new Map([
  ['bolt', { name: 'Lightning Bolt', typeLine: 'Instant', manaValue: 1, manaCost: '{R}' }],
  [
    'goyf',
    { name: 'Tarmogoyf', typeLine: 'Creature — Lhurgoyf', manaValue: 2, manaCost: '{1}{G}' },
  ],
  [
    'ornithopter',
    { name: 'Ornithopter', typeLine: 'Artifact Creature — Thopter', manaValue: 0, manaCost: '{0}' },
  ],
  ['vault', { name: 'Darksteel Citadel', typeLine: 'Artifact Land', manaValue: 0, manaCost: null }],
  [
    'mountain',
    { name: 'Mountain', typeLine: 'Basic Land — Mountain', manaValue: 0, manaCost: null },
  ],
  [
    'emrakul',
    { name: 'Emrakul', typeLine: 'Legendary Creature — Eldrazi', manaValue: 15, manaCost: '{15}' },
  ],
  [
    'fireice',
    {
      name: 'Fire // Ice',
      typeLine: 'Instant // Instant',
      manaValue: 4,
      manaCost: '{1}{R} // {1}{U}',
    },
  ],
  ['boros', { name: 'Boros Charm', typeLine: 'Instant', manaValue: 2, manaCost: '{R}{W}' }],
  ['hybrid', { name: 'Figure', typeLine: 'Creature — Human', manaValue: 1, manaCost: '{R/W}' }],
  [
    'mite',
    {
      name: 'Vault Skirge',
      typeLine: 'Artifact Creature — Imp',
      manaValue: 2,
      manaCost: '{1}{B/P}',
    },
  ],
]);

describe('the cycle a ban took effect in', () => {
  it('reads it from the game stamp: a cycle’s start, one of its games, or the run’s making', () => {
    expect(cycleOfGame('42:cycle-7:start')).toBe(7);
    expect(cycleOfGame('42:cycle-12:match-3:game-2')).toBe(12);
    expect(cycleOfGame('run-id:created')).toBe(0);
    expect(cycleOfGame(null)).toBeNull();
    expect(cycleOfGame('something else')).toBeNull();
  });

  it('groups applied edits by cycle, oldest first, leaving the pending out', () => {
    const event = (oracleId: string, gameId: string | null) => ({
      oracleId,
      action: 'ban' as const,
      appliedAfterGameId: gameId,
    });
    const markers = banMarkers([
      event('a', '1:cycle-5:match-0:game-1'),
      event('b', null),
      event('c', '1:cycle-2:start'),
      event('d', '1:cycle-5:start'),
    ]);
    expect(
      markers.map((marker) => [marker.cycle, marker.events.map((each) => each.oracleId)]),
    ).toEqual([
      [2, ['c']],
      [5, ['a', 'd']],
    ]);
  });
});

describe('a deck, read', () => {
  it('groups a card by its front face’s first type in decklist order', () => {
    expect(groupOf('Artifact Creature — Thopter')).toBe('Creature');
    expect(groupOf('Artifact Land')).toBe('Land');
    expect(groupOf('Legendary Planeswalker — Jace')).toBe('Planeswalker');
    expect(groupOf('Instant // Sorcery')).toBe('Instant');
    expect(groupOf('Kindred Enchantment — Elf')).toBe('Enchantment');
    expect(groupOf('Conspiracy')).toBe('Other');
    // A subtype is not a type: a Land Mine is not a land.
    expect(groupOf('Artifact — Land Mine')).toBe('Artifact');
  });

  it('lists each group with its count, cheapest first, and a card not yet looked up in Other', () => {
    const groups = groupDeck(
      [
        { oracleId: 'mountain', count: 20 },
        { oracleId: 'goyf', count: 4 },
        { oracleId: 'bolt', count: 4 },
        { oracleId: 'ornithopter', count: 2 },
        { oracleId: 'unknown', count: 1 },
      ],
      facts,
    );
    expect(groups.map((group) => [group.group, group.count])).toEqual([
      ['Creature', 6],
      ['Land', 20],
      ['Instant', 4],
      ['Other', 1],
    ]);
    expect(groups[0]?.cards.map((card) => card.oracleId)).toEqual(['ornithopter', 'goyf']);
  });

  it('draws the curve from spells alone, copies counted, seven and up together', () => {
    expect(
      manaCurve(
        [
          { oracleId: 'mountain', count: 20 },
          { oracleId: 'vault', count: 2 },
          { oracleId: 'ornithopter', count: 2 },
          { oracleId: 'bolt', count: 4 },
          { oracleId: 'goyf', count: 3 },
          { oracleId: 'emrakul', count: 1 },
        ],
        facts,
      ),
    ).toEqual([2, 4, 3, 0, 0, 0, 0, 1]);
  });

  it('counts coloured symbols: hybrid pays either, Phyrexian its colour, generic none', () => {
    expect(pipsOf('{2}{R}{R}')).toEqual({ W: 0, U: 0, B: 0, R: 2, G: 0 });
    expect(pipsOf('{R/W}')).toEqual({ W: 1, U: 0, B: 0, R: 1, G: 0 });
    expect(pipsOf('{1}{B/P}')).toEqual({ W: 0, U: 0, B: 1, R: 0, G: 0 });
    expect(pipsOf('{X}{C}{S}')).toEqual({ W: 0, U: 0, B: 0, R: 0, G: 0 });
    expect(pipsOf(null)).toEqual({ W: 0, U: 0, B: 0, R: 0, G: 0 });
    expect(
      colourShare(
        [
          { oracleId: 'bolt', count: 4 },
          { oracleId: 'boros', count: 2 },
          { oracleId: 'fireice', count: 1 },
          { oracleId: 'mountain', count: 20 },
        ],
        facts,
      ),
    ).toEqual({ W: 2, U: 1, B: 0, R: 7, G: 0 });
  });
});

describe('what a ban would do', () => {
  const decks = {
    A: { main: [{ oracleId: 'bolt', count: 3 }], side: [{ oracleId: 'bolt', count: 1 }] },
    B: { main: [{ oracleId: 'bolt', count: 1 }], side: [] },
  };

  it('counts copies across main and side', () => {
    expect(held(decks.A, 'bolt')).toBe(4);
    expect(held(decks.B, 'goyf')).toBe(0);
  });

  it('names the agents over the limit: any copy for a ban, a second for a restriction', () => {
    expect(affected(decks, 'bolt', 'banned')).toEqual([
      { agent: 'A', held: 4, allowed: 0 },
      { agent: 'B', held: 1, allowed: 0 },
    ]);
    expect(affected(decks, 'bolt', 'restricted')).toEqual([{ agent: 'A', held: 4, allowed: 1 }]);
    expect(affected(decks, 'goyf', 'banned')).toEqual([]);
  });
});

describe('a card’s Δ', () => {
  it('reads in percentage points with its sign as a glyph', () => {
    expect(formatDelta(0.0421)).toEqual({ text: '+4.2', glyph: '▲', sign: 1 });
    expect(formatDelta(-0.1)).toEqual({ text: '−10.0', glyph: '▼', sign: -1 });
    expect(formatDelta(0.0004)).toEqual({ text: '0.0', glyph: '•', sign: 0 });
  });
});
