# ADR 0011 — Greedy prices what it cannot see, rather than simulating it

- Status: accepted
- Date: 2026-09-25

## Context

docs/04 describes the `greedy` level as "evaluator, no search", and says targets, modes
and X are chosen by "the same evaluator scor[ing] each option after simulating the
resolution". Both sentences were written when the agent was handed the `GameState`.
ADR 0009 took the state away: `packages/agents` sees a `PlayerView` and may not import
the engine's `step`. So "score the position after the action" has no simulator to call.

The view does show part of what an action changes — a land moves to the battlefield, a
creature spell becomes a summoning-sick creature, mana gets tapped — but not what an
instant, sorcery or loyalty ability *does*. Scored on what is visible alone, a burn spell
aimed at the opponent's best creature and the same spell aimed at the agent's own score
identically: the card leaves the hand, the mana is tapped, and that is all the evaluator
can see. Greedy would then cast removal on its own board as readily as on the opponent's.

The determinised search (the second half of roadmap 4.3) closes this properly: it builds
a state from the view, samples what it cannot see, and runs the real engine on it. Until
then greedy must still play whole games — it is the middle rung of the sanity ladder
(docs/09) and the baseline search has to beat.

## Decision

Greedy scores each legal priority action as

    evaluate(afterAction(view, action)) − evaluate(view) + prior(view, action)

and takes the highest, passing unless something scores above zero.

- **`afterAction`** projects only what the view can show: the land played, the card
  leaving the hand, the permanent arriving (summoning sick), the mana tapped (lands first,
  as the auto-tapper does), a planeswalker's loyalty moving by its cost. An instant or
  sorcery goes to the graveyard having done nothing.
- **`prior`** credits the part `afterAction` cannot see, with explicit weights in the
  weights file: a spell aimed at an opposing creature is worth a fraction of that
  creature's value; one aimed at the opponent is worth a multiple of its mana value; one
  aimed at the agent's own creature is worth a small fraction (a pump spell is plausible,
  removal on oneself is not, and the evaluator cannot tell which); an untargeted spell and
  a loyalty activation get a flat credit.

The guess is therefore written down, tunable by the weight-tuning harness, and confined
to one function the search will replace — rather than hidden in the evaluator's terms or
smuggled in by reading card names, which the working agreement forbids.

Combat and mulligan decisions use docs/04's rules of thumb directly, from the view. They
need no simulator either way, and 4.4's combat solver replaces the combat half.

## Consequences

- Greedy plays badly in exactly the places the prior is wrong: a pump spell and a
  removal spell aimed at the same creature are priced the same. The sanity ladder only
  asks it to beat `random`, and it does so by a wide margin (171 wins, 12 losses and 17
  draws over 200 games on fuzz boards).
- The evaluator itself stays honest: it scores positions, never actions, so the search
  can use it as a leaf unchanged.
- docs/04 now says that greedy's "score after resolution" is a projection plus a prior,
  and names the search as what replaces it.
- Blocking legality (flying, reach, protection, "can't be blocked") cannot be recomputed
  from the view either, so the `declareBlockers` decision now carries `canBlock` — which
  attackers each blocker may legally block — as docs/02 already required of every
  decision ("the full list of legal options"). That is a correction to the engine, not a
  departure, and needs no ADR of its own.
