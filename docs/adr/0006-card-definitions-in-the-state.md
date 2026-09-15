# ADR 0006 — Card definitions live in the game state, and static abilities are derived from the battlefield

- Status: accepted
- Date: 2026-09-15

## Context

Roadmap 2.1 gives the engine cards. Two questions had to be answered before any of the
effect ops could be written, and neither is obvious.

**Where does a card definition live?** Resolution needs to know what a spell does;
`createObject` needs to know what a creature's printed power is; `legalActions` needs to
know whether something is a land. All of those are deep inside the engine, and threading a
lookup through every call site would put a parameter on half the functions in it.

**How does a static ability exist?** A static ability creates a continuous effect that
applies for as long as its source is on the battlefield (CR 604.1). The obvious
implementation is to register a `ContinuousEffect` when the permanent enters and remove it
when it leaves — which means every path that moves a permanent has to remember to do both,
and every path that does not is a leak or a ghost.

## Decision

1. **`GameState` carries the game's card definitions**, keyed by oracle id, as an
   immutable map that is never written after the game is created. Every object points at
   its definition through `definitionId` and carries only what makes it differ from the
   card: its counters, its damage, who controls it.

2. **`createObject` fills an object's printed characteristics from its definition** — name,
   power, toughness, loyalty, colours, legendary, keywords, and the triggered and loyalty
   abilities it carries. Anything the caller states still wins, which is what makes a token
   and a scenario-builder permanent work. A token never reads a definition at all.

3. **Static and replacement abilities are derived, not registered.** `activeEffects` is the
   effects the game has registered *plus* the ones the static abilities of permanents in
   play are making right now, computed from the battlefield each time it is asked.

   With one addition, made in 2.5 when a gate refused to enter tapped: a replacement that
   modifies how its *own source* enters has to be read off the card while it is still in
   hand or on the stack, because by the time it is a permanent the event it modifies is
   over (CR 614.12). Those are derived per entering object rather than folded into the
   battlefield walk — the alternative is scanning every card in both libraries on every
   event, and only the entering card's own self-replacements can possibly apply.

## Consequences

- Nothing to leak and nothing to unregister. A permanent that changes controller, is
  blinked, or is turned off by another effect behaves correctly with no special case,
  because there was never a stored fact to go stale.
- Derived effects take negative ids, so they can never collide with the ids the game hands
  out, and an id is stable for as long as its object is. That matters: the CR 614.5
  bookkeeping that stops one replacement effect applying twice to the same event
  identifies effects by id, so an id that moved would be a rules bug.
- A game state stays a pure function of its seed and its decisions. The definition map is
  shared by reference, so structural sharing is untouched and cloning for search is as
  cheap as it was.
- The loop-detection hash ignores definitions, which is correct: they are the same in
  every position of a game, so they cannot distinguish two of them.
- Deriving costs a walk of the battlefield per call rather than a lookup. The 1.14
  benchmarks are the guard here, and they are in CI.

## The limit this leaves, deliberately

An effect list runs to completion. If an op's events stop mid-flight because a player must
choose between two applicable replacement effects (CR 616.1), the ops after it cannot run,
because there is nowhere yet to put the rest of the list while the game waits. The engine
**throws** rather than dropping them silently.

That is the same missing machinery as the ops that need a choice of their own — search,
scry, "you may", modal spells, a chosen discard — all of which need the effect list to
pause and resume the way a replacement batch already does (ADR 0004). Building it once,
with those ops, beats building half of it now. Until then the boundary is loud, and the
bootstrap card set in 2.3 is chosen to stay inside it.
