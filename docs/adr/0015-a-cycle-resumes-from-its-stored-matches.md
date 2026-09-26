# ADR 0015 — A cycle resumes from its stored matches; trials are replayed, not stored

- Status: accepted
- Date: 2026-09-26

## Context

docs/06's resume protocol makes `cycles.matches_done` the checkpoint: on restart, count the
completed matches and "resume from the next match number", since match seeds make a
replayed match identical. It also says trial batches and legalisations "are checkpointed
the same way (`matches.kind`)".

A count is not enough to carry on from. What the rest of a cycle does depends on what the
matches before it did, not just on how many there were:

- each deck's **play/draw record** is updated game by game, and the play agents are made
  knowing it, so match 5 plays differently depending on who won the play/draw choices in
  matches 1–4;
- **sideboarding** for game 3 reads each card's matchup record from this cycle's games so
  far;
- the **statistics** the loser's change is chosen from are the cycle's games, all of them;
- a **legalisation** after a ban can change a deck in the middle of the cycle, and later
  matches play the legalised deck.

A resumed cycle that only knew "four matches are done" would play match 5 against
different records than the cycle that never stopped, and would choose its change from a
fifth of the statistics. It would be a different run.

Trials are the other half of the question. A trial batch is a short cycle played for each
finalist of the loser's change; it happens after the cycle's last match and before the
change is written, and its seeds come from the cycle's.

## Decision

**A cycle resumes from its stored matches.** Every match is written, in one transaction,
with its whole result (`matches.detail`: games, seeds, decisions, sideboarding, what each
deck showed, legalisations), its games' event logs, any deck generations a ban forced
during it, and the ban trail as it then stood. `runCycle` takes those matches and logs as
`completed`: it replays their play/draw record, feeds their logs through the statistics
aggregator, starts from the decks the lineage holds, and plays on from the next match. The
resumed cycle reaches exactly the state of the one that never stopped — the tests compare
the two, on the in-memory store and on a SQLite file closed and reopened between the crash
and the resume. `matches_done` is still kept, for the UI's progress bar, but nothing
resumes from it.

**Trials are replayed, not stored.** If the process dies after the last match and before
the change is written, the resume makes the change again: the same statistics, the same
RNG stream (`${cycleSeed}:change`), the same trial seeds, hence the same trials and the
same change. What each trial recorded is kept with the finished cycle (`summary.trials`),
which is what docs/05 asks of them. Legalisations are checkpointed, but as what they are —
deck generations with `cause: 'ban'`, written with the match they happened after — not as
matches.

## Consequences

- A crash costs at most the match in progress, as docs/01 promised, plus the trials if it
  lands in the few seconds of choosing a change.
- **The current cycle's event logs cannot be dropped** by docs/06's retention setting: they
  are what its statistics are rebuilt from. Retention applies to finished cycles only,
  whose statistics are already in `card_stats` and the cycle's summary.
- `matches.detail` roughly doubles what a match costs on disk beside its logs (a few KB
  compressed); it is what an export carries when logs are left out, so a run imported
  without logs can still be resumed mid-cycle — just not with that cycle's statistics.
  An imported run is paused, and one with a cycle in progress and no logs is the one
  case that resumes to a different end.
- `matches.kind = 'trial'` stays in the schema for 5.7, whose workers may want to report
  trial matches as they finish; nothing writes it yet.
