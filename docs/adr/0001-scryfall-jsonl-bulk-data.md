# ADR 0001 — Scryfall bulk data is gzipped JSONL, and the projection is JSONL too

- Status: accepted
- Date: 2026-09-13

## Context

Decision D16 and the data-flow diagram in [01-architecture](../01-architecture.md) assume
`scripts/fetch-scryfall.ts` downloads a JSON **array** to `data/scryfall/oracle-cards.json`.
Scryfall's bulk-data API no longer offers one: an `oracle_cards` entry now carries
`jsonl_download_uri` and `compressed_size` (gzipped JSON Lines, one card per line) where it
used to carry `download_uri` and `size`. The first implementation of the fetcher was written
to the documented shape and failed at runtime with `Failed to parse URL from undefined`.

Two further things showed up while projecting the real file:

- The uncompressed bulk file is several hundred MB. `JSON.parse` on the whole array is
  wasteful when every card is handled independently.
- Art series, tokens, emblems, schemes, vanguards, Jumpstart theme dividers and similar
  game pieces all carry an `oracle_id`, so they arrive looking like cards. Without a filter
  the pool holds three objects named "Lightning Bolt", only one of them a spell.

## Decision

1. Read `jsonl_download_uri` / `compressed_size` from the bulk-data index.
2. Stream the whole pipeline: download → gunzip → parse one line → project → append. Nothing
   holds the full card set in memory.
3. Write the projection as **JSONL** to `data/scryfall/cards.jsonl` (plus `meta.json`
   recording `updatedAt`, `fetchedAt`, the card count and the source URI), rather than as a
   JSON array at `oracle-cards.json`. The gzipped download is deleted after projection
   unless `--keep-raw` is passed; `meta.json` lets a re-run skip the download entirely.
4. Skip layouts that are never a deckable card: `art_series`, `augment`,
   `double_faced_token`, `emblem`, `front_card`, `host`, `planar`, `scheme`, `token`,
   `vanguard`. None is legal in any constructed format, so nothing playable is lost — the
   vintage-legal count is 31,690 either way — and card names become usable as identifiers
   again. The projection drops from 38,753 rows to 34,689.

## Consequences

- `CardDatabase` (phase 2) loads `cards.jsonl` line by line and can stream or index lazily
  instead of parsing one large array. The data-flow diagram in 01-architecture now names
  `cards.jsonl`; the `oracle-cards.json` path is gone.
- Skipping by layout is a filter on *what Scryfall calls a card*, not on what the engine can
  play. Card coverage (D2/D4) is unaffected: unsupported cards are still those the
  auto-scripter cannot script, and are still logged as such.
- If Scryfall reinstates a plain-JSON download, nothing needs to change; the fetcher fails
  loudly with "the API has changed" if `jsonl_download_uri` ever disappears.
