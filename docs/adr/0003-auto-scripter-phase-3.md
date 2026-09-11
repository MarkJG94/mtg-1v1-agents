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
   `supported`. The sandbox that built this phase has no access to api.scryfall.com, so the figures
   measurable here are the corpora: 35 of the 37 golden-corpus cards and 87 of the 98 hand-scripted
   bootstrap cards are reached by the grammar alone. `pnpm cards:coverage` produces the real figure on a
   networked machine and the nightly `cards-coverage` workflow publishes it. The first such run (parser
   version 1, 30 816 base-pool cards) reported **12.8% supported**; see the addendum below.

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


## Addendum — the first full-Scryfall run (parser version 2)

Parser version 1 scored 12.8% of 30 816 base-pool cards. The top failing patterns were dominated by one
thing: **Scryfall's 2024 templating update**, which replaced most self references in Oracle text with
"this creature" / "this artifact" / "this land". The grammar only knew the card's own name, so the subject
of most triggers, static abilities and activation costs was unreadable — roughly 2 800 cards across
"when this creature enters, …" (six separate patterns), "this land enters tapped", "cost: this artifact",
"whenever this creature deals combat damage", and "this creature can't be blocked".

The same drift was silently breaking the bootstrap set: only 67 of the 98 hand scripts still validated,
because their `text:` fields were written against the old templating and no longer matched the entry
Scryfall serves.

Parser version 2 changes:

1. **`replaceSelfReferences` in the normaliser** folds "this creature"/"this artifact"/… to `~`, alongside
   the existing name replacement, exactly as docs 03 step 1 specifies. Because the validator normalises
   both the script's text and Scryfall's before comparing them, this repairs the hand-script drift as a
   side effect: the two spellings become the same string. `packages/cards/test/auto-templating.test.ts`
   rewrites every fixture card into the current templating and asserts the emitted script is unchanged.
2. **"Activate only as a sorcery."** sets `timing: 'sorcery'` on the ability above it instead of being
   read as a static sentence about a creature type called "Activate" (371 cards).
3. **Keyword abilities the engine cannot play** (cycling, kicker, modular, echo, …) are named in the
   failure rather than blamed on whichever rule tripped over the cost after the word (≈ 600 cards of
   misleading `static: 1` / `static: {2}` patterns).
4. **More beginning-of-step triggers**: each opponent's and each player's upkeep and end step, each combat.
5. **Sentence-initial durations** ("Until end of turn, target creature gains flying").
6. **Return-to-hand from a graveyard** as a zone change rather than a bounce.
7. **Modal spells name the mode that failed** instead of reporting `effect: choose one —`, which hid the
   real gap on 285 cards.
8. **Failures are reported from the cursor, not the furthest token any rule reached.** A rule that
   speculatively consumed the unknown word and rewound was hiding the very word the report needed to name.

`AUTO_SCRIPTER_VERSION` is 2, which invalidates every cached auto script.


## Addendum — the second run (parser version 3)

Version 2 scored **17.8%** (5 488 of 30 816), up from 12.8%, and returned 88 of the 98 hand scripts to
`supported`. The next round of patterns split into three kinds.

**A regression the report caught.** Normalising "this spell" to `~` broke the classifier rule for
`As an additional cost to cast this spell, …`, which still matched on the pre-normalised spelling — 243
cards lost to a fix made two hours earlier. The classifier and the parser now accept both spellings. This
is the argument for running the report after every grammar change rather than trusting the corpora: the
fixtures were all green while a quarter of a percent of Magic quietly stopped parsing.

**Trigger clauses that were parsed but not finished** (`trigger: missing comma in …`, 649 cards across
three patterns). The event matched a prefix and the qualifier after it was left on the cursor. Added, each
as an exact reading rather than a discarded qualifier: `enters the battlefield under your control` (and
under an opponent's), `deals damage to a player`/`to an opponent`, `deals combat damage`, and the whole
`Whenever you cast …` / `an opponent casts …` family (216 cards), which had no rule at all.

**Templates with a cheap exact reading**: `This ability triggers only once each turn.` sets `oncePerTurn`
on the ability above it (113); a trailing `, where X is the number of …` substitutes into the `x` the
clauses already emitted (112); the search template's `reveal it, put it into your hand` step failed only
because the comma is its own token (101); and `Return ~ from your graveyard to the battlefield` names its
origin before its destination (97).

Left unread on purpose, because each needs engine work rather than grammar: kicker, cycling, flashback and
devoid (646 across four patterns), characteristic-defining power/toughness (219), copy effects with new
targets (104), and modal *abilities* — `modes` exists only on `kind: spell`, so "At the beginning of your
end step, choose one —" cannot be represented at all (119).

`AUTO_SCRIPTER_VERSION` is 3.
