# 03 — Card scripts and the auto-scripter

Cards are data, not code. A **card script** is a YAML/JSON document that describes a card's characteristics and abilities in a small, closed vocabulary the engine understands. Hand-written scripts and auto-generated scripts share one schema, one validator, and one loader.

## Sources of truth

1. **Scryfall bulk data** (`oracle-cards` bulk file, one entry per oracle id) supplies name, mana cost, colours, colour identity, type line, oracle text, power/toughness/loyalty, keywords list, legalities, layout, image URIs, and set/rarity. It is fetched by `pnpm fetch:scryfall` into `data/scryfall/` and is never edited.
2. **Hand scripts** in `packages/cards/scripts/<first-letter>/<slug>.yaml`, keyed by oracle id. These win over auto-generated scripts.
3. **Auto scripts** produced by the parser at request time and cached in the `card_scripts` table together with the parser version and validation result. Bumping the parser version invalidates the cache.

`ScriptResolver` (roadmap 2.4) is what walks those three in order: a hand script wins, then a cached verdict *reached by the version that is running now*, then the auto-scripter, and otherwise the card is unsupported and the request is logged. Whatever the answer, it is cached — including "unsupported", because re-running a parser and a smoke test for a card that was unplayable an hour ago is the cost the cache exists to avoid. A **partial script is never played**; it is logged like any other card the run could not have.

The cache and the log are ports (`ScriptStore`), shaped exactly like docs/06's `card_scripts` and `unsupported_requests` rows. An in-memory implementation runs today; the SQLite one arrives with the server's persistence in phase 5 and the resolver does not change. The auto-scripter is likewise a port: until phase 3 builds it, the resolver simply has no third step, which is a legitimate configuration — everything outside the bootstrap set is unsupported and says so.

Card identity everywhere in the system is the Scryfall **oracle id** (stable across printings); the UI resolves an oracle id to a preferred printing for images.

## Script schema (abridged)

```yaml
oracleId: 4457ed35-7c10-48c8-9776-456485fdf070
name: Lightning Bolt
manaCost: "{R}"
types: [instant]
text: "Lightning Bolt deals 3 damage to any target."
abilities:
  - kind: spell
    targets: [{ id: t, filter: any }]              # any = creature|player|planeswalker|battle
    effects:
      - { op: damage, amount: 3, to: $t }
```

```yaml
name: Tarmogoyf
manaCost: "{1}{G}"
types: [creature]
subtypes: [lhurgoyf]
power: "*"
toughness: "*+1"
abilities:
  - kind: static
    layer: 7a
    setPT:
      power: { count: cardTypesInAllGraveyards }
      toughness: { add: [{ count: cardTypesInAllGraveyards }, 1] }
```

```yaml
name: Counterspell
manaCost: "{U}{U}"
types: [instant]
abilities:
  - kind: spell
    targets: [{ id: t, filter: { zone: stack, type: spell } }]
    effects: [{ op: counter, target: $t }]
```

```yaml
name: Jace, the Mind Sculptor
manaCost: "{2}{U}{U}"
types: [planeswalker]
loyalty: 3
abilities:
  - { kind: loyalty, cost: +2, targets: [{ id: p, filter: player }],
      effects: [{ op: lookAtTop, player: $p, count: 1 },
                { op: mayPutOnBottom, player: $p, chooser: controller }] }
  - { kind: loyalty, cost: 0, effects: [{ op: draw, count: 3 }, { op: putFromHandOnTop, count: 2 }] }
  - { kind: loyalty, cost: -1, targets: [{ id: c, filter: creature }], effects: [{ op: moveZone, target: $c, to: ownersLibraryTop }] }
  - { kind: loyalty, cost: -12, targets: [{ id: p, filter: player }],
      effects: [{ op: exileZone, player: $p, zone: library }, { op: shuffleHandIntoLibrary, player: $p }] }
```

### Vocabulary

