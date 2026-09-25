# ADR 0009 — The play agent is given a view, not a state

- Status: accepted; amended by ADR 0012 (how the search builds its determinisation)
- Date: 2026-09-18

## Context

docs/04 states the play agent's interface as

```ts
decide(state: GameState, decision: Decision, view: PlayerView, rng: Rng): DecisionAnswer;
```

and, two paragraphs later, says that `PlayerView` exists so the agent "never sees the
opponent's hand or library order (the engine would let it; the view forbids it)".

Both cannot be true. A `GameState` holds both hands and both library orders, and it is the
first parameter. An agent handed one can read everything the view was built to withhold,
and the view becomes documentation rather than a mechanism.

What makes this worth an ADR rather than a typo fix is that **the failure is invisible**.
Every other guarantee in this project fails loudly: a rules bug throws, a bad script fails
validation, a slow engine fails the benchmark gate. An agent that peeks at the opponent's
hand does none of those things. It wins. It wins more against agents that do not peek, so
the evolutionary loop in docs/05 selects for whatever it was doing, and a run produces a
confident, well-tested, entirely meaningless result. There is no test of an agent's
*behaviour* that would notice, which is why the boundary has to be structural.

Against that: docs/04's search (roadmap 4.3) is described as calling the engine's `step` on
a cloned state. That is a real need, and it is why the state was in the signature.

## Decision

**`decide(view, decision, rng)`. The state is not a parameter, and the agents package
cannot import the module it is declared in.**

Three things together:

1. `PlayerView` is **plain data with no back-reference** to the state it was projected
   from, so it cannot be unwrapped.
2. The hiding is **in the types**: the opponent's side has no `hand` field to read, rather
   than one that happens to be empty, and neither side has a library at all.
3. `@mtg/engine/view` is a separate entry point carrying the view, the decision vocabulary
   and the RNG interface — and nothing whose runtime import graph reaches
   `state/game-state.ts`. `packages/agents` imports that and never `@mtg/engine`;
   `import-boundary.test.ts` checks both halves, and the second half is what stops the
   first from being a naming convention.

## Consequences

- **4.3's search cannot call `step` on the real state.** It has to build a plausible full
  state out of the view — the determinisation docs/04 already describes, where the
  opponent's hand is sampled from the cards not visible — and search that. This is the
  cost of the decision, and it is the right one: a search that ran on the true state would
  be a search that knew the opponent's hand, which is the same cheat wearing a different
  hat. The sampling has to be seeded from the injected RNG like everything else.
  *(ADR 0012: the determinisation is built by the engine from the state with everything
  hidden replaced, rather than from the view, which lacks targets, effects and timestamps
  the rules need. The property that makes it safe is the same one: it is a function of
  what the player can see.)*
- Whoever drives the game — the simulation loop in phase 5 — calls `viewFor(state, player)`
  and hands the result over. That is the only place the projection happens, so the rule
  about what a player knows lives in one function with tests rather than in every agent.
- `viewFor` costs a projection per decision. The engine's own benchmarks put a game at
  ~510 decisions, so this is measured in phase 4.8 against the ≤ 50 ms/game target rather
  than assumed away. If it bites, the answer is an incremental projection keyed on
  `state.version`, not a hole in the boundary.
- The return type is the engine's `DecisionResponse`; docs/04's `DecisionAnswer` was a name
  for the same thing that never existed in code.

## The limit this leaves, deliberately

The boundary is checked by reading import specifiers, not by the type system, so it is as
good as the test. A file that built a specifier at run time — `await import(name)` with a
computed `name` — would slip past it. That is a deliberate trade: the check is simple
enough to read in a minute and to trust, and an agent doing dynamic imports to reach the
game state would be a thing somebody wrote on purpose rather than a mistake somebody made.

The view also cannot show **revealed cards**, which docs/04 lists among the things an agent
should see. The engine does not track them: nothing writes down that a card was revealed by
a `reveal` op or looked at by a scry, so there is nothing for the view to project. Closing
it means a `revealed` record on `GameState` written by those ops, and it is named here
rather than faked, because a view that quietly showed nothing would look exactly like a
view whose information had been hidden correctly.
