# MTG 1v1 Agents

Two AI agents play Magic: The Gathering against each other, best-of-three with sideboards, starting from an identical 60+15 card deck. After every cycle of N matches the losing agent makes exactly one change to its 75, chosen from match statistics to win more against the other agent. Runs continue until stopped. A browser UI replays any game, watches the live one, and lets you ban or restrict cards mid-run — after which both agents must legalise their decks before the next game.

Decks are not curated: the seed deck is drawn at random from the whole of Scryfall (with sanity constraints on lands and colours) and replacements are found by searching Scryfall. Every card is scripted on demand by an oracle-text auto-scripter, with hand-written scripts where the parser falls short; cards that can't be scripted yet are skipped and logged. The engine is meant to grow toward playing every card in Magic's history.

## Documents

| Doc | Contents |
| --- | --- |
| [docs/00-overview.md](docs/00-overview.md) | Goals, non-goals, decisions log |
| [docs/01-architecture.md](docs/01-architecture.md) | Monorepo layout, processes, data flow, deployment |
| [docs/02-rules-engine.md](docs/02-rules-engine.md) | Game state model, turn structure, stack, combat, SBAs, layers |
| [docs/03-card-scripts.md](docs/03-card-scripts.md) | Card definition language, Scryfall pipeline, oracle-text auto-scripter |
| [docs/04-agents.md](docs/04-agents.md) | Playing AI: evaluation, search, mulligans, sideboarding |
| [docs/05-evolution.md](docs/05-evolution.md) | Cycles, statistics, the one-change rule, ties, bans and restrictions |
| [docs/06-data-model.md](docs/06-data-model.md) | SQLite schema, event log format, persistence and resume |
| [docs/07-api.md](docs/07-api.md) | HTTP + WebSocket API |
| [docs/08-ui.md](docs/08-ui.md) | Browser app: runs, replay/live viewer, ban console, coverage |
| [docs/09-testing.md](docs/09-testing.md) | Test strategy, fixtures, fuzzing, CI |
| [docs/10-roadmap.md](docs/10-roadmap.md) | Phased plan and task board |

## Stack (decided)

TypeScript monorepo (pnpm workspaces). `packages/engine` (pure TS rules engine), `packages/cards` (card scripts + Scryfall data tooling), `packages/agents` (play AI, deck-change AI), `apps/server` (Node + Fastify + WebSocket, SQLite), `apps/web` (React + Vite). Docker Compose for the homelab.

## Status

Phase 1 (engine core) is implemented in `packages/engine`: turn structure, mana and the payment solver, the stack, targeting, combat, state-based actions, triggers, the layer system, replacement/prevention effects, planeswalkers, mulligans and game end, with a scenario builder, per-subsystem test suites and an invariant fuzzer.

Phase 2 (cards) is implemented in `packages/cards`: the card-script schema (zod + exported JSON Schema), the validator (characteristic agreement with Scryfall, oracle-text coverage, executability smoke games), 98 hand-written bootstrap scripts with their own YAML scenario tests, the `ScriptResolver`, and a differential harness for comparing two scripts of one card.

Phase 3 (the auto-scripter) is implemented in `packages/cards/src/auto`: oracle text is normalised, each sentence is classified and parsed by a token scanner over Magic's templating vocabulary, and the result is emitted as a card script and put through the same validator as a hand script. A card the grammar cannot read comes back with the rule that gave up and the text it stopped on, and `pnpm cards:coverage` turns those into a ranked list of the templates worth writing next.

See `docs/10-roadmap.md` for the task board and `docs/adr/` for decisions that changed during implementation. Next up is Phase 4 (the playing agents).

## Development

```
pnpm install
pnpm lint        # biome
pnpm typecheck
pnpm test        # vitest across packages (includes a short fuzz run; FUZZ_RUNS=500 for longer)
pnpm bench       # random-agent games/sec for the engine
pnpm cards:schema      # regenerate packages/cards/card-script.schema.json for YAML editor completion
pnpm fetch:scryfall    # download the Scryfall oracle-cards bulk file to data/scryfall/
pnpm scryfall:subset   # refresh the test fixture and script oracle ids from the bulk file
pnpm cards:coverage    # auto-scripter coverage over the bulk file -> data/coverage/report.{json,md}
```

Card scripts live in `packages/cards/scripts/<letter>/<slug>.yaml`; every script must validate as `supported` against its Scryfall entry and pass its own `tests:` (see `docs/03-card-scripts.md`).
