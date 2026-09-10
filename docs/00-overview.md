# 00 — Overview

## What we are building

A self-contained system that:

1. Simulates Magic: The Gathering matches between two automated agents using a custom, rules-accurate engine.
2. Runs an evolutionary loop: both agents start with the same 75 (60 main + 15 sideboard); every cycle of N best-of-three matches the losing agent makes one change to its 75; the run continues until paused or stopped.
3. Lets a human intervene at any time by banning or restricting cards for a run; agents must then legalise their decks before play continues.
4. Records every game as an event log so any game can be replayed visually in the browser, and the currently running game can be watched live.
5. Draws its cards from the entire Scryfall database: the seed deck is random, and replacements are found by searching Scryfall. A data-driven card-script format and an oracle-text auto-scripter decide, card by card, what the engine can play; coverage grows as the parser and hand-written scripts grow.

## Goals

- Rules accuracy: results must be trustworthy enough that deck evolution reflects real card strength, not engine bugs. This is why testing is a first-class concern.
- Throughput: hundreds of games per minute per CPU core so that a 200-match cycle finishes in minutes, not hours.
- Determinism: any game is reproducible from `(run seed, cycle, match, game)` so bugs can be replayed and fixed.
- Unattended operation: the server runs for days in Docker on a homelab, survives restarts, and resumes from the last completed cycle.
- Observability: card-level statistics, deck lineage, and coverage dashboards make the evolution explainable.

## Non-goals (for now)

- Multiplayer formats, Commander, or anything other than 1v1.
- Human-vs-agent play (the UI is a viewer and control panel, not a game client). The engine is designed so a human-input adapter could be added later.
- Perfect play. The agents should be competent, consistent, and fast; brilliance is a later concern.
- Reproducing the exact Legacy or Vintage banned lists. The ban console is a tool for the operator; it starts empty.

## Decisions log

These were settled at planning time and the rest of the docs assume them.

| # | Decision | Choice | Notes |
| --- | --- | --- | --- |
| D1 | Rules engine | Custom TypeScript engine | Wrapping Forge/XMage rejected: no browser-side reuse, poor control over AI and stats. |
| D2 | Card coverage | Incremental, all cards eventually | Full Scryfall DB loaded; only scripted cards are playable; unscripted cards are visible as "unsupported". |
| D3 | Card scripting | Data-driven scripts + auto-scripter from oracle text | A small hand-written bootstrap set exercises the engine; the parser is the main path to coverage; validation suite flags cards needing review; hand scripts are prioritised by demand from runs. |
| D4 | Card pool | All of Scryfall from day one, gated by scripting | No curated pool. Any card the auto-scripter (or a hand script) can support is eligible; unsupported cards are skipped and logged for manual scripting. A small hand-scripted set exists only to guarantee basics, common keywords and the parser's building blocks. |
| D5 | Play AI | Heuristic evaluation + shallow search / rollouts | No LLM in the play loop; fast and seedable. |
| D6 | Deck-change AI | Statistical heuristic, behind an interface | LLM chooser can be plugged in later. |
| D7 | Change size | One slot per cycle (all copies), across the 75 | Main↔main, side↔side, or move a slot between main and side; totals stay 60/15. |
| D8 | Match format | Best-of-three with 15-card sideboard | AI sideboards using per-opponent card statistics. |
| D9 | Cycle | N matches per cycle, run until stopped | Play/draw alternates; N configurable. |
| D10 | Ties | Tiebreak batch, then seeded coin flip | Margin configurable. |
| D11 | Reverts | Allowed; no anti-convergence rule | Identical decks is a legitimate outcome. |
| D12 | Bans | Vintage semantics, applied immediately | Banned = 0 copies, restricted = max 1. Applied after the current game; legalisation is a forced extra change. |
| D13 | Runs | Multiple concurrent runs, ban list per run | Runs can be paused, resumed, forked, exported. |
| D14 | Runtime | Node backend + browser frontend | Simulation on the server; browser is viewer and control plane. |
| D15 | Stack | TS monorepo, Fastify + WS, React + Vite, SQLite | pnpm workspaces; Docker Compose for the homelab. |
| D16 | Card data | Scryfall bulk data at build time, images cached lazily by the server | Container needs outbound HTTPS to api.scryfall.com / cards.scryfall.io only for image cache misses. |
| D17 | Seed deck | Constrained random from all of Scryfall | 1–3 random colours, ~22–26 lands, max 4 per name, all nonland cards castable in the chosen colours; everything else is dice. Unsupported draws are re-rolled. |
| D17b | Replacement search | Filtered Scryfall shortlist + on-demand scripting + trial stats | Filter by legality/bans/castability/mana-value band, rank by a static quality model plus prior stats, script top K on demand, optionally trial the top 3. |
| D18 | v1 rules scope | Full stack, evergreen combat keywords, real Eternal mana bases, planeswalkers, layer system | Planeswalkers/layers are the largest single item; see roadmap ordering. |
| D19 | Testing | Thorough | Subsystem units, per-card scenarios, seeded regression games, invariant fuzzing, GitHub Actions. |
| D20 | Repo | Git in `D:\MTG Eternal 1v1 Agents` (folder name predates the rename), pushed to GitHub as `mtg-1v1-agents` | |
| D21 | First milestone | End-to-end thin slice | Engine core, hand-scripted bootstrap set, random seed deck, AI, one cycle with a Scryfall replacement search, replay viewer, bans — all wired and tested. |

## Glossary

- **Run**: one evolutionary experiment: seed deck, settings, seed, ban list, and the sequence of cycles.
- **Cycle**: N matches between the two agents' current decks, followed by evaluation and (usually) one deck change.
- **Match**: best-of-three games with sideboarding between games.
- **Game**: one game of Magic, recorded as an event log.
- **Slot**: all copies of one card name in one zone of the 75 (main or side).
- **Supported card**: a card with a script that passes validation and can be played by the engine.
- **Legal card** (per run): a supported card that is not banned; restricted cards are legal at one copy.
