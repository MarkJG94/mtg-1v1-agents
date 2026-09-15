# 10 — Roadmap and task board

Phases are ordered so that something runs end to end as early as possible (decision D21) and each later phase widens one axis: rules coverage, card coverage, agent strength, or operability. Effort is given in rough "focused sessions" (a session ≈ a few hours of AI-assisted work) and is deliberately conservative; the rules engine and parser are where estimates are least reliable.

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done.

## Phase 0 — Repository and scaffolding (≈ 2 sessions)

- [~] 0.1 `git init` in the project folder; create the GitHub repo `mtg-1v1-agents`; push; branch protection on `main`. *(Repo created and pushed. Branch protection on `main` is still to be switched on in the GitHub settings — an operator action.)*
- [x] 0.2 pnpm monorepo: `packages/{shared,engine,cards,agents,sim}`, `apps/{server,web}`, shared tsconfig, Biome, Vitest, tsup, Vite. *(Dependency versions are pinned centrally in the pnpm catalog in `pnpm-workspace.yaml`. Internal packages export TypeScript source and are bundled into the server by tsup, so there is no build ordering to manage.)*
- [x] 0.3 GitHub Actions `ci.yml` (lint, typecheck, test, build), plus a job that builds the Docker image.
- [x] 0.4 `scripts/fetch-scryfall.ts`: streams the gzipped `oracle_cards` JSONL to `data/scryfall/cards.jsonl`, skips non-card layouts, writes `meta.json` and prints counts. See ADR 0001.
- [x] 0.5 Dockerfile + docker-compose with a `data` volume; `pnpm dev` runs server + web with HMR and an `/api` proxy.

## Phase 1 — Engine core (≈ 10–14 sessions)

