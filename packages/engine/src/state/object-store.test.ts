import { asObjectId, asOracleId } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { noKeywords } from '../targeting.js';
import type { GameObject } from './object.js';
import { ObjectStore } from './object-store.js';

/**
 * The object table (roadmap 4.2, ADR 0010).
 *
 * `ObjectStore` stands where a `ReadonlyMap` used to, so what has to hold is that it
 * behaves like one — and that it is immutable, because the whole engine is built on a
 * state you can keep a reference to and still trust.
 */

const card = (id: number, over: Partial<GameObject> = {}): GameObject => ({
  id: asObjectId(id),
  definitionId: asOracleId(`oracle-${id}`),
  owner: 'A',
  controller: 'A',
  zone: 'battlefield',
  timestamp: id,
  tapped: false,
  counters: {},
  damage: 0,
  attachedTo: null,
  attachments: [],
  chosen: {},
  token: false,
  keywords: noKeywords,
  power: null,
  toughness: null,
  loyalty: null,
  name: `card-${id}`,
  legendary: false,
  colours: [],
  attachment: null,
  deathtouched: false,
  triggers: [],
  loyaltyAbilities: [],
  summoningSick: false,
  ...over,
});

const storeOf = (...ids: number[]): ObjectStore => {
  let store = ObjectStore.empty;
  for (const id of ids) store = store.withObject(asObjectId(id), card(id));
  return store;
};

describe('reading', () => {
  it('answers for an object it holds and not for one it does not', () => {
    const store = storeOf(1, 2);

    expect(store.get(asObjectId(1))?.name).toBe('card-1');
    expect(store.has(asObjectId(2))).toBe(true);
    expect(store.get(asObjectId(3))).toBeUndefined();
    expect(store.has(asObjectId(3))).toBe(false);
    expect(store.size).toBe(2);
  });

  /**
   * Index 0 is never used — ids start at 1 — and the gap a removed object leaves behind
   * is not an object either. A store that reported either as present would have the whole
   * engine asking about something that is not there.
   */
  it('reports neither the unused first slot nor a removed one', () => {
    const store = storeOf(1, 2, 3).without(asObjectId(2));

    expect(store.has(asObjectId(0))).toBe(false);
    expect(store.has(asObjectId(2))).toBe(false);
    expect(store.size).toBe(2);
    expect([...store.keys()]).toEqual([asObjectId(1), asObjectId(3)]);
  });
});

describe('iteration', () => {
  it('skips the gaps in every way of walking it', () => {
    const store = storeOf(1, 2, 3).without(asObjectId(1));

    expect([...store]).toEqual([
      [asObjectId(2), store.get(asObjectId(2))],
      [asObjectId(3), store.get(asObjectId(3))],
    ]);
    expect([...store.entries()].map(([id]) => id)).toEqual([asObjectId(2), asObjectId(3)]);
    expect([...store.values()].map((object) => object.name)).toEqual(['card-2', 'card-3']);

    const seen: string[] = [];
    store.forEach((object, id) => {
      seen.push(`${id}:${object.name}`);
    });
    expect(seen).toEqual(['2:card-2', '3:card-3']);
  });

  /**
   * A `Map` walks in insertion order and this walks in id order. Those were only ever the
   * same order because ids are handed out in sequence, so it is worth pinning: something
   * added later still comes last.
   */
  it('walks in id order, which is the order objects were made in', () => {
    const store = storeOf(3, 1, 2);
    expect([...store.keys()]).toEqual([asObjectId(1), asObjectId(2), asObjectId(3)]);
  });
});

describe('every change leaves the store it came from alone', () => {
  it('does not touch the original when one object is replaced', () => {
    const before = storeOf(1, 2);
    const after = before.withObject(asObjectId(2), card(2, { name: 'changed' }));

    expect(before.get(asObjectId(2))?.name).toBe('card-2');
    expect(after.get(asObjectId(2))?.name).toBe('changed');
    expect(before.get(asObjectId(1))).toBe(after.get(asObjectId(1)));
  });

  it('does not touch the original when several are patched at once', () => {
    const before = storeOf(1, 2, 3);
    const after = before.withObjects([
      [asObjectId(1), card(1, { tapped: true })],
      [asObjectId(3), card(3, { tapped: true })],
    ]);

    expect(before.get(asObjectId(1))?.tapped).toBe(false);
    expect(before.get(asObjectId(3))?.tapped).toBe(false);
    expect(after.get(asObjectId(1))?.tapped).toBe(true);
    expect(after.get(asObjectId(3))?.tapped).toBe(true);
    expect(after.size).toBe(3);
  });

  it('does not touch the original when one is removed', () => {
    const before = storeOf(1, 2);
    const after = before.without(asObjectId(1));

    expect(before.has(asObjectId(1))).toBe(true);
    expect(before.size).toBe(2);
    expect(after.has(asObjectId(1))).toBe(false);
    expect(after.size).toBe(1);
  });

  /** `ObjectStore.empty` is shared, so anything derived from it must not write through. */
  it('leaves the shared empty store empty', () => {
    ObjectStore.empty.withObject(asObjectId(1), card(1));
    expect(ObjectStore.empty.size).toBe(0);
    expect([...ObjectStore.empty]).toEqual([]);
  });
});

describe('size', () => {
  it('counts a replacement once and an addition twice', () => {
    const store = storeOf(1).withObject(asObjectId(1), card(1, { name: 'again' }));
    expect(store.size).toBe(1);
    expect(store.withObject(asObjectId(2), card(2)).size).toBe(2);
  });

  it('is unchanged by removing something that was never there', () => {
    const store = storeOf(1, 2);
    expect(store.without(asObjectId(9))).toBe(store);
    expect(store.size).toBe(2);
  });

  it('counts an id used again after its object was removed', () => {
    const store = storeOf(1, 2).without(asObjectId(2)).withObject(asObjectId(2), card(2));
    expect(store.size).toBe(2);
  });
});

describe('building one from scratch', () => {
  it('holds exactly what it was given, counted once each, in id order', () => {
    const store = ObjectStore.from([
      [asObjectId(3), card(3)],
      [asObjectId(1), card(1)],
      [asObjectId(3), card(3, { name: 'again' })],
    ]);

    expect(store.size).toBe(2);
    expect([...store.keys()]).toEqual([asObjectId(1), asObjectId(3)]);
    expect(store.get(asObjectId(3))?.name).toBe('again');
    expect(store.has(asObjectId(2))).toBe(false);
  });
});
