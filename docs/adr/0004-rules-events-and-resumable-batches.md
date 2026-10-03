# ADR 0004 — Every state change is a proposed event, and a batch can pause mid-flight

- Status: accepted
- Date: 2026-09-15

## Context

docs/02 describes replacement effects as one line of pipeline: events are built as data
and "pass through `applyReplacements(state, event)` before execution". Implementing
roadmap 1.10 showed that line hides two problems.

The first is that the engine did not build events at all. `dealCombatDamage` marked damage
directly, `drawCard` moved the top card of a library directly, the state-based actions put
dying creatures in graveyards directly. There was nothing for `applyReplacements` to sit
in front of.

The second is that `applyReplacements` cannot be a plain function. When two replacement
effects apply to the same event the affected player chooses which applies first
(CR 616.1), and the choice matters: prevent 2 then double gives 2 damage, double then
prevent 2 gives 4. In an engine whose whole contract is `step(state, decision)` — no
blocking, no callbacks, a game a pure function of its seed and decisions — that choice has
to become a `pendingDecision`, which means the work in progress must survive being put
down and picked back up.

The obvious escape routes are both bad. A `choose` callback passed into
`applyReplacements` puts a function where a decision belongs and makes a replay depend on
the caller. Deciding the order by a fixed rule instead of asking is simply the wrong
answer to a question the rules put to a player.

## Decision

1. **A `RulesEvent` is what the game is about to do.** Damage, a draw, a zone change, a
   permanent entering, life, counters. Nothing marks damage or moves a card any more;
   it builds one of these and hands it to `runBatch`. These are distinct from the
   `GameEvent`s in `@mtg/shared`, which are the log — a record written afterwards, of
   what a replacement effect may well have changed.

2. **`runBatch` takes a list of events, not one.** Damage within a batch is dealt
   simultaneously (CR 510.2), so the batch, not the event, is the unit that makes
   creatures trade.

3. **A batch can stop part-way.** When a choice is needed the remaining work is written to
   `state.pendingReplacement` — the events already finished with, the ones still queued,
   the effect ids already applied to the current one (CR 614.5) — alongside a
   `chooseReplacement` decision. `resumeBatch` continues from it.

4. **What to do when the batch finishes is a closed union, not a closure.** `EventBatch` is
   `{ kind: 'plain' }` or `{ kind: 'combatDamage', firstStrike }`. A paused batch is
   therefore plain data that serialises, replays and clones like the rest of the state.

5. **Prevention effects are replacement effects** (CR 615.1), not a system of their own: a
   shield replaces some or all of a damage event with nothing, and shrinks by what it
   absorbed (CR 615.7).

## Consequences

- Combat damage, drawing, discarding, dying, the legend rule, spell resolution, fizzling
  and countering all go through the pipeline, so a replacement effect written for any of
  them works without touching the subsystem that raised the event.
- Any of those calls can now return a state with a pending decision. `applyPriority` sets
  priority to the active player *before* resolving the stack, so a resolution paused by a
  replacement choice resumes with priority in the right place (CR 117.3b), and it does not
  hand out priority when the resolution has instead paused.
- Cleanup was reordered: damage removal and effect expiry happen before the discard is
  asked for. CR 514.2 makes them simultaneous, so this is free, and it means nothing is
  left to do after a discard batch that a replacement might pause.
- Lifelink's life gain goes back through the pipeline as a second batch, so "if you would
  gain life, gain twice that much" sees it. That is one extra round trip per combat damage
  step with a lifelinker, and it is what the rules say.
- `performEvents` is now the one place that knows how each kind of event is applied, which
  is where the ~120 effect ops of docs/03 will hang in roadmap 2.1.
- A replacement that produces an event the state-based actions will propose again — "if it
  would die, put it onto the battlefield instead" — loops. The SBA pass limit catches it
  and throws rather than hanging; a rules-accurate fix needs the CR 614.5 bookkeeping to
  span passes, which no real card has yet asked for.
