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
  decide(view: PlayerView, decision: Decision, rng: Rng, simulator: Simulator): DecisionResponse;
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

   **As built (4.3).** `evaluate(view, weights)` in `packages/agents/src/evaluate.ts`, with the weights in `weights/default.json` (checked at compile time against the `Weights` type, and at run time by `parseWeights` for any file the tuning harness loads). `evaluateTerms` returns each term separately. Most terms are symmetric — a side is scored the same way for either player and the total is the viewer's score minus the opponent's — and where docs/04 asked for something the view cannot show, the term is left out rather than guessed:
   - the opponent's *visible burn* needs their hand, so it is not scored; the life term is linear with an extra slope below a danger threshold;
   - cards in library is an empty-library penalty only (the next draw loses, CR 704.5b), not a count against the turn number;
   - lands are scored up to a target count and very little beyond it, rather than against the turn;
   - colours needed but not made are charged to the viewer only, since only the viewer's hand can be read;
   - threats look one attack ahead and count the blockers that will be there for it — each stops the biggest attacker it can reach, and which creatures take part follows from whose turn it is, since tapped creatures stay tapped until their controller's next untap step (CR 502.3). This is what makes an attack that leaves nothing home pay for it (4.4).

2. **Search** for `priority` decisions: enumerate legal actions, for each simulate (engine `step` on a **determinisation** — the game as the agent knows it, with hidden information sampled: the opponent's hand drawn from cards they have shown, both libraries unknown; built by the engine from the state with everything hidden replaced, and handed to the agent as a `Simulator`, per **ADR 0012**) to the end of the current step, then evaluate. Depth-2 by default (my action → opponent's best cheap response), widened with a small beam for main-phase sequencing (play land → cast → cast). Time/step budget per decision is a setting; default aims for ≤ 20 ms.

3. **Combat** uses a dedicated attack/block solver rather than generic search: enumerate attack subsets (pruned to those that survive or trade profitably or present lethal), let the opponent model pick the best blocks with the same solver, evaluate the resulting board. Block declaration mirrors this from the defender's side, considering chump blocks only when facing lethal.

4. **Targets, modes, X**: the same evaluator scores each option after simulating the resolution.

5. **Mulligans**: keep if the hand has 2–5 lands (scaled by hand size), can cast at least one spell by turn 2 in its colours, and the evaluator's projected turn-3 board is above a threshold; otherwise mulligan down to a floor of 5 cards. The London bottoming choice keeps the best-curved subset.

6. **Play-first choice** after winning the die roll: play, unless the deck's stats say draw wins more against this opponent (tracked per cycle).

### Determinism and speed

- All randomness goes through the injected RNG; determinisations are seeded from it.
- Cloning state for search uses the engine's structural-sharing helper; benchmarks track "decisions per second".
- The agent has a `level` setting: `random` (fuzzing), `greedy` (evaluator, no search), `search` (default), `deep` (wider beam and depth 3, for tie-break batches or verification).

### The `random` and `greedy` levels, as built (4.3)

**`random`** (`packages/agents/src/random.ts`) is a *player*, not the engine's fuzzer: it gets a view and a decision like every agent and picks uniformly from what the decision offers. The engine's own random agent in `@mtg/engine/testing` reads the whole state, because hunting rules bugs is its job.

