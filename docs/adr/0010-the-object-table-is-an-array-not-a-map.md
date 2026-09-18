# ADR 0010 — The object table is an array indexed by id, not a `Map`

- Status: accepted
- Date: 2026-09-18

## Context

Roadmap 4.2 connected `legalActions` to the priority decision, which is the point at which
a fuzz game stops being a turn loop with creatures already on the battlefield and becomes a
game: cards are drawn and played, spells are cast and resolve, triggers fire, and the board
grows. The benchmark's workload changed with it, and the number went from 2.5 ms a game to
46 ms. Five profiled fixes brought that to 9 ms, and there it stuck — against docs/02's
target of a median game inside **5 ms** of engine time.

At 9 ms the profile had no single villain left. State-based actions, priority grants,
leaving a step and casting were each about fifteen per cent, and nothing else was above
five. What it did have was a theme: **a fifth of the engine's time was inside `Map`**
builtins — `MapPrototypeSet`, `MapConstructor`, `FindOrderedHashMapEntry`,
`MapIteratorPrototypeNext` — and most of that was one field, `state.objects`.

`GameState` is immutable, so every change to any object rebuilds the object table, and
`new Map(old)` rehashes every entry to do it. Marking one point of damage on one creature
rehashed every object in the game. Measured on a board the size these games reach:

| | `Map` | array |
| --- | --- | --- |
| copy the table and write one entry | 5,443 ns | 75 ns |
| twenty reads | 139 ns | 32 ns |

`state/update.ts` had anticipated exactly this in its own header, and said what to do
about it: *"`objects` is a plain `ReadonlyMap` copied on write. That is O(objects) per
update, which is fine at Magic's scale… If that changes, every read and write goes through
this module, so the representation can change here alone."*

It had changed. Object ids are handed out in sequence from `nextObjectId`, so they are
small and dense — exactly what an array wants.

## Decision

1. **`state.objects` is an `ObjectStore`**: a class holding a `readonly (GameObject |
   undefined)[]` indexed by object id, plus the count of objects actually present. A read
   is a bounds-checked index; a write copies the array with `slice` and assigns one slot.

2. **It keeps `ReadonlyMap`'s shape.** `ObjectStore implements ReadonlyMap<ObjectId,
   GameObject>`: `get`, `has`, `size`, `keys`, `values`, `entries`, `forEach` and
   `[Symbol.iterator]`. Around ninety places read `state.objects` directly, and none of
   them had to change or had to know. Only `state/update.ts`, which does every write, and
   the two places that build a table from scratch.

3. **Iteration is in id order.** A `Map` walked in insertion order, and that was the same
   order: ids only ever increase. Removed objects and the unused slot zero are skipped, so
   nothing walking the table sees a gap.

4. **Writing goes through three operations** — `withObject`, `withObjects`, `without` —
   each returning a new store and none of them mutating. `ObjectStore.empty` is a shared
   instance, which is only safe because of that.

## Consequences

- The baseline benchmark went from **8.1 ms to 5.9 ms** a game on this change alone, with
  the rest of the phase's work taking it to **5.2 ms**. Long games went from 9.2 ms to
  5.4 ms and the wide-combat case from 4.9 ms to 3.1 ms, which is inside the budget. The
  baseline and long-game cases are not: see the roadmap note for 4.2, which says by how
  much and where the remaining time is.
- Time in `Map` builtins fell from about a fifth of the engine to about five per cent, and
  garbage collection fell with it — a `slice` of a hundred-element array allocates far less
  than a rebuilt hash table.
- The store is sized by the largest id, not by the number of objects. A game that made and
  destroyed ten thousand tokens would hold a ten-thousand-slot array with a few dozen
  objects in it. A `GameState` lives for one game and ids are one per object ever created,
  so the array is a few hundred slots in practice; if a card ever makes that false, the
  store is the one place that would compact.
- `state.objects` is no longer assignable from a `Map`, which the view's equivalence test
  found immediately: it built a rearranged board with `new Map(state.objects)`. It now
  builds one with `without` and `withObject`, which says what it means more plainly.
- `WeakMap` caches keyed on `state.objects` — derived characteristics, and the settled
  board in `sba.ts` — work unchanged: a store is an object like a map was, and a new one
  per write is exactly the invalidation those caches want.
- Anything that needs a genuine `Map` can still build one from the store, because it is
  iterable. `view/project.ts` does.

## Alternatives considered

- **Keep the `Map` and copy less often.** There is no way to copy a native `Map` cheaply,
  and the number of writes is not the problem: 187 object patches a game is not many. The
  cost was per copy, not per write.
- **A persistent map (HAMT or similar).** Sharing structure would beat `slice` on a much
  larger table, and lose to it on this one — a hundred elements is a memcpy. It would also
  be the engine's first non-trivial data structure, in a package that carries no runtime
  dependencies at all.
- **Change `GameState['objects']` to a plain array and update every reader.** Ninety call
  sites, all mechanical, and every one a chance to write `objects[id]` where `id` might be
  missing. The `ReadonlyMap` shape keeps `noUncheckedIndexedAccess`'s `| undefined` where
  it belongs and leaves the readers alone.
