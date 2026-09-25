# ADR 0012 — The search determinises the state, with what is hidden replaced

- Status: accepted
- Date: 2026-09-25
- Amends: ADR 0009 (how a searching agent plays the game forward)

## Context

The `search` level (docs/04, roadmap 4.3) has to play the game forward: apply an action,
let the opponent respond, resolve the stack, and score what is left. That needs the rules
engine and a whole `GameState`. ADR 0009 took the state away from agents, and said the
search would "work from a determinisation built out of the view" — build a state from what
the player can see, sample what they cannot, and run the engine on that.

Building a state *from the view* turned out to lose far more than the hidden cards. The
view is what an evaluator needs, not what the rules need. It has no spell targets (the
`chosen` record on a stack object), no continuous effects ("until end of turn" pumps,
whose results show up in current power but whose durations do not), no timestamps, no
delayed or pending triggers, no replacement effects, and characteristics after layers
rather than the copiable values the layers start from. A state rebuilt from it would
resolve a spell on the stack with no target, and keep a pump spell's +3/+3 for ever.
Putting all of that into the view would make it a copy of the state's public half —
the same information, with a second reconstruction to get wrong.

## Decision

The engine builds the determinisation from the **true state**, replacing everything the
deciding player cannot see (`packages/engine/src/determinise.ts`):

- every card in a zone they cannot see is removed, and the zone refilled with the same
  number of cards, numbered afresh from above every id they can see;
- the opponent's hand is drawn, with replacement, from the cards the opponent has shown in
  public zones, or made of unknown cards if they have shown nothing;
- libraries, the player's own included (CR 401.2), are unknown cards: an oracle id with no
  definition, which the engine already treats as a card it cannot cast or play;
- definitions are cut down to the cards the player can see;
- the generator is replaced by the sampler's, and the loop detector's position hashes —
  taken of the whole truth — are dropped.

The agent never holds it. With each decision the driver hands the agent a `Simulator`
(`@mtg/engine/view` declares the interface; `simulatorFor(state, player)` implements it):
`sample(rng)` makes a world, and `decision`, `apply`, `view` and `status` run it. A `World`
is opaque — underneath it is a `GameState`, but it holds nothing `view` would not show.

**The guarantee is the view's, one level down: two states that differ only in what the
player cannot see give the same world from the same generator.** It is tested exactly the
way the view is, with a shared fixture (`withTheUnseenReplaced`) that swaps every hidden
card for a different one — new id, new name, new definition — and changes the generator
and the loop hashes too. A leak nobody thought to look for still fails it.

`PlayAgent.decide` gains the simulator as a fourth parameter. Agents that do not search
ignore it.

## Consequences

- The search runs the real rules on a faithful position: targets, effects, timestamps and
  triggers are all as they are in the game. Only what is hidden is guessed.
- The trust boundary moves. Before, the only function that decided what a player may know
  was `viewFor`; now `determinise` is a second one. Both are tested by the same
  hidden-invariance property, and the fixture that drives it was widened to vary the
  generator and the loop hashes when a sabotage check showed the determiniser's handling
  of them was caught only by its own narrower tests.
- An agent can still not import the engine (`import-boundary.test.ts` is unchanged): the
  simulator reaches it as an interface, implemented by the driver.
- The opponent's hand is guessed from what they have shown, which over-weights the cards
  they happened to play first and knows nothing of their deck. The `knowledge` record of
  docs/04 "Opponent modelling" (phase 5) is the better source, and slots into the same
  sampling step.
- The player's own library is unknown cards, although a real player knows their
  decklist. A draw inside the search's horizon is rare (the horizon is the end of the
  current step), so this costs little now; a decklist-aware sampler is the fix when it does.
