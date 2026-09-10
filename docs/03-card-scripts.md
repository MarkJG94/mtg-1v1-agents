# 03 — Card scripts and the auto-scripter

Cards are data, not code. A **card script** is a YAML/JSON document that describes a card's characteristics and abilities in a small, closed vocabulary the engine understands. Hand-written scripts and auto-generated scripts share one schema, one validator, and one loader.

## Sources of truth

1. **Scryfall bulk data** (`oracle-cards` bulk file, one entry per oracle id) supplies name, mana cost, colours, colour identity, type line, oracle text, power/toughness/loyalty, keywords list, legalities, layout, image URIs, and set/rarity. It is fetched by `pnpm fetch:scryfall` into `data/scryfall/` and is never edited.
2. **Hand scripts** in `packages/cards/scripts/<first-letter>/<slug>.yaml`, keyed by oracle id. These win over auto-generated scripts.
3. **Auto scripts** produced by the parser at request time and cached in the `card_scripts` table together with the parser version and validation result. Bumping the parser version invalidates the cache.

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

The schema is enforced with zod (`packages/cards/src/schema.ts`), which also generates JSON Schema for editor completion in YAML files.

## Validation

`validateScript(script, scryfallCard)` checks:

1. Schema validity and that every referenced op/filter/trigger exists in the engine's registry.
2. **Characteristic agreement** with Scryfall: name, mana cost, types, P/T, loyalty, colours must match exactly. A script can't accidentally make a card cheaper.
3. **Text coverage**: every sentence of the oracle text must be claimed by exactly one ability in the script (`covers: [sentenceIndex...]`). Reminder text (in parentheses) is ignored. An unclaimed sentence makes the script `partial`, and partial scripts are never played (decision: skip and log).
4. **Executability smoke test**: the card is put into a synthetic game (cast from hand with infinite mana against an empty board, and against a board with a vanilla 2/2, and with the opponent holding priority) and the engine must reach a stable state without throwing, without an unfulfillable decision, and within a step budget.
5. Optional hand-written **scenario tests** (see 09) for cards with hand scripts.

Result: `{ status: 'supported' | 'partial' | 'unsupported', reasons[], parserVersion }`.

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

`pnpm cards:new "<name>"` scaffolds a YAML from Scryfall data with the text pre-split into sentences and a `covers` skeleton; `pnpm cards:test <name>` runs validation and any scenario tests. The UI's coverage page lists the most-requested unsupported cards so hand-scripting effort follows demand.

## Images

The web app asks the server for `/img/<oracleId>?size=normal`; the server serves from `data/images/` or fetches once from Scryfall (respecting their rate guidance: ≤ 10 req/s, proper User-Agent) and stores the file. Nothing in the simulation path touches images.
