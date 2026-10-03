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

Phases 0 to 2 are **done**, phase 3's auto-scripter is built and short of its coverage
target, and phase 4 has begun. What is here from phase 1 is the state model, turn
structure, mana, the stack and priority, targeting, combat, state-based actions, triggered
abilities, the layer system, replacement and prevention effects, planeswalkers, game setup
with the London mulligan, a scenario builder and invariant fuzzer, and benchmarks. Cards
are data: a script is YAML in a closed vocabulary, `@mtg/cards` turns it into a card
definition, and the engine casts it, pays for it and resolves it — for a bootstrap set
written by hand, and for whatever the auto-scripter can read off a card's oracle text,
which is 11% of Scryfall against a 25% target. For agents, a play agent is given a
view of the game rather than the game, and a priority decision now offers everything a
player could actually do. A game plays in about 3.9 ms with the random agent, inside its
5 ms target, and in about 85 ms with both players searching, against 50 ms — the
roadmap's 4.8 note says where that stands. All four agent
levels play whole games — `random`, `greedy` (a tunable static evaluator), and `search`
and `deep`, which play each candidate forward by the real rules in samples of the game
as the player knows it and fight with a dedicated combat solver — and the sanity ladder
holds: search beats greedy beats random over 500 games a rung. A weight-tuning harness plays
one set of evaluator weights against another and hill-climbs; on the fuzz boards the agents
play until phase 5 brings decks, it finds nothing to change in the hand-tuned set. The first milestone is the end-to-end thin slice described in the
roadmap.

What runs today: `pnpm dev` starts the Fastify API and the Vite dev server together,
`pnpm fetch:scryfall` builds the card projection from Scryfall's bulk data, `pnpm bench`
and `pnpm bench:search` play fixed-seed games and report the time they take, `pnpm ladder` plays the agent levels
against each other, `pnpm tune` plays one set of evaluator weights against another or
hill-climbs a set, `pnpm seed:deck` rolls a seed deck from the whole of Scryfall and prints
it, and `pnpm check` (lint, typecheck, test, build) is green.

`main` is protected: every change lands through a pull request with all three CI jobs —
lint/typecheck/test/build, benchmarks, and the Docker build — green.

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
