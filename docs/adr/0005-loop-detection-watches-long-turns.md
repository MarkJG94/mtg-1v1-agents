# ADR 0005 — Loop detection hashes complete positions, and only on turns long enough to be loops

- Status: accepted
- Date: 2026-09-15

## Context

Roadmap 1.14 asked for benchmarks and a target: a median game inside 5 ms of engine time
with a trivial AI (docs/02 "Performance targets"). The first run came in at **23 ms**, and
nine tenths of that was one function — `hashState`, the CR 726 loop detector's projection
of a position, computed at every decision point over every object in every zone.

Looking at why turned up something worse than a performance problem. The benchmark's wider
boards were ending as **loop draws at a rate of 36%**, in games where no loop existed and
a player was several turns from winning on damage. The projection left out `state.combat`.
Ordering the blockers on one attacker changes nothing else about a position — the same
step, the same priority, the same pass count, the same life totals, the same objects in
the same zones — so the engine saw a position it had already been in, and ended a live
game in a draw. Silently, because a draw is a legitimate result.

That is exactly the failure `loop.ts` warns about in its own header: "A draw declared by
mistake is a silently wrong result, not a crash". The projection has to cover everything
that makes two positions different, and this one did not.

The performance side had three causes, in order of size: every number was hashed by
turning it into a string and walking its digits; the mixers were closures rebuilt on each
call; and the whole walk ran at every one of a game's ~500 decision points, on turns that
could not possibly be loops.

## Decision

1. **Hash the combat state, the replacement batch in progress, and the triggers that have
   already fired this turn.** Blockers are mixed in order, because the order *is* the
   decision (CR 509.2). This is the correctness half, and it is not optional.

2. **Watch a turn only once it has run longer than any ordinary turn.**
   `config.loopCheckAfter` (default 200 decisions into a turn) gates the hashing.
   A loop never stops being a loop: if a position repeats forever, it still repeats after
   the two-hundredth decision of the turn, so a detector that starts late catches it just
   the same. It is only the turns that were never loops that stop paying. Measured
   ordinary turns in the benchmark run to 22 decisions at the 99th percentile, so the
   default has an order of magnitude in hand, and games with real cards — which will have
   longer turns — can raise it per game.

3. **Make the hash itself cheap**: mix integers as integers rather than as their decimal
   digits, pack each object's flags into one integer, and hoist the mixers out of
   `hashState` so they are plain functions rather than closures allocated per call. A
   Murmur3 finaliser on each of the two passes keeps the avalanche the old per-character
   mixing gave.

## Consequences

- The baseline benchmark went from 23 ms to **2.24 ms** a game, inside the 5 ms target
  with room to spare. Loop detection now costs about 0.1 ms a game rather than 20.
- A mandatory loop is still a draw, and still on the turn it happens. It is declared a few
  hundred decisions later than before, which changes nothing a player or a run sees.
- A cheaper way to be wrong is gone: before this, a game could be drawn because two
  positions the projection could not tell apart really were different. After it, the
  remaining risk is a hash collision, which the 53 bits are sized for.
- `GameState` gains `decisionsThisTurn`, reset as each turn begins. It is not part of the
  hash — it changes at every decision, so hashing it would mean no position ever repeated.
- Tests pin both halves: a position that differs only in damage-assignment order must hash
  differently, and a set of games must end the same way whether every position is watched
  or only long turns are. The second is the one that would have caught the original bug.
- The deferral is a trade the module already made in the other direction: "a loop the
  projection cannot see just runs until the decision cap, which ends the same game as the
  same kind of draw". This is the same trade, bounded by a turn's length instead.
