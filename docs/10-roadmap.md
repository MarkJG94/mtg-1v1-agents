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
- [ ] 1.5 Targeting and legality (`legalActions`), hexproof/shroud/protection/ward.
- [ ] 1.6 Combat with all evergreen keywords, damage assignment, first-strike step.
- [ ] 1.7 State-based actions, legend rule, counters, tokens.
- [ ] 1.8 Triggered abilities (APNAP, intervening-if, LKI, delayed), static abilities.
- [ ] 1.9 Continuous effects and the layer system with timestamps and dependency.
- [ ] 1.10 Replacement and prevention effects.
- [ ] 1.11 Planeswalkers.
- [ ] 1.12 London mulligan; game end conditions; loop detection.
- [ ] 1.13 Scenario builder for tests; unit suites for 1.2–1.12; invariant fuzzer with the `random` agent.
- [ ] 1.14 Benchmarks; target ≤ 5 ms/game with the random agent.

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
