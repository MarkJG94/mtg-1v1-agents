# 09 — Testing

The evolution loop is only as meaningful as the engine is correct: a subtle combat bug will silently favour one strategy for a thousand cycles. Testing is therefore layered and runs on every push.

## Layers

### 1. Engine unit tests (Vitest)

One suite per subsystem, organised by Comprehensive Rules section, each test citing the rule it checks:

- turn structure and priority passing (`500`, `117`);
- mana costs and the payment solver (hybrid, phyrexian, X, additional costs, cost reduction, "can't be spent on");
- stack: casting, responding, countering, fizzling, split second, resolution order;
- targeting legality (hexproof/shroud/protection/ward, "can't be the target", changing targets);
- combat: all evergreen keywords, damage assignment order, multiple blockers, first-strike step existence, trample + deathtouch, lifelink timing;
- SBAs: lethal damage, 0 toughness, legend rule, auras attached illegally, planeswalker loyalty 0, +1/+1 vs −1/−1 annihilation, drawing from an empty library;
- triggers: APNAP, intervening-if, dies triggers with LKI, delayed triggers, "once each turn";
- layers: every layer and sublayer, timestamp order, dependency (Blood Moon + urza lands, Humility + Opalescence, Painter's Servant), control changes;
- replacement/prevention: ETB tapped, "if would die → exile", damage prevention ordering, self-replacement first;
- planeswalkers: loyalty activation once per turn, damage redirection removed, loyalty as a cost;
- mulligans; game end conditions; turn cap; loop detection.

Tests use a **scenario builder** in `@mtg/engine/testing`, which drives decisions explicitly so a test never depends on the AI:

```ts
game().player('A').battlefield({ name: 'attacker', power: 3, toughness: 3 })
      .player('B').battlefield({ name: 'blocker', power: 1, toughness: 1 })
      .start().to('declareAttackers').attack('attacker')
      .to('declareBlockers').block({ blocker: 'blocker', blocking: 'attacker' })
      .to('end');
```

Permanents are described by what the engine can read off them rather than by card name, because names need card definitions (roadmap 2.1); `name` is a label for readability and for finding the object again, and the legend rule is the one rule that reads it. Once card scripts exist the builder gains the `hand('Lightning Bolt')` form this doc originally sketched.

It lives behind a separate entry point so it never reaches the engine's runtime bundle, which carries no third-party dependencies and is small enough to run inside a search loop.

### 2. Card tests

- **Validation** of every hand script runs as a test (`packages/cards/test/scripts.test.ts`): schema, characteristic agreement with Scryfall, full text coverage, executability smoke.
- **Scenario tests per hand-scripted card**, in the same YAML as the script under `tests:`, written in a small declarative vocabulary so non-programmers (or the auto-scripter's future LLM-assisted mode) can add them:
  ```yaml
  tests:
    - name: kills a 3/3
      setup:
        opponent:
          creatures: [{ name: courser, power: 3, toughness: 3 }]
      targets: [courser]
      expect:
        zone: { courser: "B:graveyard" }
  ```
  A test is a board, one action and an expectation, and everything has a default: enough
  any-colour lands to cast the card, both players at twenty, the card in hand (on the
  battlefield instead when the test activates one of its abilities). `setup` takes
  `creatures`, `permanents` (for the artifact a Shatter needs — a type is a characteristic
  of a card, and an anonymous 2/2 cannot stand in for one), `life`, `handSize`, `lands`
  and `opponentSpell` (a real spell on the stack, for the counterspells; a bare name is a
  creature spell, and `{ name: x, types: [instant] }` when the card cares what it
  counters). The action is casting the card, or `activate` / `activateMana` for an
  ability, with `targets` by name and `kill` for the cards that care about something
  dying. `expect` covers life, hand size, zones, power, toughness, tapped, counters,
  keywords, permanent counts, mana in the pool and extra turns owed. Failures come back as
  sentences rather than as a thrown assertion, so one run reports every card that broke.
  `packages/cards/src/card-tests.test.ts` runs them all and also fails a card that has no
  test at all.
- **Auto-scripter golden tests**: a corpus of oracle texts with their expected scripts; any parser change must keep the corpus green or update goldens deliberately. The parser's coverage report is published as a CI artifact and the pipeline fails if coverage on the corpus drops.
- **Differential test**: for cards that have both a hand script and a passing auto script, the two must produce identical behaviour in the smoke scenarios; disagreements are bugs in one or the other and are triaged. `differentialTest(hand, auto, tests)` plays both scripts through the validator's three smoke boards and through the card's own scenario tests, and compares the *whole* resulting position — life, zones, characteristics as the layer system sees them, counters, the lot — rather than the expectations the hand script happened to declare. That is the point of it: an auto script that also drew a card is caught by a test nobody thought to write. A run that threw or could not be played is reported as one line rather than as a diff of a position it never reached. The real comparison waits on the auto-scripter in phase 3; what runs today is the harness against deliberately altered copies of a script, plus every bootstrap card compared with itself.

### 3. Seeded regression games

A fixture set of `(seed, decks)` with the recorded winner, turn count, and a hash of the event log. Any change in output requires a deliberate fixture update with an explanation in the commit. This catches unintended behaviour changes in the engine *and* the agent.

### 4. Invariant fuzzing (fast-check + the `random` agent level)

Thousands of random games per CI run with random supported decks. After every engine step, assert:

- object conservation: every object is in exactly one zone; total cards per player equals deck size (+ tokens created, − tokens that left);
- life totals change only via logged events; mana pool empties between steps unless an effect says otherwise;
- no object on the battlefield has toughness ≤ 0 after SBAs; no two legendary same-name permanents under one controller;
- the stack is empty at step transitions; priority is always with a valid player when a decision is pending;
- `legalActions` never returns an action the engine subsequently rejects, and every pending decision has at least one option;
- games terminate within the turn/decision cap, and the event log replays to an identical final state (`replay(log) == state`).

A failure reports the seed, the turn and the number of decisions taken, which is enough to replay it exactly; every decision is recorded on the result for the same reason. Automatic minimisation to the shortest failing prefix wants the shrinking a property-testing library gives and is the next refinement.

What this catches is **illegal states**, not wrong-but-legal outcomes. A rule that quietly stops applying — damage that is never cleared in cleanup, say — leaves every position legal and the fuzzer silent; that class is what the unit suites and the seeded regression games above are for. Worth knowing before trusting a green fuzz run.

### 5. Agent tests

- Sanity ladders: `search` beats `greedy` beats `random` with statistically significant margins over 500 games (checked with a binomial test; guards against an evaluator regression that makes the AI worse).
- Determinism: same seed → identical decisions.
- Information hiding: a compile-time test that `packages/agents` imports only `PlayerView`.
- Mulligan and sideboarding decisions on hand-built cases.

### 6. Simulation and server tests

- Cycle loop with an in-memory DB: statistics aggregation on hand-built logs equals expected numbers; tie handling; change application keeps 60/15; legalisation removes banned cards and respects restricted counts; resume after a simulated crash mid-cycle reproduces the same results.
- API contract tests (Fastify inject) for every route; WebSocket subscription tests.
- Migration tests for the event-log version.

### 7. UI tests

- Vitest + Testing Library for the viewer's view model (apply events forward/backward yields consistent boards).
- Playwright smoke: create a run with a fixed seed, watch a game, ban a card, see the legalisation. Runs against a server started with a tiny bootstrap card pool so it finishes in under a minute.

### 8. Benchmarks

`packages/engine/bench` measures ms/game, games/sec and decisions/sec over fixed-seed random games, in four cases: a baseline board, a wide board where blocks and damage assignment do real work, a long game, and the baseline with loop detection switched off so its cost is visible rather than inferred. `pnpm bench` prints the table; `--json` writes it for CI. `packages/agents/bench` follows when there are agents to measure (phase 4).

The numbers are the engine's, not a game's: invariant checking is off (that is the fuzzer's job and costs several times what playing the game does), and with no card definitions nothing is cast.

CI runs the benchmarks and compares them against the last run recorded on `main`, failing on a regression greater than 20% in any case's median. The baseline travels through the Actions cache, which a branch can read from the default branch; a run with no baseline records one instead of failing. The comparison is on the median rather than the mean because a shared runner is noisy, and for the same reason CI's absolute budget is a ceiling against something going badly wrong rather than the 5 ms target, which is a one-core figure for a developer machine.

A benchmark is also a test that reads a whole system at once. This one found that loop detection was nine tenths of a game's time *and* that it was ending 36% of wide-board games as false draws, neither of which any unit test had noticed. See ADR 0005.

## CI (GitHub Actions)

`ci.yml`: pnpm install (cached) → biome lint → typecheck → unit + card + sim + server tests → fuzz (short budget, 2 minutes; the nightly workflow runs 30 minutes) → benchmarks → build web → Playwright smoke → upload coverage report and parser coverage report as artifacts. A `nightly.yml` runs the long fuzz and the full-Scryfall parser coverage report and opens/updates an issue with the top failing parser patterns.

## Definition of done for a card

A card is "supported" only when: validation passes, at least one scenario test exists (hand scripts) or the differential/smoke tests pass (auto scripts), and it has been played in at least one fuzz game without invariant violation.
