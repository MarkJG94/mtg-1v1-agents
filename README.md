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

[CLAUDE.md](CLAUDE.md) holds the working notes for AI-assisted sessions: the commands, what "a phase is finished" means, and the engine invariants that are easy to break by accident.

## Stack (decided)

TypeScript monorepo (pnpm workspaces). `packages/engine` (pure TS rules engine), `packages/cards` (card scripts + Scryfall data tooling), `packages/agents` (play AI, deck-change AI), `apps/server` (Node + Fastify + WebSocket, SQLite), `apps/web` (React + Vite). Docker Compose for the homelab.

## Status

Phase 0 (repository and scaffolding) is done. Phase 1 (engine core) is through 1.12: the
state model, turn structure, mana, the stack and priority, targeting, combat, state-based
actions, triggered abilities, the layer system, replacement and prevention effects,
planeswalkers, and game setup with the London mulligan. Card definitions arrive in phase
2, which is what turns the engine into a game. The first milestone is the end-to-end thin
slice described in the roadmap.

What runs today: `pnpm dev` starts the Fastify API and the Vite dev server together,
`pnpm fetch:scryfall` builds the card projection from Scryfall's bulk data, and
`pnpm check` (lint, typecheck, test, build) is green.

## Getting started

```bash
pnpm install
pnpm fetch:scryfall   # ~25 MB download; writes data/scryfall/cards.jsonl
pnpm dev              # API on :8080, web on :5173 (proxying /api)
```

| Command | Does |
| --- | --- |
| `pnpm dev` | Server and web app with hot reload. |
| `pnpm test` | Vitest across every workspace package. |
| `pnpm lint` / `pnpm format` | Biome check / check --write. |
| `pnpm typecheck` | `tsc` per package. |
| `pnpm build` | tsup bundles for the packages and server, Vite build for the web app. |
| `pnpm check` | Everything CI runs (`ci` is a reserved pnpm subcommand). |
| `pnpm fetch:scryfall` | Refresh `data/scryfall/cards.jsonl` (add `--force` to refetch). |

Docker, for the homelab: `docker compose up --build` serves the API and the built web app
on one port with `data/` on a named volume.
