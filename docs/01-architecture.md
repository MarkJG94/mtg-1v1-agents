# 01 — Architecture

## Monorepo layout

```
mtg-1v1-agents/
├── package.json                 pnpm workspaces, shared scripts
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── docker-compose.yml
├── Dockerfile
├── .github/workflows/ci.yml
├── docs/
├── data/                        gitignored: Scryfall bulk JSON, image cache, sqlite db
├── packages/
│   ├── engine/                  pure TS rules engine, zero runtime deps, no DOM/Node APIs
│   ├── cards/                   card-script schema, hand-written scripts, Scryfall loader,
│   │                            oracle-text auto-scripter, validation suite
│   ├── agents/                  play AI (evaluator, search, mulligan, sideboarding),
│   │                            deck-change AI (stats, shortlist search, chooser interface)
│   ├── sim/                     match/cycle/run orchestration, statistics aggregation,
│   │                            ban legalisation — still pure TS, used by server and tests
│   └── shared/                  types shared with the UI: event log, DTOs, settings schemas (zod)
└── apps/
    ├── server/                  Fastify HTTP + WebSocket, SQLite (better-sqlite3 + drizzle),
    │                            worker pool that runs packages/sim, image cache proxy
    └── web/                     React + Vite + Zustand; replay/live viewer, run control, ban console
```

Dependency direction is strictly downward: `shared ← engine ← cards ← agents ← sim ← server/web`. `engine` knows nothing about Scryfall, files, or the network; it receives already-built card definitions. This keeps the engine trivially testable and lets it run in a browser later if wanted.

## Processes

The server runs three kinds of work:

1. **API process** (Fastify): HTTP for CRUD on runs/bans/settings and for reading history; WebSocket for live game events and run status. Single Node process.
2. **Simulation workers** (`worker_threads`): one per run in progress, up to `SIM_WORKERS` (default = CPU cores − 1). Each worker owns one run's loop: play cycle → aggregate stats → choose change → legalise → persist → next cycle. Workers communicate with the API process via structured messages; the API process is the only writer to SQLite (workers post batches of results to it) to avoid write contention.
3. **Scripting worker**: one worker that services "script this card" requests (Scryfall lookup + auto-scripter + validation) so that card parsing never stalls a simulation worker. Results are cached in the `card_scripts` table.

## Data flow

```
Scryfall bulk JSONL ─(scripts/fetch-scryfall)──▶ data/scryfall/cards.jsonl  (see ADR 0001)
                                                        │
                                                        ▼
                                             packages/cards: CardDatabase (in-memory index by
                                             oracle_id, name, colours, mana value, type line)
                                                        │
              hand scripts (packages/cards/scripts/*.yaml) + auto-scripter
                                                        │
                                                        ▼
                                             CardDefinition (engine-ready, validated)
                                                        │
         run settings + seed ──▶ sim worker ──▶ engine.playGame() ──▶ GameEventLog
                                     │                                    │
                                     ├──▶ stats aggregation ◀─────────────┘
                                     ├──▶ deck-change AI ──▶ shortlist search ──▶ scripting worker
                                     └──▶ persist (API process ──▶ SQLite)
                                                        │
                                          WebSocket ────┴──▶ browser (live) / HTTP (replay)
```

## Engine execution model

The engine is a pure state machine: `step(state, decision) → { state, events[] }`. It never blocks waiting for a decision; instead, when a player must act, `state.pendingDecision` describes the choice (`{ player, kind: 'priority' | 'declareAttackers' | 'declareBlockers' | 'chooseTarget' | 'mulligan' | 'orderTriggers' | ... , options }`). A driver (the sim loop, a test, or later a human UI) supplies the decision. This design gives:

- deterministic replay from the event log or from `(seed, decisions[])`;
- trivial AI integration (the AI is just a function from state to decision);
- no async inside the engine.

Randomness (shuffles, coin flips) comes from a seeded PRNG stored in the state (xoshiro128**), so a game is a pure function of `(seed, deck lists, decision sequence)`.

State is immutable-by-convention with structural sharing via a small persistent-update helper; the search AI needs cheap copies for lookahead. Cards in zones are referenced by numeric object ids; the full `CardDefinition` is looked up from a per-game definition table so the state stays small.

## Card lifecycle

1. Scryfall bulk data is fetched once (`pnpm fetch:scryfall`) into `data/scryfall/cards.jsonl` and reloaded on server start into `CardDatabase`. The fetcher streams gzipped JSON Lines and skips non-card layouts; see ADR 0001.
2. A card is **requested** when the seed-deck generator or the replacement search wants it.
3. `ScriptResolver.resolve(oracleId)`: hand script → cached auto script → run auto-scripter → validation. Result is one of `supported`, `unsupported(reason)`, or `partial(reasons)` (partial scripts are never played; see 03).
4. Only `supported` cards enter decks. Every `unsupported` request is written to `unsupported_requests` with the failure reason and shown in the UI's coverage page so hand scripts can be prioritised by demand.

## Persistence and resume

Everything durable lives in one SQLite file (`data/mtg.db`, WAL mode). Runs are resumable: the worker checkpoints after every completed match (results + event logs), and after every cycle (decks, stats, change). On restart the server reloads every run with status `running` and resumes from the last completed match of the current cycle; a game interrupted mid-play is simply replayed from scratch with the same seed. The resumed cycle is rebuilt from its stored matches and their logs, so it ends where the one that never stopped would have (ADR 0015); the run driver and the store are in place (5.6), and reloading `running` runs at boot is the worker pool's (5.7).

## Deployment

`docker-compose.yml` runs one container: Node 22, the built server serving the built web app as static files on one port, `data/` mounted as a volume. Environment: `PORT`, `SIM_WORKERS`, `DATA_DIR`, `SCRYFALL_IMAGE_CACHE=lazy|off`. Outbound network is only needed for image cache misses; the sim itself is fully offline once the bulk data is present.

## Key libraries

| Concern | Choice | Reason |
| --- | --- | --- |
| Package manager | pnpm | workspaces, strict deps |
| Build | tsup for packages, Vite for web | fast, simple |
| Validation | zod | settings, API DTOs, card-script schema |
| DB | better-sqlite3 + drizzle-orm | synchronous, fast, typed |
| Server | Fastify + @fastify/websocket | light, fast |
| UI | React 18, Zustand, TanStack Query, Tailwind | familiar, minimal |
| Tests | Vitest, fast-check (property/fuzz) | TS-native |
| Lint | Biome | one tool |
