# 06 — Data model and persistence

SQLite (`data/mtg.db`, WAL, `synchronous=NORMAL`), accessed through drizzle-orm from the API process only. Event logs are stored as compressed JSON blobs (zstd via `@mongodb-js/zstd` or gzip fallback) because they are write-once, read-rarely, and large.

## Tables

```sql
cards (                      -- projection of Scryfall bulk data, rebuilt on fetch
  oracle_id TEXT PK, name TEXT, mana_cost TEXT, mana_value REAL, colors TEXT, color_identity TEXT,
  type_line TEXT, oracle_text TEXT, power TEXT, toughness TEXT, loyalty TEXT, keywords TEXT,
  layout TEXT, legal_base INTEGER, preferred_printing_id TEXT, image_uri TEXT, scryfall_updated_at TEXT
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
ban_events (id INTEGER PK, run_id TEXT, oracle_id TEXT, action TEXT, note TEXT, at TEXT, applied_after_game_id TEXT);

deck_generations (
  id TEXT PK, run_id TEXT, agent TEXT CHECK(agent IN ('A','B')), generation INTEGER, cycle INTEGER,
  cause TEXT CHECK(cause IN ('seed','change','ban','manual')), main TEXT /*json [{oracle_id,count}]*/, side TEXT,
  change TEXT /*json DeckChange incl. shape+reason+evidence, @mtg/shared deck-change.ts*/, created_at TEXT
);

cycles (
  id TEXT PK, run_id TEXT, number INTEGER, status TEXT, started_at TEXT, finished_at TEXT,
  deck_gen_a TEXT, deck_gen_b TEXT, matches_planned INTEGER, matches_done INTEGER,
  win_rate_a REAL, win_rate_b REAL, tiebreak INTEGER, loser TEXT, summary TEXT /*json deck-level stats*/
);
matches (id TEXT PK, run_id TEXT, cycle_id TEXT, number INTEGER, kind TEXT CHECK(kind IN ('cycle','tiebreak','trial')),
         trial_candidate TEXT, winner TEXT, games_a INTEGER, games_b INTEGER, sideboarding TEXT /*json*/);
games (
  id TEXT PK, match_id TEXT, number INTEGER, seed TEXT, on_play TEXT, winner TEXT, reason TEXT,
  turns INTEGER, decisions INTEGER, duration_ms INTEGER, event_log BLOB, log_encoding TEXT
);

card_stats (
  run_id TEXT, cycle_id TEXT, agent TEXT, oracle_id TEXT, zone TEXT, opponent_deck_gen TEXT,
  games_drawn INTEGER, wins_drawn INTEGER, games_not_drawn INTEGER, wins_not_drawn INTEGER,
  cast_games INTEGER, dead_in_hand INTEGER, sum_turn_cast INTEGER, sum_impact REAL, mulligan_blame INTEGER,
  PRIMARY KEY(run_id, cycle_id, agent, oracle_id, zone, opponent_deck_gen)
);
```

Indexes: `games(match_id)`, `matches(cycle_id)`, `cycles(run_id, number)`, `deck_generations(run_id, agent, generation)`, `card_stats(run_id, agent, oracle_id)`, `unsupported_requests(oracle_id)`.

Deck lineage is reconstructed from `deck_generations`; nothing is ever updated in place except `runs.status/current_cycle` and `cycles` progress counters.

## Event log format

`GameEventLog = { version, gameId, seed, players: { A: {deckGen, main, side}, B: ... }, events: GameEvent[] }`. Events carry a monotonic `seq`, `turn`, `step`, and compact payloads referencing object ids; a `objects` table at the head maps object id → oracle id + owner so the UI can render without the engine. Version bumps come with a migration in `packages/shared/src/eventlog/migrations.ts`; old logs are always readable.

Size: a typical game produces 300–1,500 events, ≈ 20–80 KB uncompressed, ≈ 5–15 KB compressed. A 100-match cycle is therefore ≈ 3 MB; a month-long run of 1,000 cycles ≈ 3 GB. A retention setting can drop event logs (not results/stats) older than N cycles; the run export offers "with logs / without logs".

## Resume protocol

Workers post `matchCompleted` messages with results and logs; the API process writes them in one transaction. The `cycles.matches_done` counter is the checkpoint. On restart: for every run with status `running`, reload the current cycle, count completed matches, and resume from the next match number (match seeds are `hash(run.seed, cycle, matchNumber)` so replayed matches are identical). Trial batches and legalisations are checkpointed the same way (`matches.kind`).

## Export/import

`GET /runs/:id/export` streams a JSON bundle; `POST /runs/import` recreates a run (as a new id) from a bundle, including its ban history and deck lineage; games are optional. This is also the backup mechanism.
