import type { BoardObject, CardFace, EventLogObject, ObjectId } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { type GameCards, loyaltyOf, nameOf, powerToughness, rowOf } from './model.js';

/** What the board draws of each object beyond the folded board (docs/08 "Game viewer"). */

const face = (oracleId: string, typeLine: string, extra: Partial<CardFace> = {}): CardFace => ({
  oracleId,
  name: oracleId,
  manaCost: null,
  manaValue: 0,
  typeLine,
  colorIdentity: [],
  support: 'supported',
  oracleText: '',
  power: null,
  toughness: null,
  loyalty: null,
  ...extra,
});

const id = (n: number) => n as ObjectId;
const identity = (n: number, oracleId: string, extra: Partial<EventLogObject> = {}) =>
  [id(n), { id: id(n), oracleId, owner: 'A', ...extra } as EventLogObject] as const;

const cards: GameCards = {
  identities: new Map([
    identity(1, 'bear'),
    identity(2, 'walker'),
    identity(3, 'bear', { token: true, name: 'Elf', power: 1, toughness: 1 }),
    identity(4, 'treasure', { token: true, name: 'Treasure', power: null, toughness: null }),
    identity(5, 'forest'),
    identity(6, 'manland'),
    identity(7, 'anthem'),
    identity(8, 'goyf'),
    identity(9, 'bear', { ability: true }),
  ]),
  faces: new Map(
    [
      face('bear', 'Creature — Bear', { power: '2', toughness: '2' }),
      face('walker', 'Legendary Planeswalker — Jace', { loyalty: '3' }),
      face('treasure', 'Artifact'),
      face('forest', 'Basic Land — Forest'),
      face('manland', 'Land'),
      face('anthem', 'Enchantment'),
      face('goyf', 'Creature — Lhurgoyf', { power: '*', toughness: '1+*' }),
    ].map((card) => [card.oracleId, card]),
  ),
};

const object = (n: number, extra: Partial<BoardObject> = {}): BoardObject => ({
  id: id(n),
  zone: 'battlefield',
  tapped: false,
  counters: {},
  damage: 0,
  deathtouched: false,
  attacking: null,
  blocking: [],
  ability: false,
  ...extra,
});

describe('the board’s figures', () => {
  it('adds +1/+1 counters and takes -1/-1 counters off what is printed (CR 122.1a)', () => {
    expect(powerToughness(cards, object(1))).toEqual({ power: '2', toughness: '2' });
    expect(powerToughness(cards, object(1, { counters: { '+1/+1': 3, '-1/-1': 1 } }))).toEqual({
      power: '4',
      toughness: '4',
    });
    // A token's own, which no card says.
    expect(powerToughness(cards, object(3, { counters: { '+1/+1': 1 } }))).toEqual({
      power: '2',
      toughness: '2',
    });
    // A printed star is shown as printed.
    expect(powerToughness(cards, object(8))).toEqual({ power: '*', toughness: '1+*' });
    expect(powerToughness(cards, object(7))).toBeNull();
  });

  it('reads loyalty from the counters on the battlefield, and from the card elsewhere', () => {
    expect(loyaltyOf(cards, object(2, { counters: { loyalty: 5 } }))).toBe('5');
    expect(loyaltyOf(cards, object(2, { zone: 'A:hand' }))).toBe('3');
  });

  it('puts each permanent in its row: lands, creatures, the rest', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => rowOf(cards, id(n)))).toEqual([
      'creatures',
      'other',
      'creatures',
      'other',
      'lands',
      'lands',
      'other',
    ]);
  });

  it('names a card, a token and an ability as what they are', () => {
    expect([1, 3, 9, 99].map((n) => nameOf(cards, id(n)))).toEqual([
      'bear',
      'Elf token',
      'bear’s ability',
      'object 99',
    ]);
  });
});