**`greedy`** (`packages/agents/src/greedy.ts`) is "evaluator, no search" — but with no simulator either, since ADR 0009 keeps `step` out of the agents package. At a priority decision it scores each legal action as `evaluate(afterAction(view, action)) − evaluate(view) + prior(view, action)` and takes the best, passing unless something scores above zero. `afterAction` moves only what the view can show (a land played, a permanent arriving summoning sick, mana tapped); `prior` credits what it cannot (a spell aimed at an opposing creature, at the opponent, at the agent's own creature), with its own tunable weights. **ADR 0011** records why, and the determinised search replaces both. Every other decision uses the rules of thumb above from the view alone: mulligan by land count and an early play in the lands' colours (the projected turn-3 board is the search's), attack with what no untapped blocker can kill for less value, block to kill for free, then to trade down, and chump only when what gets through would be lethal. It never draws from the generator, so the same position always gets the same answer.

Neither agent recomputes blocking legality: the `declareBlockers` decision carries `canBlock`, which attackers each available blocker may legally block (docs/02). The one rule about a declaration as a whole — an attacker with menace needs two blockers, CR 702.110b — is applied from the view by `withoutLoneMenaceBlocks`.

`@mtg/sim`'s `playGame(board, agents, seed)` is where agents meet real games: the only place a view is made, with each seat drawing from its own generator forked from the seed by seat.

### The `search` and `deep` levels, as built (4.3)

**The simulator** (ADR 0012). With every decision the driver passes a `Simulator` alongside the view. `sample(rng)` returns a *world*: the real game with every card the player cannot see replaced — the opponent's hand drawn, with replacement, from cards the opponent has shown in public zones (unknown cards if none), both libraries unknown cards, definitions cut down to what the player can see, a fresh generator, and the loop detector's hashes dropped. `apply`, `decision`, `view` and `status` run a world by the real rules. A world depends only on what the player can see — `determinise.test.ts` swaps every hidden card, the generator and the loop hashes and requires an identical world, the same test the view is held to. `World` is opaque to the agent, and the agents package still imports nothing but `@mtg/engine/view`.

**The search** (`packages/agents/src/search.ts`) runs on priority decisions that offer more than passing, and on attacks and blocks with the combat solver (below); mulligans, discards and orderings are greedy's.

- It samples `samples` worlds and scores a candidate by its mean over them.
- A line is played to the **horizon**: the stack empty and the game in a different step from the one the decision was made in, so a spell resolves, its triggers fire and state-based actions kill what they kill before anything is scored.
- **Depth-2 with a beam.** Every option gets a one-step look (act, then everyone passes to the horizon); the best `beam`, and passing, are searched further. Along a line the searcher may take `followUps` more actions of its own when it gets priority again — "play a land, then cast what it enables" — but never responds to its own spell. Where the opponent could act, `replies` of their decisions are searched: passing and their `responses` most damaging options, and the worst for the searcher is assumed.
- **The budget is in engine steps, not time**, so a game stays a pure function of its seed. Candidates are only compared at a depth all of them reached — the one-step look in every world, then the full search if the budget covered every candidate — because comparing a finished candidate with one the budget cut short favours whichever was searched first, which is passing. Ties at depth are broken by the one-step look.
- An optional observer receives a `SearchReport` (each candidate's one-step and full scores, and the steps spent), for tests and for a UI that wants to say why.

| level | samples | beam | follow-ups | replies | responses | budget (steps) | combat candidates |
|---|---:|---:|---:|---:|---:|---:|---:|
| `search` | 2 | 3 | 2 | 1 | 2 | 600 | 3 |
| `deep` | 4 | 5 | 3 | 2 | 3 | 4,000 | 5 |

Measured over the 500-game ladder, a searched priority decision at the `search` level costs 3.5 ms on average and 15.2 ms at the 99th percentile, inside the 20 ms aim above; an attack decision 1.8 ms and a block decision 0.7 ms; a game against greedy about 110 ms. `deep` costs about 11 ms a priority decision on average. Search beats greedy 290–137 with 73 draws over 500 games (p = 5.2 × 10⁻¹⁴).

### The combat solver, as built (4.4)

Item 3 above, in `packages/agents/src/combat/`. It works from the view alone, so it needs no simulator, and the search checks its best answers against one.

- **The model** (`model.ts`) works out a combat's result the way the engine's `assignCombatDamage` deals it: a first-strike step only if a first or double striker is in the fight, lethal damage to each blocker in order and the rest to the last (or over it, with trample), one point lethal with deathtouch, nothing from an attacker whose blockers have all gone unless it tramples, simultaneous damage and then deaths, indestructible survivors, lifelink. It returns the board after combat — dead creatures in graveyards, attackers tapped unless they have vigilance, survivors healed as cleanup will heal them — for the evaluator to score. It does not see prevention, replacement effects, "can't be blocked" beyond flying and protection, or triggers.
- **Blocks** (`solveBlocks`) improve one attacker at a time — no block, each single blocker, pairs among its four likeliest blockers — until a pass changes nothing, the attacker putting its damage on the weakest blocker first. Never a lone blocker on menace; a chump (the blocker dies, the attacker lives) only when the unblocked damage would be lethal. When the viewer is blocking it maximises its own score and takes legality from the decision's `canBlock`; when it is predicting the opponent's blocks it minimises its own score and applies the two rules the view can check, flying/reach and protection from a colour.
- **Attacks** (`solveAttacks`) try no attack, everything, each creature alone, every creature worth sending alone together, and everything but one — each against the defender's predicted blocks — and rank them. Only the defending player is attacked; planeswalkers are left alone.
- **In the search**, an attack decision plays the solver's best `combatCandidates` attacks and not attacking through the real combat in every world, the opponent blocking with the solver; a block decision does the same for the solver's blocks, no blocks and greedy's blocks. A combat line is scored once damage has been dealt. With no budget left, the solver's own choice stands.

What it is worth, measured by switching it off (`combatCandidates: 0`) with everything else the same, over the same 500 games against greedy:

| search vs greedy | wins | losses | draws |
|---|---:|---:|---:|
| with the combat solver | 290 | 137 | 73 |
| greedy's combat rules | 275 | 193 | 32 |

Search's share of decided games goes from 59% to 68%. The draws more than double, and that is the solver too: a board that keeps its blockers home against a counter-attack is a board that stalls more often, and a stalled board runs into the turn cap. Greedy keeps its rules of thumb — it is the baseline the ladder measures the other levels by.

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
