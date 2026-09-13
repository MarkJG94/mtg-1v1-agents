# ADR 0002 — The battlefield is a shared zone, and the stack is a zone

- Status: accepted
- Date: 2026-09-13

## Context

The state-model sketch in [02-rules-engine](../02-rules-engine.md) describes zones as
"library/hand/battlefield/graveyard/exile/stack/command **per player**", and lists both a
`zones` record and a separate `stack: StackItem[]`. Implementing the container in roadmap
1.1 forced both points to be settled precisely.

Per-player zones are right for libraries, hands and graveyards — each is owned, and cards
return to their owner's copy. They are wrong for the battlefield. In the Comprehensive
Rules there is one battlefield (CR 403.1); permanents sit on it with a *controller*, which
is a property of the object, not of the zone. If each player had their own battlefield,
then every control-changing effect (Mind Control, Act of Treason, CR 613.1b) would have to
move the object from one zone list to the other — and any zone change fires
"enters the battlefield" and "leaves the battlefield" triggers and, under CR 400.7, makes
it a new object. Stealing a creature would kill and recreate it. The same argument applies
to exile, the stack and the command zone, which are likewise single shared zones.

Keeping both a `stack` array and a `zones.stack` array raises a second problem: two
representations of one thing that can disagree.

## Decision

1. **Library, hand and graveyard are per player** (`"A:hand"`, `"B:graveyard"`).
   **The battlefield, stack, exile and command zone are shared** and unprefixed.
2. **Control lives on the object.** Changing control patches `object.controller` and moves
   nothing, so no zone-change trigger fires.
3. **The stack is the `stack` zone**, ordered bottom to top. There is no parallel array.
   Per-item data a spell needs on the stack — chosen targets, modes, the value of X —
   belongs to the `GameObject`, which is what the stack holds.
4. `GameState` carries a **`version`** counter, bumped by every update helper. It is the
   memoisation key for `characteristics()` (CR 613), so state must only ever be changed
   through `packages/engine/src/state/update.ts`.
5. `GameState` holds only what roadmap 1.1 can define honestly. `pendingDecision` (1.4),
   `combat` (1.6), `pendingTriggers` and `delayedTriggers` (1.8) and `effects` (1.9) are
   added by the phases that design them, rather than guessed at now.

## Consequences

- "Creatures you control" is a filter over the battlefield by `controller`, not a zone
  read. Every such query goes through a helper so the cost stays visible.
- `object.zone` and the zone arrays are two views of one fact, so they can drift.
  `moveObject` is the only way to change either, and `checkStateInvariants` asserts they
  agree — it is what the 1.13 fuzzer will call after every step.
- Zone ids are a string union (`ZoneId`), so an impossible zone such as `"A:battlefield"`
  is a compile error, and `allZoneIds` can enumerate them for state construction.
- Objects are stored in a `ReadonlyMap` copied on write: O(objects) per update, which is
  cheap at Magic's scale but is the first thing to revisit if the 1.14 benchmarks miss
  5 ms/game. Every read and write goes through `update.ts`, so the representation can
  change in one file.
