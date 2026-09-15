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
- **Ops that need a player choice mid-resolution are not among them**: `search`, `scry`, `surveil`, `may`, `choose` (modal), `unless ... pays`, and a discard the player picks. They need the effect list to pause and resume the way a replacement batch does, and land with that machinery — see ADR 0006. A batch that pauses mid-effects throws rather than dropping the rest.
- **Seven ability kinds** — spell, triggered, activated, static, mana, loyalty, replacement. A keyword line is expanded into the engine's keywords at load time, as the vocabulary says.
- **Dynamic characteristics are not there yet**: a static ability sets power and toughness to fixed numbers, so a card whose P/T counts something (the `*`/`*+1` example above) waits for quantity-valued layer changes.
- Filters and quantities are written in the short forms above (`filter: any`, `to: $t`, `{ type: creature, controller: opponent }`) and the loader turns them into the engine's tagged unions. An object with several keys reads as "all of these at once".

The loader checks what a shape check cannot: that every op exists, that it has the arguments it needs and none it does not, that a `$target` was actually declared by the ability that mentions it, and that a `when`, an `affects` or a `change` names something the engine really has — all against the engine's own exported lists, so the two can never drift.

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

1. **Normalise**: replace the card's own name with `~`, strip reminder text, split into sentences, resolve "this spell/creature/permanent" to `~`, expand keyword lines (`Flying, first strike` → keyword abilities) using Scryfall's `keywords` array as a cross-check.
2. **Classify** each sentence: keyword line, activated (`[cost]: [effect]`), triggered (`When/Whenever/At ...`), static (present-tense, "as long as", "can't", "get +1/+1", "enters tapped"), spell text (for instants/sorceries), loyalty (`+N:`/`−N:`), or unknown.
3. **Parse** with a grammar (a PEG via `peggy`) over a controlled vocabulary of Magic templating: costs, target phrases (`target creature an opponent controls`), quantities (`X`, `that many`, `for each ...`), durations (`until end of turn`), conditions (`if ...`, `unless ...`), object references (`it`, `that creature`, `the exiled card`), and effect verbs. Anaphora ("it", "that player") are resolved to the most recent matching binding.
4. **Emit** the script; unparseable sentences are recorded with the failing token position.
5. **Validate** as above.

Grammar coverage is measured continuously: `pnpm cards:coverage` runs the parser over the entire Scryfall database and writes a report (`supported / partial / unsupported`, top failing patterns by frequency). The roadmap targets coverage by *demand* (cards actually requested by runs) rather than by raw count; the top failing patterns list tells us what grammar to write next.

Realistic expectations: vanilla/keyword creatures, burn, pump, simple removal, counters, cantrips, ETB/dies triggers, and simple static buffs are the first 30–40% of all cards and are cheap to reach. Long tail (modal complexity, unusual object references, "as long as" chains, cards that reference other cards by name) stays hand-scripted for a long time. The random-deck design tolerates this because unsupported draws are re-rolled.

## Hand-script workflow

`pnpm cards:new "<name>" ["<name>" ...]` fetches each card from Scryfall and writes two things: a YAML skeleton under `packages/cards/scripts/<letter>/<slug>.yaml`, with every characteristic filled from the printed card and the oracle text listed as numbered sentences to claim, and the card's projection into `packages/cards/fixtures/scryfall.json`. The fixture is committed because validation runs in CI, where there is no network and no 500 MB bulk file. An existing script is never overwritten — only its fixture entry is refreshed.

Every script is then validated as a test (`packages/cards/src/scripts.test.ts`), which is what keeps the set honest: a script that stops agreeing with its card, or stops being playable because the engine changed underneath it, fails there rather than in a game a thousand cycles into a run. The UI's coverage page lists the most-requested unsupported cards so hand-scripting effort follows demand.

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

- **Fetchlands and tutors** — `search` needs a choice during resolution, which needs the resumable effect pipeline (ADR 0006).
- **Shocklands** ("unless you pay 2 life") and **checklands** ("unless you control a Swamp") — a replacement effect cannot ask for a payment or test a condition.
- **Modal spells** ("Choose one —") — same pipeline.
- **A discard the player chooses** — Hymn to Tourach is in the set because it discards *at random*, which needs nobody's input.
- **Auras** (Pacifism, Rancor) — an aura spell has to attach to its target as it resolves, and nothing does that yet.
- **Blood Moon and type-changing statics** — layer 4 can make something a creature; it cannot set land types or take a land's abilities away.
- **Bad Moon** and other "creatures of a colour get +1/+1" — the effect selector has no colour filter.
- **Hardened Scales** and counter-modifying replacements — the event matcher for counters cannot say "a creature you control".
- **Triggered abilities that target** (Bond Beetle) — the engine puts a trigger on the stack without asking for targets, which needs a decision at that point.
- **Dynamic power and toughness** (`*` / `*+1`) — quantity-valued layer changes.

## Images

The web app asks the server for `/img/<oracleId>?size=normal`; the server serves from `data/images/` or fetches once from Scryfall (respecting their rate guidance: ≤ 10 req/s, proper User-Agent) and stores the file. Nothing in the simulation path touches images.
