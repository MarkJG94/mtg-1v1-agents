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

Phase 1 (engine core) is implemented in `packages/engine`: turn structure, mana and the payment solver, the stack, targeting, combat, state-based actions, triggers, the layer system, replacement/prevention effects, planeswalkers, mulligans and game end, with a scenario builder, per-subsystem test suites and an invariant fuzzer. See `docs/10-roadmap.md` for the task board and `docs/adr/` for decisions that changed during implementation. Next up is Phase 2 (card scripts and the bootstrap set).

## Development

```
pnpm install
pnpm lint        # biome
pnpm typecheck
pnpm test        # vitest across packages (includes a short fuzz run; FUZZ_RUNS=500 for longer)
pnpm bench       # random-agent games/sec for the engine
```
