# ADR 0003 — Auto-scripter: decisions made during Phase 3

- Status: accepted
- Date: 2026-09-11

## Context

Phase 3 implemented the oracle-text auto-scripter (`packages/cards/src/auto/`) against docs 03 and the
roadmap's 3.1–3.6. The pipeline is the one doc 03 describes — normalise, classify, parse, emit, validate —
but two parts of it were built differently from the plan, and the coverage target could not be measured in
the sandbox that built it.

## Decisions

1. **A hand-written scanner with explicit backtracking instead of a `peggy` PEG grammar.** Doc 03 §3 called
   for a generated parser. Magic templating is a bounded set of sentence templates rather than a recursive
   language, so the rules read better as functions over a token cursor: each rule consumes what it
   recognises and returns `null` to rewind (`Scanner.attempt`). This keeps the emitted structures fully
   typed against the engine's `Effect`/`AbilityDef` unions — a `.pegjs` file's semantic actions would be
   untyped — needs no build step or runtime grammar compilation, and lets a failing rule report the exact
   token it stopped on, which is what `pnpm cards:coverage` groups the top failing patterns by. The
   trade-off is that alternatives are ordered by hand in `CLAUSES`, so a new rule has to be placed where it
   cannot shadow an existing one; the golden corpus is the guard against that.

2. **One spell ability per card, not per sentence.** An instant or sorcery resolves once, so every sentence
   classified as spell text feeds a single `kind: spell` ability with shared bindings and a combined
   `covers` list. This is what makes "Look at target opponent's hand." + "Draw a card." one ability, and it
   is also how anaphora ("that creature", "it") reach across a sentence boundary.

3. **Anaphora is resolved with a two-level binding**: the most recent object and player (`it`, `that
   creature`, `that player`) live for the whole ability, while an *elided* subject ("Target player draws two
   cards **and loses 2 life**") carries only inside one sentence. Both are snapshot and restored when a
   clause backtracks, so a rule that half-matched never leaves a stray target behind.

4. **Silence is a failure, not a default.** A sentence the grammar cannot read is recorded with the rule
   that gave up and the text it stopped on, and the whole card comes back `null`; nothing is dropped
   quietly. Together with the Phase 2 text-coverage rule this means a script is only emitted when every
   sentence was claimed. The residual risk is a rule that reads a sentence *wrongly* rather than not at all
   (the grammar cannot know it misread "artifact, creature, or land" as two types); the golden corpus in
   `packages/cards/test/fixtures/auto-corpus.json` pins the exact emitted structures for every template the
   grammar claims, which is the only defence against that.

5. **Keyword cross-check against Scryfall's `keywords` array.** If Scryfall lists an evergreen keyword the
   script did not produce, the card is rejected rather than played without it.

6. **Characteristics the grammar refuses outright**, because only a hand script can express them: non-normal
   layouts, multi-faced cards, characteristic-defining power/toughness (`*`), and non-numeric loyalty.

7. **Coverage is reported, not asserted, against Scryfall.** Roadmap 3.6 targets ≥ 25% of Scryfall
   `supported`. The sandbox that built this phase has no access to api.scryfall.com, so the number in the
   roadmap is the one measurable here: 35 of the 37 golden-corpus cards and 87 of the 98 hand-scripted
   bootstrap cards are reached by the grammar alone. `pnpm cards:coverage` produces the real figure on a
   networked machine and the nightly `cards-coverage` workflow publishes it; the roadmap will be updated
   from that run rather than from an estimate.

8. **Smoke games stay opt-in in the coverage run.** The executability smoke test costs roughly a second per
   card, which is fine for 135 fixture cards and not for 30 000; `pnpm cards:coverage` defaults to schema,
   agreement and text coverage, with `--smoke` (and `--limit`) for a sampled deeper run. The golden corpus
   test always runs the smoke games.

## Grammar v1 scope

Reached: keyword lines and protection; vanilla and French-vanilla creatures; mana abilities including
"any color" and choices; activated abilities with compound costs (mana, tap, sacrifice, pay life, discard,
exile from graveyard); `Equip {N}`; `Enchant <object>`; loyalty abilities; ETB/dies/attacks/blocks/tapped/
landfall/upkeep/end-step/life-gain/damage triggers; burn, pump, keyword granting, counters, tokens, bounce,
tap/untap, scry/surveil, draw/discard/mill, life gain and loss, destroy/exile (single and mass), counter
spells with "unless … pays", fight, gain control, regenerate, search-and-shuffle, Fog, prevention shields,
modal spells ("Choose one —"), additional costs, anthems, "can't attack/block/be blocked", `doesntUntap`,
added and replaced subtypes, max hand size, extra land drops, cost increases, "enters tapped [unless …]",
and "as long as" conditions.

Not reached, in rough order of how often they blocked a corpus card: characteristic-defining P/T, "equal to
its power / its mana value" quantities, reveal-and-put-into-hand, replacement effects over counters,
"except by", "alone", "N or fewer", and modal text with modes the effect grammar does not cover. These are
what the coverage report's top failing patterns should drive next.

## Consequences

- `PARSER_VERSION` in `packages/cards/src/resolver.ts` stays the fallback for "no auto-scripter"; the
  grammar carries its own `AUTO_SCRIPTER_VERSION` (1), which is what the cache keys on. Any grammar change
  that could alter an emitted script must bump it.
- `docs/03` §Auto-scripter step 3 now describes a scanner rather than a PEG; the rest of the pipeline is
  unchanged.
