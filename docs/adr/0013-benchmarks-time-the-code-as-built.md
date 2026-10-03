# ADR 0013 — Benchmarks time the code as it is built, not as `tsx` runs it

- Status: accepted
- Date: 2026-09-25

## Context

Every benchmark number in this repository before roadmap 4.8 was taken by running the
TypeScript sources through `tsx`: `pnpm bench` was `tsx packages/engine/bench/run.ts`, and
the ladder's per-decision costs came the same way. docs/02's targets — a median game in
5 ms with a trivial agent, 50 ms at `search` — are about engine time, which is the time
the built code takes.

`tsx` compiles with esbuild's `keepNames`, which wraps every function it defines in a
call that gives it a name. For a top-level function that happens once. For a closure made
inside a function — a `filter` callback, a comparator, a lambda handed to a helper — it
happens every time the enclosing function runs, and the engine and the agents make such
closures in their hottest paths. A CPU profile of a searched game under `tsx` shows the
`__name` helper by name in several files. The build the project ships, tsup, does not set
`keepNames`.

Measured on the same machine, the same games and the same code, bundled without
`keepNames` against run under `tsx`:

| benchmark | under `tsx` | as built |
|---|---:|---:|
| engine, baseline, median | 4.7–4.9 ms | 3.7–3.9 ms |
| engine, long game, median | 4.7–5.3 ms | 4.1–4.2 ms |
| search, both players, median | ~100 ms | ~85 ms |

About a fifth of every number was the transform, and it was the difference between
roadmap 4.2's 5.2 ms and its 5 ms budget: the engine as it stood before 4.8, bundled, plays
the baseline in 4.0–4.3 ms.

## Decision

Benchmarks run on the code as it is built. `scripts/run-bundled.ts` bundles a script with
esbuild — `keepNames` off, every workspace package inlined, as tsup would — and runs the
bundle with plain node. `pnpm bench`, `pnpm bench:search`, `pnpm ladder` and `pnpm tune`
all go through it; the last two because they play thousands of games, and a fifth of that
is minutes. esbuild is a root dev dependency for it, at the version tsup already uses.

## Consequences

- Numbers recorded before 4.8 are not comparable with numbers after it; the docs that
  quote them say which they are. The CI regression gate compares a run with the last one
  recorded on `main`, which has none yet, so no baseline has to be migrated.
- Roadmap 4.2's budget is met on the code as built, and is ticked with a note saying how
  much of the change was the measurement rather than the engine.
- A benchmark now times what a deployment runs. It no longer times what a developer sees
  running tests under vitest or scripts under `tsx`; those are slower by the same fifth.
- Running a benchmark file directly with `tsx` still works and still reads slow; the
  benchmark headers say so.
