# ADR 0021 — Resolution is a resumable program kept in the state

- Status: accepted
- Date: 2026-10-04

## Context

An ability's effects ran as one call, `applyEffects`, start to finish. That left nowhere to keep the rest of them while a player answered something, and the engine said so in three places:

- Every op that needs a choice mid-resolution was missing from the vocabulary — "you may" (CR 608.2d), a discard the player chooses (CR 701.9b), search, scry, modes. The 7.1 coverage work measured what that costs: of the 205 cards a combat-damage trigger was the last unread template for, 183 stopped in its body, nearly all of them on one of these.
- A replacement effect needing a choice (CR 616.1) part-way through an ability threw `EffectsPausedError`, because the ops after it had nowhere to wait.
- Once the effects had run, `resolveTopOfStack` asked again whether the spell had fizzled. By then a removal spell's own target was in the graveyard, so every removal spell was logged as fizzling and never as resolving.

## Decision

`GameState.resolution` holds the spell or ability resolving as a program: a stack of frames — an effect list, how far through it, and the context it runs in — plus a `may` waiting on its answer. It is plain data, like `pendingReplacement`, so a paused game is cloned, hashed for loop detection, replayed and searched like any other.

- `resolveTop` decides fizzling first (CR 608.2b) and then starts the program (`beginResolution`). `runResolution` runs it until it ends or something has a question; when it ends, the object leaves the stack through `finishResolving`, which does not ask about fizzling again.
- `sequence`, `forEach`, `if` and `may` push frames instead of recursing. Every other op runs exactly as before (`applyOp`).
- Two ops that ask: `may` (a `yesNo` decision, a kind `@mtg/shared` already named) and `discard` (the existing `discard` decision, asked of the player discarding, one player at a time). A replacement choice pauses the program the same way.
- `applyDecision` hands a `yesNo`, a discard made during a resolution, and a resumed replacement batch back to `runResolution`.
- The grammar reads "you may …" into `may`, folds "If you do, …" into the same `may`, and reads a discard that is not "at random" as `discard`.

## Consequences

- A paused ability now finishes; `EffectsPausedError` is gone.
- The log says a removal spell resolved.
- Every agent must answer `yesNo`: random picks, greedy answers yes (nearly every "may" helps the player asked, and it has nothing to weigh the two by), and the searching agent defers to greedy as it does for every decision but priority.
- "If you do" is folded into the `may` it follows rather than tracking whether the optional part happened. The two differ only when the optional part turns out impossible — "you may sacrifice it" when it has already gone — where the card would still do the second half. Tracking that is a `did` flag on the frame when a card is found that needs it.
- A spell that leaves the stack during its own resolution still fails loudly (`finishResolving` throws), which is what the executability smoke test relies on to catch a script that counters itself.
- The search, scry and modal ops, and a sacrifice of the player's choice, are now each a new op and decision kind on this machinery rather than a change to it.
