# Working notes for Claude

Read [README.md](README.md) for what this project is and `docs/` for how it is meant to
work. `docs/10-roadmap.md` is the task board and the source of truth for what is done;
its **Working agreement** section holds the codebase rules (ADRs for changed decisions,
never hard-code a card name, determinism through the injected RNG). Those apply here too
and are not repeated below.

## Commands

```bash
pnpm check           # lint, typecheck, test, build — the same gate CI runs
pnpm test            # vitest
pnpm format          # biome check --write (run before committing; lint is --error-on-warnings)
pnpm dev             # server + web with HMR
pnpm bench           # engine benchmarks; --json writes a report, --budget sets the ms/game ceiling
pnpm bench:compare   # compare two benchmark reports; fails on a >20% regression
pnpm ladder          # the sanity ladder: search > greedy > random, 500 games a rung (nightly)
pnpm tune            # weight tuning: `compare a.json b.json`, or `climb` from a weights file
pnpm cards:schema    # regenerate the card-script JSON Schema; --check fails if it is stale
pnpm fetch:scryfall  # build data/scryfall/cards.jsonl from the bulk data
```

## How work happens here

Work arrives as "start phase N" against `docs/10-roadmap.md`. A phase is not finished
until **all** of the following are true:

1. `pnpm check` is green locally.
2. `docs/10-roadmap.md` marks the phase `[x]` with a note saying what landed, what was
   deliberately left, and which later phase closes it. Update the other docs wherever the
   phase changed what they describe, and write an ADR for any decision that departed from
   them.
3. The work is committed to the designated branch and pushed, and **every CI job is
   confirmed green on the new head** — by reading the check runs, not by assuming.
4. **The pull request's title and description are updated to match what the branch now
   contains.** Do this after every phase. A stale description on a large diff misleads
   whoever reads it, and this branch accumulates phases rather than opening a PR each
   time.

## Testing

Tests are expected to have teeth. For any rule with real logic behind it, **disable the
rule, confirm the matching tests fail, and restore it**. A test that passes either way
proves nothing, and this is the only way to know it would catch the bug it is named for.
Use a backup copy of the file rather than `git checkout` when doing this — `git checkout`
reverts to the last commit and will silently eat uncommitted work in the same file.

Cite Comprehensive Rules numbers (CR 613.8, CR 103.4b) in tests and comments where a rule
is being implemented, so a reader can check the engine against the actual rules.

## Shape of the engine

`packages/engine` is a pure state machine: `step(state, decision)`. It never blocks —
when a player must choose, `state.pendingDecision` describes the choice with its full list
of legal options and a driver answers. A game is therefore a pure function of its seed and
its decisions, which is what makes replay, AI lookahead and the fuzzer possible.

Three consequences that are easy to break by accident:

- **Never mutate a `GameState`.** Go through the helpers in `state/update.ts`, which bump
  `version` — the memoisation key for `characteristics()`. A mutation that skipped them
  serves stale characteristics.
- **Nothing changes state directly.** Build a `RulesEvent` and hand it to `runBatch`, so
  replacement effects get their say (ADR 0004).
- **Effects and abilities are data, never functions**, so they live in `GameState` and
  survive being cloned and replayed.

The engine has **zero third-party runtime dependencies** and no Node builtins; a test
asserts it and the tsup build (`platform: 'neutral'`) enforces it.
