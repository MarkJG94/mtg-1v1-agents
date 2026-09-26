# 06 — Data model and persistence

SQLite (`data/mtg.db`, WAL, `synchronous=NORMAL`), accessed through drizzle-orm from the API process only. Event logs are stored as compressed JSON blobs (zstd from Node's own `zlib` where it has it, gzip otherwise; the encoding is stored beside every blob) because they are write-once, read-rarely, and large.

## Tables

```sql
cards (                      -- projection of Scryfall bulk data, rebuilt on fetch
  oracle_id TEXT PK, name TEXT, mana_cost TEXT, mana_value REAL, colors TEXT, color_identity TEXT,
  type_line TEXT, oracle_text TEXT, power TEXT, toughness TEXT, loyalty TEXT, keywords TEXT,
  layout TEXT, legal_base INTEGER, preferred_printing_id TEXT, image_uri TEXT, scryfall_updated_at TEXT,
  projection TEXT /*the whole projection, json: what a card is scripted against on request*/
);
card_scripts (
  oracle_id TEXT PK, source TEXT CHECK(source IN ('hand','auto')), parser_version INTEGER,
  status TEXT CHECK(status IN ('supported','partial','unsupported')), reasons TEXT, script TEXT, updated_at TEXT
);
unsupported_requests (id INTEGER PK, oracle_id TEXT, run_id TEXT, context TEXT, reason TEXT, requested_at TEXT);

runs (
  id TEXT PK, name TEXT, status TEXT, seed TEXT, settings TEXT /*json*/, created_at TEXT, updated_at TEXT,
  forked_from_run TEXT, forked_from_cycle INTEGER, current_cycle INTEGER
);
ban_list (run_id TEXT, oracle_id TEXT, status TEXT CHECK(status IN ('banned','restricted')), PRIMARY KEY(run_id, oracle_id));
ban_events (id INTEGER PK, run_id TEXT, oracle_id TEXT, action TEXT CHECK(action IN ('ban','restrict','unban')), note TEXT, by TEXT, at TEXT, applied_after_game_id TEXT /*null while pending*/);
                             -- the whole trail is rewritten with every checkpoint; ban_list is derived from it

deck_generations (
  id TEXT PK /*run:agent:generation*/, run_id TEXT, seq INTEGER /*order made in*/, agent TEXT CHECK(agent IN ('A','B')), generation INTEGER, cycle INTEGER,
  cause TEXT CHECK(cause IN ('seed','change','ban','manual')), main TEXT /*json [{oracle_id,count}]*/, side TEXT,
  change TEXT /*json DeckChange incl. shape+reason+evidence, @mtg/shared deck-change.ts*/, created_at TEXT
);

cycles (
  id TEXT PK, run_id TEXT, number INTEGER, status TEXT, started_at TEXT, finished_at TEXT,
  deck_gen_a INTEGER, deck_gen_b INTEGER, matches_planned INTEGER, matches_done INTEGER,
  win_rate_a REAL, win_rate_b REAL, tiebreak INTEGER, loser TEXT,
  summary TEXT /*json: decidedBy, play/draw records, deck-level counts, what each deck showed, trial stats*/
);
matches (id TEXT PK, run_id TEXT, cycle_id TEXT, number INTEGER, kind TEXT CHECK(kind IN ('cycle','tiebreak','trial')),
         trial_candidate TEXT, winner TEXT, games_a INTEGER, games_b INTEGER, sideboarding TEXT /*json*/,
         detail BLOB /*the whole MatchResult, compressed: what a resumed cycle replays (ADR 0015)*/, detail_encoding TEXT);
games (
  id TEXT PK, match_id TEXT, number INTEGER, seed TEXT, chooser TEXT, on_play TEXT, winner TEXT, reason TEXT,
  turns INTEGER, decisions INTEGER, duration_ms INTEGER, event_log BLOB, log_encoding TEXT
);

card_stats (
  run_id TEXT, cycle_id TEXT, agent TEXT, oracle_id TEXT, zone TEXT, opponent_deck_gen TEXT,
  games INTEGER, games_drawn INTEGER, wins_drawn INTEGER, games_not_drawn INTEGER, wins_not_drawn INTEGER,
  cast_games INTEGER, dead_in_hand INTEGER, sum_turn_cast INTEGER, first_casts INTEGER,
  sum_impact REAL, impacts INTEGER, mulligan_blame INTEGER,
  -- opponent_deck_gen '*' is the card against every deck; a generation number is one matchup,
  -- and only the drawn/not-drawn columns mean anything on those rows
  PRIMARY KEY(run_id, cycle_id, agent, oracle_id, zone, opponent_deck_gen)
);
```

Indexes: `games(match_id)`, `matches(cycle_id)`, `cycles(run_id, number)`, `deck_generations(run_id, agent, generation)`, `card_stats(run_id, agent, oracle_id)`, `unsupported_requests(oracle_id)`.

The tables are declared once, in `apps/server/src/db/schema.ts` (drizzle); `pnpm db:generate` writes a migration under `apps/server/drizzle/` for a change there, and the server applies every migration when it opens the file. A test compares the migrated database with the schema, column by column. `cards` is filled at boot from the bulk JSONL whenever its version — `meta.json`'s `updatedAt` — differs from the one the rows carry in `scryfall_updated_at`, in one transaction (6.1); the API searches and names cards from it, while the simulation workers still read the JSONL directly.

Deck lineage is reconstructed from `deck_generations`; nothing is ever updated in place except `runs.status/current_cycle` and `cycles` progress counters.

## Event log format

`GameEventLog = { version, gameId, seed, players: { A: {deckGen, main, side}, B: ... }, events: GameEvent[] }`. Events carry a monotonic `seq`, `turn`, `step`, and compact payloads referencing object ids; a `objects` table at the head maps object id → oracle id + owner so the UI can render without the engine. Version bumps come with a migration in `packages/shared/src/eventlog/migrations.ts`; old logs are always readable.

Size: a typical game produces 300–1,500 events, ≈ 20–80 KB uncompressed, ≈ 5–15 KB compressed. A 100-match cycle is therefore ≈ 3 MB; a month-long run of 1,000 cycles ≈ 3 GB. A retention setting can drop event logs (not results/stats) older than N cycles; the run export offers "with logs / without logs".

## Resume protocol

The run driver (`driveRun`, `packages/sim/src/run.ts`) writes through a `RunStore` port; `SqliteRunStore` (`apps/server/src/db/run-store.ts`) is the port over these tables, one transaction per write. The driver runs on a simulation worker and the store in the API process, which serves it to the worker over a message port (5.7), so the API process is the only writer. The checkpoints:

1. **Cycle start** — a `cycles` row with status `running`, then, if a ban is pending or a deck breaks the list (after a ban between cycles, a fork, an import), the legalised decks as generations with `cause: 'ban'` and the trail with those edits applied after game `<cycleSeed>:start`.
2. **Every match** — the match row with its whole result (`detail`), its games with their logs, any generations a ban forced during it, and the ban trail as it stands.
3. **Cycle end** — the cycle's record (columns, `summary`, `card_stats`), the loser's changed deck as a generation with `cause: 'change'` — or none, and the deck agent's reason in the summary's `unchanged`, when it found nothing playable to change with (ADR 0017) — and the trail.

On restart, a run whose status is `running` is loaded; if it has a cycle in progress, that cycle is handed its stored matches and their logs and plays on from the next match number (match seeds are `<run seed>:cycle-<n>:match-<m>`, so a replayed match is identical). Its play/draw records and statistics are rebuilt from those matches, so the resumed cycle ends exactly where the one that never stopped would have (ADR 0015). **Trials are not stored**: they are replayed with the change, from the same seeds, to the same change. A run that is paused or stopped between two matches halts after the match in progress has been written.

The tests crash a run at every checkpoint — after a match is written, before it is, halfway through writing one, before the cycle is finished — close the database file, open it in a new store and resume, and compare the result with a run that never crashed.

## Export/import

`GET /runs/:id/export` streams a JSON bundle; `POST /runs/import` recreates a run (as a new id) from a bundle, including its ban history and deck lineage; games are optional. This is also the backup mechanism.

As built (5.6; the routes are phase 6's): `exportRun` makes the bundle — `{ format: 'mtg-1v1-run', version: 1, exportedAt, snapshot, matches, decklists }`, the snapshot being the run, its lineage, ban trail, finished cycles and the cycle in progress, with every match's result and, if asked, its games' logs, and a plain-text decklist per generation keyed `A-0`, `B-3` and so on. `importRun` refuses a format or version it does not know, and recreates the run under a new id, **paused**, so nothing starts playing until someone says so. `forkRun` copies a run as it stood at the end of a finished cycle: the generations made up to and in it, its cycle records, and the whole ban trail, under a new id and seed.
