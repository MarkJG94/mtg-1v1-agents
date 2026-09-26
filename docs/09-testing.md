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
- **Auto-scripter golden tests**: a corpus of oracle texts with their expected scripts; any parser change must keep the corpus green or update goldens deliberately. `packages/cards/fixtures/corpus.json` holds 370 real cards — two core sets, fetched once by `pnpm cards:corpus` and committed because CI has no network — and `corpus-goldens.json` holds what the auto-scripter makes of each: the verdict, the reasons, and the script. `pnpm cards:goldens` rewrites it and `--check` fails when it is stale, which is what `pnpm check` runs. The cards that *fail* are as much the point as the ones that pass: their recorded reasons are the list of templates still to teach, and a card moving from unsupported to supported is exactly the diff a coverage push wants to show. The parser's coverage report is published as a CI artifact and the pipeline fails if coverage on the corpus drops.
- **Differential test**: for cards that have both a hand script and a passing auto script, the two must produce identical behaviour in the smoke scenarios; disagreements are bugs in one or the other and are triaged. `differentialTest(hand, auto, tests)` plays both scripts through the validator's three smoke boards and through the card's own scenario tests, and compares the *whole* resulting position — life, zones, characteristics as the layer system sees them, counters, the lot — rather than the expectations the hand script happened to declare. That is the point of it: an auto script that also drew a card is caught by a test nobody thought to write. A run that threw or could not be played is reported as one line rather than as a diff of a position it never reached. As of 3.4 it has something real to compare: **56 of the 60 bootstrap cards have both a hand script and an auto script the validator calls supported**, and every one of those pairs is played through both and compared. A test that says so is worth more than either script's own tests, because the two were written by different things. It found one bug immediately — a card whose spell text runs to two lines was emitted as two spell abilities, and the engine resolves only the first, so Twisted Image switched power and toughness and never drew its card.

A test that names an ability by id is skipped rather than compared: an id is a label for a script's own use, not a characteristic of the card, and reporting a naming difference as a behavioural one is noise in the one report that is meant to be all signal.

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

- Sanity ladders: `search` beats `greedy` beats `random` with statistically significant margins over 500 games (checked with a binomial test; guards against an evaluator regression that makes the AI worse). The first rung, `greedy` over `random`, runs in the unit suite as 60 games on fuzz boards with alternating seats and an exact one-sided binomial tail below 0.001 over the decided games (`packages/sim/src/game.test.ts`). The full ladder is `pnpm ladder` (`scripts/ladder.ts`, over `packages/sim/src/ladder.ts`), 500 games a rung, run by the nightly workflow and failing it if a rung does not hold. The top rung cannot live in the unit suite: search wins about three decided games in five against greedy, and two seed sets of a hundred games gave 48–28 and 32–35 — a hundred games cannot tell that margin from luck.
- The weight-tuning harness (`packages/sim/src/tuning.test.ts`), on greedy against a set that hoards its hand — a card in hand worth ten times the default, so no creature is ever cast — which the default beats 19–1 over twenty games: mirrored games split every pair between identical agents; a climb keeps the step that fixes the hand and refuses the two that do not, stops when every move from where it is has been refused, tries a refused move again once another step changes the weights, and confirms its result on seeds no step was judged on. Proposals are checked against the rules `parseWeights` holds a set to.
- Determinism: same seed → identical decisions.
- Information hiding, in two halves. A structural test that no file under `packages/agents/src` imports `@mtg/engine` — by name or by a relative path that climbs out of the package — and a walk of `@mtg/engine/view`'s own runtime import graph asserting it never reaches `state/game-state.ts`. The second is what stops the first from being a naming convention. Both are checked by reading import specifiers rather than by the type system, so a computed dynamic import would slip past; see ADR 0009 for why that trade is the right one.
- That the view depends on nothing hidden: two states differing only in the opponent's hand and the libraries — renumbered and renamed — must project to the same view, while the opponent's own view must differ. Stated as an equivalence rather than a list of fields, because the failure mode is a leak nobody thought to look for: ten tests that each named a field and checked it was absent all stayed green when a new field carrying the opponent's hand was added.
- Mulligan and sideboarding decisions on hand-built cases.

### 6. Simulation and server tests

- Cycle loop with an in-memory DB: statistics aggregation on hand-built logs equals expected numbers; tie handling; change application keeps 60/15; legalisation removes banned cards and respects restricted counts; resume after a simulated crash mid-cycle reproduces the same results.
- API contract tests (Fastify inject) for every route; WebSocket subscription tests.
- Migration tests for the event-log version.

### 7. UI tests

- Vitest + Testing Library for the viewer's view model (apply events forward/backward yields consistent boards).
- Playwright smoke: create a run with a fixed seed, watch a game, ban a card, see the legalisation. Runs against a server started with a tiny bootstrap card pool so it finishes in under a minute.

### 8. Benchmarks

`packages/engine/bench` measures ms/game, games/sec and decisions/sec over fixed-seed random games, in four cases: a baseline board, a wide board where blocks and damage assignment do real work, a long game, and the baseline with loop detection switched off so its cost is visible rather than inferred. `pnpm bench` prints the table; `--json` writes it for CI.

The search's benchmarks are `packages/sim/bench` (`pnpm bench:search`) rather than a bench in the agents package, which cannot run a game (ADR 0009): whole games on the ladder's fuzz boards with both players at `search`, which is the case docs/02's 50 ms is for, and one searcher against greedy, reporting ms/game and what a searched decision costs.

The engine's numbers are the engine's, not a game's: invariant checking is off (that is the fuzzer's job and costs several times what playing the game does). Both benchmarks time **the code as built**: `scripts/run-bundled.ts` bundles them the way tsup builds the packages and runs the bundle with node, because `tsx`'s `keepNames` transform read about a fifth slower and was in every number before 4.8 (ADR 0013).

CI runs both benchmarks and compares each against the last run recorded on `main`, failing on a regression greater than 20% in any case's median. The baseline travels through the Actions cache, which a branch can read from the default branch; a run with no baseline records one instead of failing. The comparison is on the median rather than the mean because a shared runner is noisy, and for the same reason CI's absolute budget is a ceiling against something going badly wrong rather than the 5 ms and 50 ms targets, which are one-core figures for a developer machine.

A benchmark is also a test that reads a whole system at once. This one found that loop detection was nine tenths of a game's time *and* that it was ending 36% of wide-board games as false draws, neither of which any unit test had noticed. See ADR 0005.

## CI (GitHub Actions)

`ci.yml`: pnpm install (cached) → biome lint → typecheck → card-schema and goldens freshness → unit + card + sim + server tests (the fuzzer among them, at its ordinary forty games) → benchmarks against the baseline recorded on `main` → build → a Docker image build.

`nightly.yml` runs the two things that are too slow or too networked for a pull request. The **long fuzz** plays `FUZZ_GAMES` games rather than the forty a suite somebody runs on every save can afford — the budget is read off the environment so the same test serves both. And the **full-Scryfall coverage report** fetches the day's bulk projection, runs the auto-scripter over every card, uploads the report and keeps one issue up to date with the top failing patterns. Neither gates anything: they are what tells us the parser reads less of Magic than it did yesterday, which is worth knowing and is never a reason to stop a merge.

## Definition of done for a card

A card is "supported" only when: validation passes, at least one scenario test exists (hand scripts) or the differential/smoke tests pass (auto scripts), and it has been played in at least one fuzz game without invariant violation.
