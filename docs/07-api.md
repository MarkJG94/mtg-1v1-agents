# 07 — API

Fastify on one port; JSON over HTTP for state, WebSocket for live streams. All DTOs are zod schemas in `packages/shared` and shared with the web app. No authentication in v1 (LAN deployment); a reverse proxy with basic auth is the recommended way to expose it.

## HTTP

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | liveness, worker count, db size, scryfall data version |
| GET | `/api/runs` | list runs with status and current cycle |
| POST | `/api/runs` | create run `{ name, settings, seedDeck?: Deck75 }` → run |
| GET | `/api/runs/:id` | run detail: settings, status, ban list, current decks, cycle summary |
| POST | `/api/runs/:id/start` · `/pause` · `/stop` | lifecycle |
| POST | `/api/runs/:id/fork` | `{ cycle, name? }` → new run |
| GET | `/api/runs/:id/export?logs=true` | JSON bundle |
| POST | `/api/runs/import` | bundle → new run |
| GET | `/api/runs/:id/cycles` | paginated cycles with win rates and changes |
| GET | `/api/runs/:id/cycles/:n` | cycle detail: decks, matches, stats, change with evidence |
| GET | `/api/runs/:id/decks/:agent` | lineage: every generation with the change and reason |
| GET | `/api/runs/:id/stats?agent=A&cycle=n` | card statistics table |
| GET | `/api/runs/:id/bans` | ban list + history |
| PUT | `/api/runs/:id/bans/:oracleId` | `{ status: 'banned'|'restricted', note? }` → applies per 05 |
| DELETE | `/api/runs/:id/bans/:oracleId` | unban |
| GET | `/api/matches/:id` | match with games and sideboarding |
| GET | `/api/games/:id` | game metadata |
| GET | `/api/games/:id/log` | decoded event log |
| GET | `/api/cards?q=` | search Scryfall projection (name/type/text), with support status |
| GET | `/api/cards/:oracleId` | card + script status + stats across runs |
| POST | `/api/cards/:oracleId/script` | force (re)scripting; returns validation result |
| GET | `/api/coverage` | parser coverage summary + most-requested unsupported cards |
| GET | `/img/:oracleId?size=small|normal` | cached image proxy |

Errors are `{ error: { code, message, details? } }` with proper status codes; validation failures are 400 with the zod issue list.

## WebSocket `/ws`

Client sends `{ subscribe: 'run', runId }`, `{ subscribe: 'game', runId }` (the run's current live game), `{ subscribe: 'runs' }` (list-level status), or `{ unsubscribe: ... }`.

Server messages:

- `runStatus` — status, cycle number, matches done/planned, games/sec, ETA.
- `cycleFinished` — win rates, loser, the change with reason.
- `deckChanged` — agent, generation, cause (`change` | `ban`), diff.
- `banApplied` — oracle id, status, note, when it took effect.
- `gameStart` — game id, decks, on-play and who chose it (`chosenBy`, or `null` when it was settled beforehand), plus the current full state snapshot if joining mid-game.
- `gameEvents` — batches of `GameEvent` for the live game (coalesced every ~50 ms; the viewer paces them itself).
- `gameEnd`.
- `unsupportedCard` — a card was requested and skipped (feeds the coverage page live).

Live streaming is best-effort: the simulation never waits for viewers. The viewer can request `{ liveSpeed: 'realtime' | 'fast' }`; in `realtime` the server delays the *next game start* in that run by up to a small budget so a viewer can follow, which is a run-level setting (`spectatorPacing`, default off) so an unattended run is never slowed.
