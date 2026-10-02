# ADR 0019 — The viewer folds the log itself

- Status: accepted
- Date: 2026-10-02

## Context

docs/08 has the board renderer scrub backwards using "per-turn snapshots embedded in the log", and docs/07 has a live viewer ask the server to pace a run (`liveSpeed`, the run's `spectatorPacing`) so a person can follow a game, and be sent "the current full state snapshot" on joining mid-game. Building the viewer (roadmap 6.5) settled each of these differently.

## Decision

- **No snapshots in the log.** The log stays events plus the objects' identities. `Replay` in `@mtg/shared` folds events into a board and keeps a board at the start of every turn as it folds, so any position is at most one turn's folding away. A stored game and a live one are folded the same way, and so is the check that the log is right: `replay(log) == state` (docs/09) uses the same fold.
- **Identities are recorded by the emitter**, as an event first names an object, rather than read from the final state: an ability or a token that has ceased to exist by the end of a game cannot be read from it. A live game's batches carry the identities their events introduce.
- **No server-side pacing, and no state on joining.** The live viewer keeps every event of the games it is shown — the last eight and any it has pinned — and plays them back at its own speed; a viewer joining mid-game is sent the start and every event so far, which it folds.

## Consequences

- The log format did not change beyond the events the fold needed (docs/02 "As built (6.5)"), and stored logs from before 6.5 still play — with an object the old emitter never named shown as "object N".
- Scrubbing back costs at most a turn's events, which for these games is a few hundred `applyEvent`s: imperceptible. A much longer game would want snapshots more often than once a turn, which is a change to `Replay` alone.
- An unattended run is never slowed by a viewer, as docs/07 required of `spectatorPacing`, without the setting. What a viewer cannot do is watch "in real time" a game it was not shown: games nobody watches as they start are not streamed (6.2), and a page keeps only so many.
- docs/07 and docs/08 say so in their "As built (6.5)" notes.