- **Ability kinds**: `spell`, `static`, `triggered`, `activated`, `mana`, `loyalty`, `keyword` (a keyword expands to its rules definition at load time), `replacement`, `costModifier`.
- **Triggers**: `etb`, `ltb`, `dies`, `cast`, `attacks`, `blocks`, `becomesBlocked`, `dealsDamage`, `dealtDamage`, `upkeep`, `draw`, `endStep`, `beginCombat`, `landfall`, `counterPlaced`, `sacrificed`, `tapped`, plus `condition` (intervening-if) and `once: perTurn`.
- **Effect ops** (closed set, ~120 planned; each is implemented once in the engine): `damage`, `gainLife`, `loseLife`, `draw`, `discard`, `mill`, `counter`, `destroy`, `exile`, `moveZone`, `bounce`, `sacrifice`, `tap`, `untap`, `createToken`, `addCounters`, `removeCounters`, `pump` (until-EOT P/T), `grantAbility`, `loseAbility`, `setPT`, `gainControl`, `search`, `shuffle`, `reveal`, `lookAt`, `scry`, `surveil`, `addMana`, `copySpell`, `extraTurn`, `preventDamage`, `regenerate`, `fight`, `attach`, `transform`, `choose`, `forEach`, `if`, `unless` (e.g. "unless that player pays"), `sequence`, `may`, `delayedTrigger`, `createEffect` (continuous, with duration).
- **Filters** are structured predicates: `{ type, subtype, supertype, colour, controller: you|opponent|any, zone, tapped, mvLTE, powerGTE, hasKeyword, isToken, name, not, and, or }`.
- **Quantities** are numbers or expressions: `{ count: <selector> }`, `{ x }`, `{ add|mul|sub }`, `{ devotion: colour }`, `{ lifeTotal }`, `{ cardsInHand }`, etc.
- **Targets** declare id, filter, count (`1`, `upTo: 2`, `any`), and `distinct` flags; the engine validates targets on cast and on resolution.

The schema is enforced with zod (`packages/cards/src/schema.ts`), which also generates JSON Schema for editor completion in YAML files — `pnpm cards:schema` writes `packages/cards/schema/card-script.schema.json`, and CI fails if the committed file has drifted from the schema.

### What is implemented (roadmap 2.1)

The vocabulary above is the target; this is where it stands.

- **39 effect ops**, each implemented once in `packages/engine/src/cards/effects.ts`, every one of them proposing `RulesEvent`s so replacement effects apply without either side knowing about the other. `packages/cards/src/ops-spec.ts` is the table of what each op takes, and is what the loader converts against and the validator will check.
- **Ops that need a player choice mid-resolution were not among them**: `search`, `scry`, `surveil`, `may`, `choose` (modal), `unless ... pays`, and a discard the player picks. They needed the effect list to pause and resume the way a replacement batch does. That machinery landed in 7.1 (ADR 0021) with `may` and `discard`; the rest are each a new op on it, not yet written.
- **Seven ability kinds** — spell, triggered, activated, static, mana, loyalty, replacement. A keyword line is expanded into the engine's keywords at load time, as the vocabulary says.
- **Dynamic characteristics are not there yet**: a static ability sets power and toughness to fixed numbers, so a card whose P/T counts something (the `*`/`*+1` example above) waits for quantity-valued layer changes.
- Filters and quantities are written in the short forms above (`filter: any`, `to: $t`, `{ type: creature, controller: opponent }`) and the loader turns them into the engine's tagged unions. An object with several keys reads as "all of these at once".

The loader checks what a shape check cannot: that every op exists, that it has the arguments it needs and none it does not, that a `$target` was actually declared by the ability that mentions it, and that a `when`, an `affects` or a `change` names something the engine really has — all against the engine's own exported lists, so the two can never drift.

## Tags (roadmap 4.6)

`cardTags(definition)` in `packages/cards/src/tags.ts` reads two lists off a script for the sideboarding agent (docs/04). **`is`** — what the card is: its card types, `spell` for every nonland card, and the roles its ops give it: `burn` (damage that can go to a player), `counterspell`, `lifegain`, `graveyard` (returns cards from one). **`vs`** — what it answers: the kinds its removal-shaped ops (destroy, exile, bounce, damage, fight, gain control, a toughness-lowering pump, counter) can be pointed at, as the filters of their targets or their `forEach` say. `and` keeps what every part allows, `or` what any part does, a filter confined to the controller's own things answers nothing, and "noncreature" excludes creatures. Gaining life answers `burn`, split second answers `counterspell`, and exiling from a graveyard answers `graveyard`. Tags are as good as the script: they are read from the definition, never from the card's name. The vocabulary (`CardKind`) lives in `@mtg/shared`, because the agents that read the tags may not import this package.