- [x] 1.1 State model, object ids, zones, seeded RNG, structural-sharing update helper, event emitter. *(Zone and state shape settled in ADR 0002. `GameState` gains its per-subsystem fields in 1.4/1.6/1.8/1.9.)*
- [x] 1.2 Turn structure with all steps; untap/draw/cleanup; land drops; turn cap. *(Also extra turns. The first-strike damage step is skipped until combat exists in 1.6. Cleanup's discard-to-hand-size is a real player choice, so it takes an injected `chooseDiscards` hook for now and fails loudly without one; 1.4 replaces the hook with a `pendingDecision`. Timing and land-drop limits are enforced; "is this card actually a land" waits on card definitions in 2.1.)*
- [x] 1.3 Mana: pool, costs (incl. hybrid/phyrexian/X), payment solver, mana abilities of basic and simple nonbasic lands. *(Pool reshaped to carry snow and spend restrictions per unit, and phyrexian mana folded into hybrid; see ADR 0003. The solver is exact, including {S} and {X}. Spend restrictions are carried but enforced in 1.4, when the engine knows what is being cast. `ManaAbility` is modelled and resolves without the stack; wiring real lands' abilities waits on card scripts in 2.1.)*
- [x] 1.4 Priority, stack, casting/activating, resolution, countering, fizzling, split second. *(The `step(state, decision)` model from docs/01 is live: `pendingDecision`, `applyDecision`, and the priority loop, which also retires 1.2's `chooseDiscards` hook. Stack resolution is LIFO, with countering and split second. Two parts wait on their own phases: a priority decision only offers `pass` until `legalActions` enumerates the rest in 1.5, and fizzling needs targets, also 1.5. Checking state-based actions and putting triggers on the stack sit immediately before priority (CR 117.5) and arrive in 1.7 and 1.8; abilities as objects on the stack need card scripts in 2.1.)*
- [x] 1.5 Targeting and legality (`legalActions`), hexproof/shroud/protection/ward. *(Shroud stops everyone, hexproof only opponents, protection is colour-based, and ward is reported as a cost rather than a targeting restriction. Fizzling (CR 608.2b) lands here too, as 1.4 flagged. Keywords are stored on the object for now and become the per-object cache `characteristics()` fills in 1.9. `legalActions` covers timing and payability — including mana untapped lands could still make — and reads what a card *is* through a `CardInfoSource` that 2.1 implements over card scripts; wiring it into the priority decision's options needs those same definitions.)*
- [x] 1.6 Combat with all evergreen keywords, damage assignment, first-strike step. *(Attack and block declaration with flying/reach/menace/vigilance/haste/defender, damage-assignment order, first and double strike, trample, deathtouch, lifelink. Damage is applied as one batch so creatures trade. Creatures die in 1.7, when state-based actions arrive; indestructible is carried for it. Damage assignment picks the canonical legal split (lethal down the order, excess to the last blocker or trampled over) — a free-form `assignDamage` decision is a refinement, not a correctness fix. Power/toughness joins keywords as stored-for-now, computed in 1.9.)*
- [x] 1.7 State-based actions, legend rule, counters, tokens. *(CR 704: losing at zero life, to decking and to poison; lethal damage, zero toughness and deathtouch, with indestructible sparing the first two but not zero toughness; +1/+1 and -1/-1 annihilation; tokens ceasing to exist; auras dying and equipment falling off; planeswalker loyalty. The legend rule asks the controller which to keep rather than choosing for them. Checked whenever a player would receive priority and repeated until nothing applies. `characteristics.ts` applies counters to power and toughness — the first slice of the 1.9 layer system, which subsumes it.)*
- [x] 1.8 Triggered abilities (APNAP, intervening-if, LKI, delayed), static abilities. *(Triggers fire on their event, wait, and go on the stack before the next priority in APNAP order, with the controller choosing among their own. Intervening-if is checked as it would go on the stack; last known information is captured before the source leaves, so dies triggers work. Delayed and once-each-turn triggers included. Abilities on the stack cease to exist on resolution rather than going to a graveyard. **Static abilities are not here**: they are continuous effects, and they only mean anything once the layer system exists, so they move to 1.9.)*
- [x] 1.9 Continuous effects and the layer system with timestamps and dependency. *(Layers 1-7 with all five of layer 7's sublayers, timestamp order within a layer, dependency ordering per CR 613.8 with a timestamp fallback on cycles, durations including until-end-of-turn and while-source-on-battlefield, and per-state memoisation. Every characteristic reader in the engine goes through `characteristics(state, id)`; the values on `GameObject` are printed values only. Dependency detection covers "changes what an effect applies to", which is complete for the current effect vocabulary because no change reads the board — `dependsOn` is the one place to widen when 2.1 adds one that does. The named cards in docs/09 (Humility + Opalescence, Blood Moon + Urza lands, Painter's Servant) are tested by shape here and by name once card scripts exist. Static abilities moved here from 1.8 and are continuous effects with a `whileSourceOnBattlefield` duration.)*

- [x] 1.10 Replacement and prevention effects. *(CR 614-616. The engine no longer changes state directly: it builds `RulesEvent`s and hands them to `runBatch`, which runs each past every applicable replacement before `performEvents` applies what survives — see ADR 0004. Self-replacement first (616.1a), never twice to the same event (614.5), and the affected player chooses when several still apply, which is a real `chooseReplacement` decision and so can pause a batch mid-flight. Prevention (615) is a species of replacement, with shields that shrink by what they absorb; regeneration (701.15) is a one-use shield over destruction specifically, which is why zero toughness — being put into the graveyard rather than destroyed — is not saved by one. Combat damage, drawing, discarding, dying, the legend rule, spell resolution, fizzling and countering all go through the pipeline, so lifelink's life gain is itself replaceable. The effect vocabulary is what the current engine can produce; card scripts in 2.1 add to it, and `performEvents` is where the docs/03 effect ops hang.)*
- [x] 1.11 Planeswalkers. *(CR 306 and 606. A planeswalker enters with loyalty counters equal to its printed loyalty, seeded into 1.10's `entersBattlefield` event rather than set afterwards — which is what lets a Doubling Season double it, since that is a replacement effect. Damage dealt to one removes that many loyalty counters instead of being marked (CR 306.8); a permanent that is both a creature and a planeswalker gets both. Attackers choose a defender per attacker from the defending player and the planeswalkers they control (CR 508.1a), and the declaration is validated against that list. Trample over blockers already went to "the player or planeswalker it's attacking" (CR 702.19b), so that needed a test rather than a change; damage aimed at a player is not redirected, the 2018 rules change. Loyalty abilities are activated at sorcery speed, once per permanent per turn (CR 606.3), with the counters paid as a cost — so Doubling Season does **not** double a `+2`, and an ultimate that empties a planeswalker kills it to a state-based action while its ability is still on the stack and resolves anyway. `legalActions` offers them and `whyNotActivateLoyalty` is the single legality check both it and activation use, so the engine never rejects what it offered. What each ability *does* is a card script, roadmap 2.1.)*
- [x] 1.12 London mulligan; game end conditions; loop detection. *(`setUpGame` shuffles, deals seven each and runs the mulligan rounds: both players declare in turn order before any mulligan is taken, those who mulligan redraw a fresh seven together, and on keeping a player puts one card under their library per mulligan taken (CR 103.4b) — the London mulligan is not "draw one fewer". `startGame` still skips all of it for tests and for 1.13's scenario builder. `game-end.ts` is now the only thing that writes `state.result`: conceding, effects that make a player win or lose outright, the turn cap, and the two draws we impose ourselves. Loop detection (CR 726) hashes a canonical projection of the state at every decision point — a repeat within a turn is a draw — and a decision cap backstops the loops the hash cannot see, such as one that shuffles. The hash is 53 bits across two FNV passes rather than 32, because a collision here is a game silently called a draw rather than a crash.)*
- [x] 1.13 Scenario builder for tests; unit suites for 1.2–1.12; invariant fuzzer with the `random` agent. *(All three live behind `@mtg/engine/testing`, a second entry point, so the runtime bundle keeps its zero dependencies and its size. The scenario builder has the fluent shape docs/09 sketches but describes permanents by what the engine can read off them rather than by card name — names arrive with card scripts in 2.1, and `name` is a label until then, which the legend rule happens to read. The `random` agent answers every decision kind uniformly from an injected generator, so a failing game replays from its seed. The fuzzer asserts the docs/09 invariants after **every** decision and checks `replay(decisions) == state`; the stronger `replay(log) == state` needs an event-log consumer that does not exist yet. The unit suites were audited against the eleven bullets in docs/09 rather than padded: they were already substantively there. Two of those bullets are blocked rather than missing — "changing targets" and additional/alternative costs need card effects in 2.1.)*
- [x] 1.14 Benchmarks; target ≤ 5 ms/game with the random agent. *(`packages/engine/bench`, run with `pnpm bench`: fixed-seed games in four cases — a baseline board, a wide board, a long game, and the baseline without loop detection so its cost is measured rather than guessed — reporting ms/game, games/sec and decisions/sec. **Median 2.2 ms a game**, inside the target. It did not start there: the first run was 23 ms, nine tenths of it CR 726 loop detection hashing a full position at every one of ~510 decision points. Chasing that found a rules bug the unit tests had not — the projection ignored `state.combat`, so ordering blockers on one attacker looked like a position repeating and **36% of wide-board games were ending as false draws**. Both halves are fixed, with tests and ADR 0005: the hash covers combat, the paused replacement batch and the triggers fired this turn, and it only watches a turn once that turn has run longer than any ordinary turn, since a loop never stops being one. CI runs the benchmarks and fails on a regression greater than 20% against the last run on `main`. `packages/agents/bench` and the ≤ 50 ms search-AI figure wait on agents in phase 4; a benchmark over real games waits on cards in 2.1.)*

## Phase 2 — Cards: schema, bootstrap set, resolver (≈ 5–7 sessions)

- [ ] 2.1 Card-script zod schema + JSON Schema export; loader that turns a script into an engine `CardDefinition`; effect-op registry in the engine (first ~40 ops).
- [ ] 2.2 Validator: schema, characteristic agreement with Scryfall, text coverage, executability smoke.
- [ ] 2.3 Bootstrap hand scripts (~80 cards): basics, shocks/duals/fetches/checklands, one or two cards per effect op and per keyword, a few planeswalkers, a few layer-system cards (Blood Moon, Glorious Anthem, Humility) — chosen to exercise the engine, not to make a deck.
- [ ] 2.4 `ScriptResolver` (hand → cached auto → auto-scripter → validate) with the `card_scripts` cache and `unsupported_requests` logging.
- [ ] 2.5 Scenario tests per bootstrap card; differential test harness.

## Phase 3 — Auto-scripter v1 (≈ 8–12 sessions, then continuous)

- [ ] 3.1 Normaliser (name → `~`, reminder text, sentence split, keyword lines, Scryfall keyword cross-check).
- [ ] 3.2 Sentence classifier (keyword / activated / triggered / static / spell / loyalty / unknown).
- [ ] 3.3 PEG grammar v1: costs, targets, quantities, durations, conditions, common effect verbs; anaphora resolution.
- [ ] 3.4 Emitter + golden corpus (≈ 300 cards spanning the common templates).
- [ ] 3.5 `pnpm cards:coverage` full-Scryfall report with top failing patterns; nightly workflow.
- [ ] 3.6 Coverage push to ≥ 25% of Scryfall `supported` (vanilla/French-vanilla creatures, burn, pump, simple removal, cantrips, counters, ETB/dies triggers, simple anthems, basic mana rocks/dorks).

## Phase 4 — Agents (≈ 6–8 sessions)

- [ ] 4.1 `PlayerView` and the import-boundary test.
- [ ] 4.2 Static evaluator with weights file; `greedy` level.
- [ ] 4.3 Determinised depth-2 search with beam for main-phase sequencing; per-decision budget; `search` and `deep` levels.
- [ ] 4.4 Combat solver (attacks and blocks).
- [ ] 4.5 Mulligan and play/draw logic.
- [ ] 4.6 Sideboarding agent with tag priors and matchup stats.
- [ ] 4.7 Sanity-ladder tests (search > greedy > random); weight-tuning harness.
- [ ] 4.8 Benchmarks; target ≤ 50 ms/game at `search`.

## Phase 5 — Simulation loop and persistence (≈ 5–7 sessions)

- [ ] 5.1 Match runner (Bo3, play/draw rules, sideboarding hook), cycle runner, tie handling.
- [ ] 5.2 Statistics aggregator from event logs (all stats in 05), decay roll-up, shrinkage.
- [ ] 5.3 Constrained-random seed-deck generator with re-roll on unsupported.
- [ ] 5.4 `StatisticalDeckAgent`: diagnosis, Scryfall shortlist query, static quality model, on-demand scripting via the scripting worker, optional trial batches, reason text.
- [ ] 5.5 Ban list semantics and legalisation; audit trail.
- [ ] 5.6 SQLite schema (drizzle migrations), checkpointing, resume after crash test, export/import, fork.
- [ ] 5.7 Worker pool (`worker_threads`), API-process-only writes, scripting worker.

## Phase 6 — Server and UI thin slice (≈ 6–8 sessions)

- [ ] 6.1 Fastify routes for runs/cycles/decks/stats/bans/games/cards; zod DTOs; contract tests.
- [ ] 6.2 WebSocket hub with subscriptions and event batching; image proxy with cache.
- [ ] 6.3 Web app shell, runs list, new-run form with seed-deck preview.
- [ ] 6.4 Run dashboard: win-rate chart, decks with Δ chips, timeline, ban console.
- [ ] 6.5 Game viewer (replay + live) with view model, transport, ticker, hover cards.
- [ ] 6.6 Cards & coverage page.
- [ ] 6.7 Playwright smoke; Docker image built in CI.

**Milestone M1 — thin slice complete:** a run can be created with a random deck, plays cycles unattended in Docker, evolves via Scryfall replacement search, can be watched live and replayed, and reacts to a live ban. Everything in phases 1–6 is behind tests.

## Phase 7 — Widen (continuous, prioritised by the coverage page)

- [ ] 7.1 Auto-scripter grammar growth driven by the most-requested unsupported cards; target 50% then 70% of Scryfall.
- [ ] 7.2 Engine mechanics v2: double-faced/MDFC, adventures, split/fuse, sagas, morph, suspend, cascade, storm, day/night, the monarch/initiative, battles.
- [ ] 7.3 Agent strength: better evaluator terms, opponent hand inference from revealed information, tuned weights per colour combination, deeper search in tiebreaks.
- [ ] 7.4 `LLMDeckAgent` option (Claude API) with the same interface; compare against the statistical agent on identical seeds.
- [ ] 7.5 Multi-worker per run; games/sec dashboard; retention policies.
- [ ] 7.6 Multi-run comparison views; deck lineage graph; "what did the bans do" report.
- [ ] 7.7 Human-play adapter for the engine (stretch).

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Rules engine bugs skew evolution silently | Layered tests (09), invariant fuzzing on every push, regression fixtures, sanity ladders. |
| Auto-scripter coverage stalls on the long tail | Random-deck design tolerates gaps; effort is steered by *requested* unsupported cards, not by raw count; hand scripts remain first-class. |
| Layer system + planeswalkers in v1 is heavy | Scheduled last in phase 1 with thorough tests; the thin slice still runs if 1.9/1.11 slip, because random decks re-roll cards that need them. |
| Evaluator quality caps how meaningful "winning" is | Tuning harness; ladders; deeper search available for tiebreaks; LLM coach later. |
| Slow simulations make cycles take hours | Benchmarks in CI; worker pool; `agentLevel` and `trialTopK` knobs. |
| SQLite growth over month-long runs | Compressed logs, retention setting, export as backup. |
| Scryfall rate limits / offline homelab | Bulk data is offline; images are lazy and cached; text-only mode exists. |

## Working agreement

- Every phase ends with its tests green in CI and a short ADR (`docs/adr/NNNN-title.md`) for any decision that changed from these docs.
- Deck lists, bans, and settings are always data; never hard-code a card name in engine or agent code (card names appear only in scripts and tests).
- Determinism is non-negotiable: any new source of randomness must draw from the injected RNG.
