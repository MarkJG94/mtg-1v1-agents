# ADR 0017 — A cycle whose change cannot be made is recorded, not fatal

- Status: accepted
- Date: 2026-09-26

## Context

docs/05 "Choosing the change": if the replacement search finds nothing the engine can
play — after dropping the mana-value band, and after a colour fix falls back to cutting the
spell — "the agent says so rather than making no change". Roadmap 5.4 built that as
`DeckAgentError`, thrown out of `chooseChange`.

At 5.7 the first runs on real Scryfall data were driven unattended, and one in ten threw
it: a flooded deck whose surplus land had no playable spell among the fifty cards
shortlisted for it, at today's 10.9% coverage. Thrown out of `driveRun`, the error ended
the run — the supervisor pauses a run whose job fails, so that a restart does not fail it
again — and an unattended run stopped for good over one cycle's change.

## Decision

**The agent still says so, and the run records it and plays on.** `driveRun` catches
`DeckAgentError` from the change step, and only that error: the cycle is finished with its
results and statistics as any other, **no new generation**, no trial statistics, and the
agent's message in the cycle record's new `unchanged` field (`null` when the deck did
change). The next cycle plays the same decks, with one more cycle of statistics behind
them, which is usually what changes the diagnosis.

## Consequences

- A cycle is no longer guaranteed to produce a generation. The lineage says what changed;
  `CycleRecord.unchanged` says why nothing did, and the UI shows it where it would show
  the change.
- Any other error from the change step — a bug — still fails the run, and the supervisor
  still pauses it and reports why.
- A run can go several cycles without changing if the pool really has nothing; that is
  visible, not silent, and the coverage page is what widens the pool.
