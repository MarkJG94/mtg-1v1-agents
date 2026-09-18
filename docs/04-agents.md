# 04 — Agents

There are two agent roles in the system and they are deliberately separate modules:

- the **play agent** answers every engine decision during a game;
- the **deck agent** (see 05) chooses sideboarding plans and the once-per-cycle deck change.

Both agents are pure functions with an injected seeded RNG, so games are reproducible.

## Play agent

Interface:

```ts
interface PlayAgent {
  readonly level: AgentLevel;
  decide(view: PlayerView, decision: Decision, rng: Rng): DecisionResponse;
}
```

**There is no `GameState` parameter**, and that is the whole of the information hiding (**ADR 0009**). This interface was first written as `decide(state, decision, view, rng)`, which hands the agent the very thing the view exists to withhold; the state is gone, and the agents package cannot import the module it is declared in.

`PlayerView` is what one player knows, built by `viewFor(state, player)` — the only place in the system that decides that, so the rule lives once with tests rather than in every agent that happens to remember it. The agent sees its own hand, both battlefields, both graveyards, exile, the stack, life and poison totals, mana pools, and the size of everything it cannot see.

Three things make the hiding real rather than a convention:

- **It is in the types.** The opponent's side has no `hand` field to read, rather than one that happens to be empty. There is nothing to reach for, and the compiler says so.
- **A view is plain data** with no back-reference to the state it came from, so it cannot be unwrapped.
- **`@mtg/engine/view`** is a separate entry point carrying the view, the decision vocabulary and the RNG interface, and nothing whose runtime import graph reaches `state/game-state.ts`. `packages/agents` imports that and never `@mtg/engine`; `import-boundary.test.ts` checks both halves, and the second is what stops the first from being a naming convention.

**Neither library is in the view, including the viewer's own.** Nobody knows a library's order (CR 401.2), and knowing the contents is most of knowing the order — a view that showed A their own library would let an agent play as though every draw were already decided. Both come through as a count.

Objects are reported as `characteristics()` sees them rather than as they were printed, because an evaluator that judged a board from printed power would misread every anthem in Magic.

**Revealed cards are not in the view yet**, and docs/04 previously listed them. The engine does not track them: nothing writes down that a card was revealed by a `reveal` op or looked at by a scry, so there is nothing to project. Closing it means a `revealed` record on `GameState` written by those ops; it is named here rather than faked, because a view that quietly showed nothing would look exactly like one that was hiding correctly.

### Architecture: evaluator + bounded search

1. **Static evaluator** `evaluate(view) → number` (positive is good for the agent). Terms with tunable weights:
   - life differential with a non-linear penalty near zero and against the opponent's visible burn/reach;
   - board: sum over creatures of (power, toughness, keywords, evasion) discounted by summoning sickness, plus planeswalker loyalty;
   - card advantage: hand size, cards in library relative to turn number;
   - mana development: lands on battlefield vs turn, colours available vs colours needed in hand;
   - tempo: untapped mana held with instants in hand (values holding up a counterspell);
   - threats: opponent's on-board lethal potential in one and two turns (a small combat projection).
   Weights start hand-tuned; the sim exposes an offline **weight-tuning harness** (play evaluator A vs B for 1,000 games) so weights can be improved by hill-climbing without changing code paths.

2. **Search** for `priority` decisions: enumerate legal actions, for each simulate (engine `step` on a state **built from the view** — the agent has no other, per ADR 0009 — with the opponent modelled as passing and with hidden information sampled — the opponent's hand is drawn at random from the cards not visible, i.e. a determinisation) to the end of the current phase or to the next decision, then evaluate. Depth-2 by default (my action → opponent's best cheap response), widened with a small beam for main-phase sequencing (play land → cast → cast). Time/step budget per decision is a setting; default aims for ≤ 20 ms.

3. **Combat** uses a dedicated attack/block solver rather than generic search: enumerate attack subsets (pruned to those that survive or trade profitably or present lethal), let the opponent model pick the best blocks with the same solver, evaluate the resulting board. Block declaration mirrors this from the defender's side, considering chump blocks only when facing lethal.

4. **Targets, modes, X**: the same evaluator scores each option after simulating the resolution.

5. **Mulligans**: keep if the hand has 2–5 lands (scaled by hand size), can cast at least one spell by turn 2 in its colours, and the evaluator's projected turn-3 board is above a threshold; otherwise mulligan down to a floor of 5 cards. The London bottoming choice keeps the best-curved subset.

6. **Play-first choice** after winning the die roll: play, unless the deck's stats say draw wins more against this opponent (tracked per cycle).

### Determinism and speed

- All randomness goes through the injected RNG; determinisations are seeded from it.
- Cloning state for search uses the engine's structural-sharing helper; benchmarks track "decisions per second".
- The agent has a `level` setting: `random` (fuzzing), `greedy` (evaluator, no search), `search` (default), `deep` (wider beam and depth 3, for tie-break batches or verification).

### Why not an LLM here

Thousands of games per cycle at tens of decisions per game rules out an LLM in the play loop on cost and latency. The `PlayAgent` interface would allow one later (for example a "coach" that adjusts evaluator weights per matchup).

## Sideboarding agent

Between games 2 and 3 of a match, each agent may swap cards between main and side (equal numbers in and out, 60/15 preserved, ban list respected). The agent uses the card statistics accumulated *against this opponent's current deck* during the cycle (see 05 for the statistics). Rules:

- Score each main-deck card by its matchup-specific contribution; score each sideboard card by the same statistic if it has been played in this matchup, otherwise by a prior derived from its tags (`vs: creatures | counterspells | artifacts | graveyard | burn ...`, inferred from the script: e.g. a `destroy` op with a `creature` filter tags `vs: creatures`) matched against the opponent's observed deck composition.
- Swap up to `maxSideboardSwaps` (default 4) pairs where the sideboard card's score exceeds the main card's by a margin, keeping land count and colour requirements satisfied.
- Sideboarding decisions are recorded as events so the UI can show the plan.

Early in a run there are no matchup statistics; the tag prior carries the decision. This is intentionally simple; a trial-batch version (play both plans) is a later improvement.

## Opponent modelling

Both agents are instances of the same code with different decks and different accumulated statistics; there is no asymmetry. Each maintains, per run and per cycle, a `knowledge` record of the opponent's observed decklist (every card revealed by casting or otherwise), which the sideboarding agent and the deck agent use.
