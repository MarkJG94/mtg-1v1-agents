# ADR 0001 — Engine core: decisions made during Phase 1

- Status: accepted
- Date: 2026-09-10

## Context

Phase 1 implemented `packages/engine` against docs 01, 02 and 09. A few points in those docs were
underspecified or turned out to be better done differently; this records them so the docs and the
later phases agree with the code.

## Decisions

1. **Layer 7 sublayers follow the current Comprehensive Rules** (613.4): 7a characteristic-defining
   abilities, 7b set P/T, 7c modify P/T including counters, 7d switch. Doc 02 listed the older
   numbering ("7a set, 7b modify, 7c counters"). Card scripts use `setPT` with `cda: true` for 7a.

2. **The resumable interpreter uses explicit frames, not generators.** `GameState.frames` is a stack of
   plain data records (cast/activate stages, effect lists with an index, combat sub-steps, trigger
   placement). A frame that needs a player choice sets `pendingDecision` and is re-entered with the
   answer. This keeps the state serialisable and cheap to copy for search.

3. **Structural sharing** is done by `beginDraft`/`finishDraft`: top-level containers are shallow-copied
   per `step()`, `GameObject`s are copied on first write. Characteristics are memoised per draft and
   invalidated explicitly where characteristic-relevant fields change (zone moves, counters, effects,
   attachments, control). Tapping, damage and similar do not invalidate.

4. **Object identity is stable across zones** (one numeric id per card for the whole game) with an
   `instance` counter incremented on every zone change. References (`targets`, effect `affected` sets,
   delayed-trigger bindings) carry `{id, instance}` and stop matching once the object is "new"
   (CR 400.7). This keeps event logs and tests readable while preserving the rule.

5. **Replacement-effect ordering** when several apply to one event: self-replacement first, then by
   timestamp. The `chooseReplacement` decision exists in the type but is not raised in v1; it can be
   added without changing the state model.

6. **Legend rule** keeps the most recent permanent automatically instead of asking the controller.
   Same-name legendaries under one controller are rare in random decks; a decision can be added later.

7. **Mana payment is automatic**: the solver (exact bipartite matching with an exhaustive fallback over
   sources, preferring fewer taps and less flexible sources) pays every cost. `payMana` decisions are
   typed but not raised. Explicit `activateMana` actions let an agent float mana deliberately.

8. **Dependency between layer effects** (613.8) is detected by simulation: A depends on B when applying
   B alone changes A's affected set or whether A's ability still exists. Mutual dependencies fall back
   to timestamp order. Static abilities that started applying keep applying in later layers even if the
   ability is later removed (613.6), which is what makes Humility + Opalescence come out right.

9. **Simultaneous zone changes** (`destroyAll`, `exileAll`, Wrath effects) go through `moveObjects` so
   every leaves-the-battlefield trigger sees all the moved objects with last known information.

10. **Loop detection** hashes the game state at priority only after a turn has seen more than 60
    priority decisions; 40 repeats of one hash within a turn end the game as a draw (`loop`).

## Consequences

- Docs 02/03 should be read with (1) and (4) in mind; card scripts referencing layer 7 must use the
  current CR sublayers.
- The benchmark (`pnpm bench`) is ≈ 32 ms/game median with the random agent, which plays ≈ 870
  decisions and 34 turns per game because it rarely attacks. Per decision the engine costs ≈ 37 µs;
  the ≤ 5 ms/game target in roadmap 1.14 is left open. The profile is dominated by recomputing
  battlefield characteristics after invalidation, the mana solver inside `legalActions`, and state-based
  action scans; caching base characteristics per object and incremental legal-action updates are the
  next steps.
- Not yet modelled (tracked for Phase 7): "as enters" choices (colour/name), copy effects other than
  tokens, effects that modify spells on the stack, distribute-counters decisions, shocklands' "pay life
  or enter tapped" choice, infect/poison damage.
