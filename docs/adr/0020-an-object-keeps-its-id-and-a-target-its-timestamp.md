# ADR 0020 — An object keeps its id across zones; a target remembers its timestamp

- Status: accepted
- Date: 2026-10-02

## Context

CR 400.7: an object that moves from one zone to another becomes a new object with no memory of its previous existence. docs/06's `moveZone` event has a `becomes` field for the new object id that move would make. The engine, since phase 1, keeps an object's id wherever it goes, and nothing used `becomes`. The `replay(log) == state` check (docs/09, roadmap 6.5) found what that had let slip: a creature bounced and recast came back with its +1/+1 counters, and a spell whose target had been bounced still dealt its damage — to a card in a hand (CR 608.2b).

## Decision

Keep the id. Make the rest of CR 400.7 true instead:

- `moveObject` resets what an object knows of its last existence — tapped, counters, damage, deathtouch — whenever it changes zones, and gives it a new timestamp (CR 613.7d).
- A spell or ability on the stack records each object target's timestamp as it is chosen. A target whose timestamp has changed is no longer the object that was targeted: it is illegal on resolution (`stillTargeted` in `stack.ts`), the spell fizzles if every target is, and does nothing to that one if only some are.

`becomes` stays in the event type, unused.

## Consequences

- Statistics, the log and the viewer go on following a card across zones by one id, which is what "Goblin Guide dies" and docs/05's per-card statistics want.
- What CR 400.7 forgets is forgotten in one place, `moveObject`; a new piece of per-existence state (an Aura's attachment, a "chosen" value) must be reset there too, and the replay check is what would notice if it were not.
- Anything that asks "is this the same object" must compare timestamps, not ids.