## Validation

`validateScript(script, scryfallCard)` runs four checks and returns one of three verdicts.
The difference between the verdicts is the point:

- **unsupported** — the script is wrong: it does not load, it disagrees with the printed
  card, or the engine falls over when the card is played. Nothing plays it.
- **partial** — the script is right about what it does but does not do everything the card
  says. Partial scripts are never played; they are listed so somebody can finish them.
- **supported** — loads, agrees, claims every sentence, and survives being played.

The checks:

1. **It loads.** The schema, and then the loader's own checks: every op exists, has the
   arguments it needs and none it does not, every `$target` was declared, and every
   `when`/`affects`/`change` names a rule the engine has. All against the engine's own
   exported lists.
2. **Characteristic agreement** with Scryfall: oracle id, name, mana cost, types,
   supertypes, subtypes, power, toughness, loyalty and colours, all exact. This is the
   check that matters most — a script that gets a cost wrong is not one broken card, it is
   a card quietly better than the one everyone else is playing with, and a run of thousands
   of games would build on it unnoticed. Costs are compared as parsed costs, so `{1}{G}`
   and `{G}{1}` agree; a printed `*` power is a disagreement, because the script vocabulary
   cannot say it yet.
3. **Text coverage**: `covers:` on each ability lists the sentences of the oracle text it
   claims, and every sentence must be claimed by exactly one. Reminder text is dropped
   before splitting — it is in parentheses precisely because it restates rules that are
   true anyway (CR 207.2). A sentence claimed twice, or one that does not exist, is an
   error; a sentence claimed by nobody makes the script partial.
4. **Executability smoke test**: the card is put into three synthetic games — an empty
   board, a 2/2 opposite, and the opponent's turn — with enough any-colour lands that its
   own cost is never what stops it, and cast where there is a legal way to. What is checked
   is not that it did the right thing, which no validator can know, but that the engine came
   out the other side in a legal, answerable state without throwing. A card with no legal
   target in a scenario is **skipped** there rather than failed: having no target is a
   normal fact about Magic. A sorcery-speed card skips the opponent's turn for the same
   reason.

Result: `{ status, reasons[], validatorVersion, definition, skipped[] }`. The version is
part of the answer because verdicts are cached (2.4): a cached "unsupported" from an older
validator has to be re-earned rather than believed.

## Auto-scripter

The auto-scripter converts oracle text to a script. It is a layered, deterministic pipeline; no LLM is involved in the run loop (an LLM-assisted mode for producing *draft hand scripts* offline is a later option).

