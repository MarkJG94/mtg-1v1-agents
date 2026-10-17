# ADR 0022 — A player sees the library cards they are asked about, and only while asked

- Status: accepted
- Date: 2026-10-17

## Context

docs/04 keeps every library out of every view, the viewer's own included: nobody knows a library's order (CR 401.2), and a view that showed one would let an agent play as if every draw were decided. 7.1 brings scry, surveil and "look at the top N cards of your library" (CR 701.22a, 701.25a), and with them a decision about cards that are still in the library — which to put on the bottom, which to take into the hand, what order the rest go back in. An agent asked that has to know what the cards are, and under docs/04's rule its view could not tell it.

Two ways to close it were on the table. Move the cards out of the library while they are looked at, into some zone the looker can see; or keep them where they are and let the view show them to the looker.

## Decision

The cards stay in the library, as the rules have them (CR 401.2: looking at a card does not move it), and `viewFor` adds them to the viewer's objects **while a decision about them is pending for that viewer**: the `looking` of a `chooseCardsFromLibrary`, the `cards` of an `orderCards`. Nobody else sees them, and once the answer is given they are hidden again.

## Consequences

- A look needs no zone of its own, nothing has to move back, and a replacement effect or trigger that cares about a card leaving the library sees nothing leave until a card really does.
- The rule stays in the one function that decides what a player knows (`view/project.ts`), keyed off the decision rather than off a flag someone has to remember to clear.
- **What the player saw is not remembered.** After a scry that leaves a card on top, the view no longer shows it, so an agent does not know what it will draw — nor does the search's determinisation, which fills every library with unknown cards (ADR 0012). The search never determinises while a look is waiting, since it plays only priority, attack and block decisions and leaves the rest to greedy, so no world ever holds a look at cards it has replaced. Remembering it is the `revealed` record docs/04 already names for revealed cards, and is left for when an agent would play differently for knowing.
- docs/04's "neither library is in the view" now names its exception, and docs/02 describes the two decisions.
