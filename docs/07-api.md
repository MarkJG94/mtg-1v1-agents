# 07 — API

Fastify on one port; JSON over HTTP for state, WebSocket for live streams. All DTOs are zod schemas in `packages/shared` and shared with the web app. No authentication in v1 (LAN deployment); a reverse proxy with basic auth is the recommended way to expose it.

## HTTP

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | liveness, worker count, runs playing and waiting for a worker, db size, scryfall data version |
| GET | `/api/runs` | list runs with status and current cycle |
| POST | `/api/runs` | create run `{ name, settings, seedDeck?: Deck75, bans? }` → run |
| POST | `/api/seed-decks` | `{ settings, bans? }` → the seed deck a run so made would get, previewed |
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
| POST | `/api/cards/resolve` | `{ names, script? }` → each typed name's card and support status |
| POST | `/api/cards/:oracleId/script` | force (re)scripting; returns validation result |
| GET | `/api/coverage` | parser coverage summary + most-requested unsupported cards |
| GET | `/img/:oracleId?size=small|normal` | cached image proxy |

Errors are `{ error: { code, message, details? } }` with proper status codes; validation failures are 400 with the zod issue list.

**As built (6.1)**, in `apps/server/src/routes`, every route above but the image proxy (6.2's), with every request and response a zod schema in `packages/shared/src/api.ts`. Where the table leaves a choice:

- **Creating a run**: `settings` takes any subset of the run settings; a missing `seed` is drawn at random (64 bits) and recorded, so the run is still a function of its settings. The seed deck is rolled on a simulation worker. A pasted 75 that is not sixty and fifteen, or breaks the run's initial list, is `400 invalid_seed_deck`. Anything that needs Scryfall's cards answers `503 no_card_data` when they have not been fetched.
- **Lifecycle**: `start` takes `{ cycles? }` — play that many and pause — and answers the run's summary; pausing and stopping take effect after the match in progress (5.7). Starting a stopped run is `409`.
- **Fork** takes `{ cycle, name?, seed? }` (a missing seed is drawn); forking at a cycle the run has not finished is `409`. **Export** is the 5.6 bundle as an attachment, with each decklist's cards named from the catalogue; **import** accepts a bundle up to 1 GB and answers the new run, paused.
- **Cycles** page with `?offset=&limit=` (default 50, at most 500), finished cycles only; each says the change it made or, when the deck agent could make none, why (ADR 0017). A **cycle's detail** has the decks it began with, the change with its evidence, each deck's rates, play/draw records, what each deck showed, the trialled candidates and its matches.
- **Statistics** are one cycle's (`?cycle=n`) or every cycle rolled up with docs/05's decay, a row a card with its name, worst Δ first.
- **Bans**: `PUT`/`DELETE` answer `202` with the list and the trail. On a run a worker is playing the edit takes effect after the game in progress; otherwise it waits on the trail as pending until the run's next cycle starts. The card must be in the catalogue (`404` otherwise).
- **Matches and games** are addressed by the ids docs/06 gives them (`<run>:<cycle>:<match>` and `…:<game>`, URL-encoded); a game's log is `404` when it kept none.
- **Cards** search the catalogue — docs/06 `cards`, loaded from the Scryfall JSONL at boot whenever its version changes — by name, type line and rules text, the exact name first, then names that start with the query. A card's detail adds its script verdict, its record summed over every run, and how often a run asked for it and could not have it. `POST …/script` scripts it afresh on the scripting worker, ignoring the cache, and answers the verdict. **Coverage** counts the catalogue and the verdicts and lists the 25 most-requested unsupported cards.
- **Health** reports the simulation workers allowed, the runs on a worker and waiting for one, the database's size with its WAL, and the Scryfall version the catalogue holds.
- **Errors**: `400 invalid_request` (with the zod issues), `404 not_found` (an unknown route too), `409 conflict`, `503 no_card_data`, `503 scripting_unavailable` (6.3: the scripting worker has stopped, ADR 0018), `500 internal`.

**As built (6.3)**, for the new-run form (docs/08):

- **`POST /api/seed-decks`** rolls, on a simulation worker, the seed deck a run with these settings and initial bans would be made with, and makes nothing: the seed (drawn if absent, and returned so the run can be made with it), the colours, the land counts, the 75 with each card's name, type line, mana value and support, and the cards put back because the engine cannot play them. A run then made with that seed gets that deck: both go through the sim's `seedDeckFor`, and a test holds the preview to the created run's generation 0.
- **`POST /api/runs`** takes `bans: [{ oracleId, status, note? }]`, in effect from the start and stamped as applied at the run's creation; the seed deck is rolled around them, and a pasted one that breaks them is `400 invalid_seed_deck` — as is one holding a card the catalogue lacks or the engine cannot play, which used to be accepted and fail when the run started.
- **`POST /api/cards/resolve`** answers, for up to 250 typed names, the card each one is (its exact name whatever the case, or a split, adventure or double-faced card's front face) and, with `script` (the default), its support, scripting it if nobody has; a name that is no card is answered with `oracleId: null`.
- **Run summaries** carry `winRates` (A's rate in each of the last 40 finished cycles, oldest first) and `lastChange` (the newest change's reason), for the runs list.
- **The web app**: when `WEB_DIST` is served, any `GET` that is no route, not under `/api`, `/ws` or `/img` and not a file name answers the app's `index.html`, so a reload or a pasted link to `/runs/…` lands on the page. Before 6.3 this was a second not-found handler, which Fastify refuses — a server with `WEB_DIST` set, which is to say the Docker image, did not start.


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

**As built (6.2)**, in `apps/server/src/hub.ts`, with every message a zod schema in `packages/shared/src/api.ts` (`wsClientMessageSchema`, `wsServerMessageSchema`):

- On connecting a client is sent `{ type: 'hello', version }`; a message it cannot read, a subscription without the `runId` it needs, or a run the server does not have, is answered `{ type: 'error', message }`.
- `{ subscribe: 'runs' }` is sent every run's `runStatus` at once and then as each changes, and each `unsupportedCard`; `{ subscribe: 'run', runId }` is sent that run's `runStatus`, `cycleFinished` (the cycle summary of 6.1), `deckChanged` (the generation, its cause, the change's reason, and the slots out and in) and `banApplied` (the edit, stamped with the game it took effect after) as each is saved.
- `runStatus` is sent when a run starts, after every match, at every cycle's end and when it halts or fails; its `gamesPerSecond` and `etaSeconds` (the cycle's planned matches left, at the pace of the last minute) are measured by this server, so they read 0 and `null` until a run has saved two matches.
- **Live games**: `{ subscribe: 'game', runId }` makes the supervisor ask the run's worker to stream its games, from the next game to start; a run nobody watches is not streamed at all. The worker sends a game's start, its events in batches every ~50 ms of play, and its end; `gameStart` has the seed, cycle, match and game number, `chosenBy` (who chooses to play or draw — the choice itself is the game's `playOrDraw` event, so `onPlay` arrives with `gameEnd`), each side's sixty and generation. A viewer who subscribes mid-game is sent the start with `catchUp: true` and every event so far, which is what the viewer (6.5) rebuilds the board from. A socket with more than 4 MB waiting is skipped for the rest of that game — never waited for — and picked up again at the next game's start.
- `liveSpeed` and the run's `spectatorPacing` are not built: they belong with the game viewer (6.5).

**Images (6.2)**: `/img/:oracleId?size=small|normal` answers the card's image from `DATA_DIR/images/<size>/<oracle id>.jpg`, fetching it from Scryfall by the catalogue's printing the first time (`x-image-cache: miss`, then `hit`), one request at a time 100 ms apart, with requests for the same image sharing one fetch, and written whole or not at all; it is cached by the browser for a year. `SCRYFALL_IMAGE_CACHE=off` answers `404 images_off`; Scryfall failing answers `502 image_unavailable` and caches nothing, so the next request tries again. Only UUIDs from the catalogue ever become a file name or a URL.