1. **Normalise** (roadmap 3.1, `packages/cards/src/auto/normalise.ts`): replace the card's own name with `~` — including the short name a legendary card calls itself by, "Chandra" for "Chandra, Torch of Defiance" — strip reminder text, split into lines and sentences, resolve "this spell/creature/permanent/land/…" to the same `~`, settle the punctuation, and separate keyword lines from abilities.

   Two details matter more than they look. **The numbering is shared**: a line carries the sentence numbers `sentencesOf` gives them, which is the numbering `covers:` is validated against, and `sentencesOf` is *defined* as the flattening of the line structure so the two cannot drift. And **the punctuation is normalised** — a loyalty cost is printed with a real minus sign (U+2212), quotes are typographic, both dash characters turn up — because a grammar that had to know all of that is a grammar with a bug waiting.

   A keyword line is one where *every* part is a keyword the script can say; "Flying, protection from red" is not partly a keyword line, it is an ability, and it goes on whole. Two of those keywords are **fields on the card rather than entries in `keywords:`** — `flash` and `splitSecond` (and, since 7.1, an Aura's `enchant:`, which is a filter rather than a flag) — because they are about when a spell may be cast (CR 702.8, CR 702.19) and the engine keeps them where casting can see them; there is nothing for "target creature gains split second" to mean. They come back separately as `cardKeywords`, the emitter sets the field, and the validator lets the field claim the line — but only when the script actually sets it, since a card printed with flash whose script forgot it may be cast at the wrong time. Scryfall's `keywords` array is a cross-check in one direction only: a keyword read off a line that Scryfall does not list means the line was misread and is reported. The other direction is ordinary — a card that *grants* flying lists it and has no keyword line — and Scryfall's array mixes keyword abilities with action words, so Jace Beleren lists "Mill", which the engine has an op for, while an Equipment lists "Equip", which it has not. Those come back as `otherKeywords`: a list for the classifier to judge, not a verdict.

   Nothing is ever guessed. What the normaliser could not do confidently — a face it did not read on a two-faced card, a keyword line it distrusts — comes back in `notes`, because a normaliser that quietly dropped a line would hand the classifier a card that does less than it says and nothing downstream would know.
2. **Classify** each line (roadmap 3.2, `packages/cards/src/auto/classify.ts`) into **the engine's own ability kinds** — spell, activated, triggered, static, mana, loyalty, replacement — plus `keyword` for a keyword line and `unknown` for a line no rule reaches. The categories are the engine's rather than a list of this step's own so that the emitter maps a classification straight to a `kind:` instead of reading the same text a second time to find out what it really was; **ADR 0007** has the reasoning, and a test asserts the correspondence so a new ability kind in the engine cannot be added without a category for it.

   Most of it is the Comprehensive Rules rather than heuristics, which is what makes it worth trusting: CR 603.1 for the trigger words ("when", "whenever", "at"), CR 602.1 for the cost-colon-effect shape, CR 605.1a for which of those are mana abilities (it could add mana, it targets nothing, it is not a loyalty ability), CR 606.1 for a loyalty cost, CR 614 for replacement templating ("as ~ enters", "~ enters tapped", "if … would …, instead"), and CR 112.3 for the residual — text on an instant or sorcery is a spell ability, and text on a permanent that is none of the others is static.

   A cost is read all or nothing: every comma-separated piece of the left side has to be one (CR 601.2h), because a cost read wrongly is a card cheaper than the one that is printed. A line whose left side has a piece it cannot read is `unknown`, as are the shapes the rules do not reach — a modal spell and its bullets, a keyword ability with a cost (`Ward {2}`, `Flashback {1}{R}`). `Equip {2}` was one of them until 7.1, and is now classified as the activated ability it is short for (CR 702.6a). Each says which, so the coverage report in 3.5 counts templates to teach rather than a pile of failures.

   What the classifier does **not** claim is that a line can be parsed. "All creatures lose all abilities and have base power and toughness 1/1" is a static ability by rule; whether the grammar can read it is a different question with a different answer.
3. **Parse** with a grammar over a controlled vocabulary of Magic templating (roadmap 3.3, `packages/cards/src/auto/`): costs, target phrases (`target creature you don't control`), quantities, durations (`until end of turn`), the object phrases, and the effect verbs. It has a PEG's shape — ordered choice, backtracking, a rule that either matches or leaves the cursor where it found it — but it is **written rather than generated**, because what a rule produces is a piece of script built from a closed vocabulary and that is worth type-checking; **ADR 0008** has the reasoning and the limit it leaves.

   The **filter** is where most of Magic's variation lives, so it is the part worth widening first: a noun takes the adjectives in front of it ("attacking or blocking creature", "tapped", "untapped", "white or blue creature", "nonartifact") and the qualifiers after it ("with flying", "without first strike"), on either side of "you control". Every predicate behind those is one the engine already had (CR 115.1). A qualifier it has no predicate for — "that blocked this turn", "with a +1/+1 counter on it" — makes the whole filter unread rather than being dropped, because a filter with a qualifier quietly missing is a spell that may be pointed at things the card forbids.

   The unit is the sentence, because the sentence is the unit `covers:` counts in. Targets a sentence declares are remembered for the ones after it, which is what lets "Gain control of target creature until end of turn. Untap that creature. It gains haste until end of turn." be three sentences about one target. A bare "it" with nothing before it to refer to is the card itself — "Sacrifice ~: It deals 1 damage to any target" — but only before any effect has been read, because after one it far more likely means whatever that effect produced.

   **A parse may stop part-way and still be worth having**, as long as it stops at a sentence boundary: "Destroy all creatures. They can't be regenerated." reads the first sentence and not the second, which is exactly the shape of a *partial* script — the emitter claims what was read, the validator sees one sentence unclaimed, and the card is listed for somebody to finish rather than played as a card that does less than it says. Stopping mid-sentence is never allowed, because half a sentence is a different card.

   What comes out is **script form**, not engine objects, so the loader and the validator stay the things that decide whether a parse is playable. Anything unread is reported with the furthest token any rule reached — "no effect this can read, at «regenerated»" — which is what makes the coverage report in 3.5 a list of templates to teach.
4. **Emit** the script (roadmap 3.4, `packages/cards/src/auto/emit.ts`). Characteristics come off the printed card rather than out of the text, keywords come from the normaliser, and each classified line becomes one ability of the kind the classifier named — which is where ADR 0007 pays off, since there is nothing to work out a second time. A printed `*` is left out rather than guessed at, so the validator reports it as a disagreement, which is the truth.

   `covers:` names **only the sentences the grammar actually read**. A card whose text was half understood produces a script that claims half of it, which the validator calls partial and which is therefore never played; claiming the whole line because most of it parsed is how a card ends up quietly playing as something it is not. One card gets one spell ability however many lines its spell text runs to (CR 112.3a) — emitting one per line leaves every line after the first unplayed, because the engine resolves the first spell ability it finds, and the loader now refuses a script with two.

   Unparseable sentences are recorded with the failing token position.
5. **Validate** as above. This is also the step that makes the auto-scripter safe to leave running: it may write a script that does *less* than the card says, and a partial script is never played, but a script that disagrees with the printed card is unsupported and nothing touches it.

The **golden corpus** (`pnpm cards:corpus`, `pnpm cards:goldens`) is how a change to any of those steps is noticed: 370 real cards — two core sets, which is what "spanning the common templates" means in practice — with what the auto-scripter makes of each one committed alongside them. A rule change shows up as a diff somebody reads and accepts. As of 3.6 it reads **138 of the 370 as supported, 230 as partial and 2 as unsupported**, and the two are the cards with a printed `*` power. No card in the corpus is emitted with a characteristic that disagrees with the printed one, and none makes the engine fall over; a test asserts both, because those are the failures that would matter.

Grammar coverage is measured continuously (roadmap 3.5): `pnpm cards:coverage` runs the whole pipeline over every card Scryfall has — one line at a time off the projection `pnpm fetch:scryfall` writes — and produces `reports/coverage.json` for machines and `reports/coverage.md` for people. Since 6.6 the JSON records `measuredAt`, and the server answers it on `GET /api/coverage` for the cards page (docs/08).

**The score is not one number, and the report refuses to pretend it is.** A card with no rules text is supported without anything being read, so those are counted separately and the honest headline is the share of cards that *have* text and are supported. Sentences claimed out of all sentences is the other half, because a card is partial the moment one sentence is unread and the count of cards hides how close it was.

**The useful half is the pattern table.** A list of twenty thousand distinct unread sentences is not a report, so each one is generalised — numbers and mana symbols are what differ between two printings of one template — and what is left is the opening few words, which is where Magic puts the verb. A trigger is the exception: once its condition reads, what holds it up is its body, so the row is the body (`…, you may pay {M}`) and alike bodies count together whatever triggers them — grouped by their opening words instead, "At the beginning of your upkeep, …" was one row of seven hundred sentences no one template would ever finish (7.1). Each row is a template, how many sentences share its shape, how many *cards* it is the last thing standing in the way of, and an example card to go and look at.

A sentence left unread because an *earlier* sentence of the same ability was is **fallout**, not a template: the emitter claims a run, so one sentence it cannot read leaves the rest of that ability unclaimed too. Those are counted apart, and only the first unread sentence of each ability is a failure. Counting them together put `draw a card` — read since 3.3 — fourteenth in the table.

**Rank by `finishes`, not by `count`.** The two disagree, and the second is the one worth working from. `enchant creature` is the commonest unread shape in Magic at 893 sentences and it would finish **zero** cards on its own, because every Aura also prints "enchanted creature gets …" and the engine has no selector for the thing an Aura is attached to. `finishes` counts the cards with nothing else left unread, so it says which template is actually the last obstacle. It is an upper bound rather than a promise: a card can still be held back by something that is not a sentence at all, such as a dynamic power the script cannot say.

The nightly workflow runs it against the day's Scryfall data and keeps one issue up to date with the table — updated in place rather than commented on, because what matters is what the parser cannot read *now*. It is a report and never a gate: a coverage number that drops is worth waking up to and is not a reason to stop a merge.

Realistic expectations: vanilla/keyword creatures, burn, pump, simple removal, counters, cantrips, ETB/dies triggers, and simple static buffs are the first 30–40% of all cards and are cheap to reach. Long tail (modal complexity, unusual object references, "as long as" chains, cards that reference other cards by name) stays hand-scripted for a long time. The random-deck design tolerates this because unsupported draws are re-rolled.

**What the measurement said about that estimate** (roadmap 3.6): the cheap part was cheaper than the estimate and much smaller. Over 34,733 cards the parser reads **10.9%** as supported, and the templates it cannot read are not mostly the long tail — they are five things that each need an *engine* change before any amount of grammar helps:

- **Auras and Equipment** need an `attachedTo` effect selector, for "enchanted creature gets +1/+1" and "equipped creature has trample". Between them that is the four largest shapes in the table and around 2,400 sentences.
- **"Whenever ~ deals combat damage to …"** needs a trigger the engine does not have.
- **Modal spells** ("choose one —") need the effect list to pause for a choice mid-resolution, which is the same thing search, scry and "you may" are waiting for.
- **Additional casting costs** and **cost reduction** ("as an additional cost to cast ~, …", "~ costs {2} less to cast") need casting to consult the card.
- **The keywords that carry a cost** — cycling, kicker, crew, flashback, morph, ward — are each a small rule of their own, and `equip` is one of them.

The grammar work worth doing before those is narrower than it looks: the filter vocabulary (an adjective or a qualifier on a noun) lifts every verb at once, and a second clause on a verb that already reads is usually a whole card.

**As built (7.1, Auras and Equipment).** The first of those five is done, engine and grammar together, and it moved the number less than its 2,400 sentences suggested — **10.9% → 11.6%** (3,793 → 4,036 supported; 15,063 → 17,632 sentences claimed) — because most Auras print a second ability the parser still cannot read (Pacifism's "can't attack or block", Rancor's return-to-hand trigger). What landed:

- **The engine** (CR 303.4, 301.5, 702.5, 702.6, 704.5m-n): a card definition's `enchant` filter is the Aura spell's target — `spellAbilityOf` puts it first — so casting checks it and the spell fizzles if it has gone (CR 608.2b); the Aura enters attached to it (CR 303.4f); and the state-based actions put an Aura that is on nothing it may enchant into the graveyard and take an Equipment off anything that is not a creature, with "legal" read through one function, `canAttach`, which the `attach` op also asks before it attaches (CR 701.3b). The link is kept on both sides — the attachment's `attachedTo` and the host's `attachments` — and a zone change clears both, so an Aura on a creature that is flickered falls off the new object (CR 400.7). An `attachedTo` effect selector applies a static ability to whatever the source is on.
- **Scripts**: an Aura's `enchant:` is a filter and a field, like `flash:`, and claims the "Enchant …" line only when it is set; an Aura without one is left with that line unread, so it is partial and never played. **Equip is not a field**: "Equip {2}" is shorthand for an activated ability (CR 702.6a), so the classifier hands the grammar exactly that ability — "Attach ~ to target creature you control. Activate only as a sorcery." — and an `attach` verb reads it.
- **The static grammar** reads "Enchanted creature …", "Equipped creature …" and the anthem alike, with "gets +N/+N", "has K, K and K", or both; a sentence that gives two things becomes one static ability per change, the first claiming the sentence.

Building it found four bugs the coverage number had been hiding. Modifying the power and toughness of a noncreature gave it some, which in this engine made it a creature — an Aura's bonus left on a land, an Equipment's on an artifact (CR 208.3 says a noncreature has none). Filters read an object's printed controller, not the one control-changing effects give it (CR 613.1b). "Destroy all artifact creatures" was read as "destroy all creatures", because the plural noun overwrote the type before it. And every land with a basic land type whose mana ability is only reminder text — Tundra, Taiga, the snow duals: 41 of them — was a *supported* land that tapped for nothing, since the normaliser drops reminder text; the emitter now gives such a land its intrinsic ability (CR 305.6).

**As built (7.1, combat-damage triggers).** "Whenever ~ deals combat damage to a player" (or "to an opponent", the same thing with two players) is the engine trigger `selfDealsCombatDamageToPlayer`, fired as the damage is dealt (CR 510.3a) — once per time, so twice for double strike, and never for damage that was prevented, was noncombat, or went to a creature. In its body "that player" is the player who was dealt the damage, which the grammar reads as `opponent` unless the ability targeted a player itself. It finished 22 cards (4,036 → 4,058) of the 205 the table promised, because the bodies are where the rest stop: "you may …", a discard or a sacrifice the player chooses, "look at the top N cards", "that much" — all of them the same missing piece, the effect pipeline pausing for a decision mid-resolution, which is now the largest single gap between the parser and the cards. "To a creature" (26 lines) needs the trigger to remember which creature, and "to a player or planeswalker" (10) a planeswalker; both are left unread.

**As built (7.1, decisions mid-resolution).** That missing piece is ADR 0021: a resolving spell or ability is a program kept in `GameState.resolution` — a stack of frames, each an effect list, how far through it and its context — so it can stop for a player and carry on after, and a paused game still clones, hashes and replays. Two ops ask: `may` ("you may …", a `yesNo` decision, CR 608.2d) and `discard` ("target player discards two cards", chosen by the player discarding, CR 701.9b; each player in turn when it says "each player"). A replacement choice part-way through an ability, which used to throw, now pauses the same program. The grammar reads "*player* may *sentence*" into `may`, folds a following "If you do, …" into it, and reads a discard not "at random" as `discard`. **12.2% of Scryfall supported (4,058 → 4,229)**; six of the golden corpus moved from partial to supported (Mind Rot, Merfolk Looter, Liliana's Specter, Goldenglow Moth, Ajani's Mantra, War Priest of Thune). On the way it fixed a logging bug every removal spell had: fizzling was asked again after the effects ran, when the spell's own target was already in the graveyard, so each one was logged as fizzling. "If you do" is approximated by folding it into the `may`, which differs from the card only when the optional part turns out impossible; that, and `search`, `scry`, modes and a sacrifice of the player's choice, are the next ops on the same machinery.

**As built (7.1, the trigger vocabulary).** The trigger conditions the report ranked highest once its rows stopped hiding bodies: the beginning of combat (CR 507.1), a step of the opponent's (`whose: opponent`) and "the end step" as every one, becoming blocked (once, however many block it, CR 509.3c), gaining life (once per life-gain event, CR 119.10), and casting a spell (CR 601.2i), with a small reader of its own for what kind — "an instant or sorcery spell", "a noncreature spell" — since the ordinary noun phrase reads "creature" as a creature on the battlefield, which a spell never is. The older wordings "enters the battlefield" and "is put into a graveyard from the battlefield" read as the triggers they are. A `when` may now carry a filter, converted from its short forms as every other filter is. "That player" in a body is the player the condition names — the opponent whose step it is, the player who cast the spell or gained the life — and stays unread where it could be either, as in "each player's upkeep". **12.7% of Scryfall supported (4,229 → 4,414)**; ten of the golden corpus from partial to supported, among them Ajani's Pridemate, Ball Lightning and Mesa Enchantress. Building it found the engine putting all of a player's lifelink gains in one event: two lifelink creatures connecting together are two life gains, and "whenever you gain life" triggers for each, so the gains are now one event per source.

## Hand-script workflow

`pnpm cards:new "<name>" ["<name>" ...]` fetches each card from Scryfall and writes two things: a YAML skeleton under `packages/cards/scripts/<letter>/<slug>.yaml`, with every characteristic filled from the printed card and the oracle text listed as numbered sentences to claim, and the card's projection into `packages/cards/fixtures/scryfall.json`. The fixture is committed because validation runs in CI, where there is no network and no 500 MB bulk file. An existing script is never overwritten — only its fixture entry is refreshed.

Every script is then validated as a test (`packages/cards/src/scripts.test.ts`), which is what keeps the set honest: a script that stops agreeing with its card, or stops being playable because the engine changed underneath it, fails there rather than in a game a thousand cycles into a run. The UI's coverage page lists the most-requested unsupported cards so hand-scripting effort follows demand.

Every script also carries its own tests under `tests:`, in the small declarative
vocabulary docs/09 describes — a board, one action and an expectation. At least one is
required: docs/09's definition of done for a hand script is that somebody has checked the
card does what its text says, and validation cannot do that for you. Writing them is where
the set earns its keep — the first run of the sixty found that a land played from hand
never got its "enters tapped" replacement, and that the engine would let "destroy target
artifact" be cast at a creature.

One trap worth knowing: **a bare `~` is `null` in YAML**. Write `object: "~"` when an op acts on the card itself. The loader says so by name rather than making you work it out from a schema error.

## The bootstrap set (roadmap 2.3)

60 cards, chosen to exercise the engine rather than to make a deck: the five basics and a gate, one creature per evergreen keyword, enters and dies triggers, tokens, counters, a fight, an extra turn, regeneration, a planeswalker, and the layer-system cards. Between them they use **all seven ability kinds** and **26 of the 39 effect ops**.

Three of them are **partial** — they do less than the card says, on purpose, and are never played. They are in the set because leaving them out would hide what the engine cannot do:

| Card | What is missing |
|---|---|
| Wrath of God | "They can't be regenerated" has no op |
| Swords to Plowshares | life equal to the exiled creature's power needs last known information |
| Turn to Frog | "becomes a Frog" is a creature-type change layer 4 cannot make |

### What the set leaves out, and why

Cards deliberately not scripted, with the phase that would close each:

- **Fetchlands and tutors** — `search` needs a choice during resolution. The program that can wait on one is there since 7.1 (ADR 0021); the `search` op and its decision are not.
- **Shocklands** ("unless you pay 2 life") and **checklands** ("unless you control a Swamp") — a replacement effect cannot ask for a payment or test a condition.
- **Modal spells** ("Choose one —") — the same: a new op on ADR 0021's program.
- **A discard the player chooses** — Hymn to Tourach is in the set because it discards *at random*, which needed nobody's input. The `discard` op exists since 7.1; the hand-written set has not been widened to use it.
- **Auras that do more than a bonus** (Pacifism, Rancor) — an Aura attaches and its bonus applies since 7.1; "can't attack or block" and a trigger on going to the graveyard are still unread.
- **Blood Moon and type-changing statics** — layer 4 can make something a creature; it cannot set land types or take a land's abilities away.
- **Bad Moon** and other "creatures of a colour get +1/+1" — the effect selector has no colour filter.
- **Hardened Scales** and counter-modifying replacements — the event matcher for counters cannot say "a creature you control".
- **Triggered abilities that target** (Bond Beetle) — the engine puts a trigger on the stack without asking for targets, which needs a decision at that point.
- **Dynamic power and toughness** (`*` / `*+1`) — quantity-valued layer changes.

## Images

The web app asks the server for `/img/<oracleId>?size=normal`; the server serves from `data/images/` or fetches once from Scryfall (respecting their rate guidance: ≤ 10 req/s, proper User-Agent) and stores the file. Nothing in the simulation path touches images.
