import { asObjectId, type ObjectId } from '@mtg/shared';
import type { GameObject } from './object.js';

/**
 * The object table: every object in the game, by id.
 *
 * A `ReadonlyMap` in shape, an array underneath. Object ids are handed out in order from
 * `nextObjectId`, so they are small and dense, and an array indexed by id answers `get`
 * with a bounds check instead of a hash lookup.
 *
 * What made the representation worth changing is not reading, though, but writing. The
 * engine is immutable: every change to any object rebuilds this table, and `new Map(old)`
 * rehashes every entry to do it. Marking one point of damage on one creature rehashed a
 * hundred and twenty objects. `slice` copies the same hundred and twenty as a block of
 * words, and measured seventy times faster on a board this size — around an eighth of a
 * whole game's time, which is what `state/update.ts` anticipated when it said the
 * representation could change here alone.
 *
 * It keeps `ReadonlyMap`'s shape because the rest of the engine reads the table through
 * `state.objects.get`, iterates it and asks its size, and none of that should have to
 * know. Iteration is in id order, which is the order a `Map` gave as well: ids only ever
 * increase, so insertion order and id order were always the same one.
 *
 * Every operation returns a new store and none of them mutates, which is the same
 * contract `GameState` itself keeps.
 */
export class ObjectStore implements ReadonlyMap<ObjectId, GameObject> {
  /**
   * Indexed by object id. Holds `undefined` where an object has been removed, and where
   * an id was never used — index 0, because ids start at 1.
   */
  private readonly slots: readonly (GameObject | undefined)[];

  readonly size: number;

  private constructor(slots: readonly (GameObject | undefined)[], size: number) {
    this.slots = slots;
    this.size = size;
  }

  static readonly empty = new ObjectStore([], 0);

  /**
   * A store holding exactly these objects, built with one allocation. For making a table
   * from scratch — determinisation (ADR 0012) keeps a subset of a game's objects — rather
   * than adding to one.
   */
  static from(objects: Iterable<readonly [ObjectId, GameObject]>): ObjectStore {
    const slots: (GameObject | undefined)[] = [];
    let size = 0;
    for (const [id, object] of objects) {
      if (slots[id] === undefined) size += 1;
      slots[id] = object;
    }
    return new ObjectStore(slots, size);
  }

  get(id: ObjectId): GameObject | undefined {
    return this.slots[id];
  }

  has(id: ObjectId): boolean {
    return this.slots[id] !== undefined;
  }

  /** Add or replace one object. */
  withObject(id: ObjectId, object: GameObject): ObjectStore {
    const slots = this.slots.slice();
    const existing = slots[id];
    slots[id] = object;
    return new ObjectStore(slots, existing === undefined ? this.size + 1 : this.size);
  }

  /**
   * Replace several objects at once, with a single copy of the table. Every id must
   * already be present — this is for patching, not for creating.
   */
  withObjects(objects: Iterable<readonly [ObjectId, GameObject]>): ObjectStore {
    const slots = this.slots.slice();
    for (const [id, object] of objects) slots[id] = object;
    return new ObjectStore(slots, this.size);
  }

  /** Remove one object, for something that has ceased to exist. */
  without(id: ObjectId): ObjectStore {
    if (this.slots[id] === undefined) return this;
    const slots = this.slots.slice();
    slots[id] = undefined;
    return new ObjectStore(slots, this.size - 1);
  }

  *entries(): IterableIterator<[ObjectId, GameObject]> {
    for (let id = 0; id < this.slots.length; id += 1) {
      const object = this.slots[id];
      if (object !== undefined) yield [asObjectId(id), object];
    }
  }

  *keys(): IterableIterator<ObjectId> {
    for (const [id] of this.entries()) yield id;
  }

  *values(): IterableIterator<GameObject> {
    for (const [, object] of this.entries()) yield object;
  }

  [Symbol.iterator](): IterableIterator<[ObjectId, GameObject]> {
    return this.entries();
  }

  forEach(
    callback: (object: GameObject, id: ObjectId, table: ReadonlyMap<ObjectId, GameObject>) => void,
    thisArg?: unknown,
  ): void {
    for (const [id, object] of this.entries()) callback.call(thisArg, object, id, this);
  }
}
