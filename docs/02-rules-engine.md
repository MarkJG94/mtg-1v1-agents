# 02 — Rules engine

`packages/engine` implements the Comprehensive Rules for two-player games. It aims for rules accuracy first, throughput second, and is written so each subsystem can be tested in isolation. Section numbers below reference the Comprehensive Rules (CR) so tests and bug reports can cite them.

## Scope

**v1 (must have, per decision D18):**

- Turn structure and all steps/phases (CR 500), including untap, upkeep, draw, main, combat sub-steps, end, cleanup, extra turns.
- Priority and the stack (CR 116, 405, 608): casting spells at instant/sorcery speed, activated and triggered abilities, responding, countering, resolving, fizzling on illegal targets, split second and "can't be countered".
- Mana (CR 106, 601.2g–h, 605): mana pool, mana abilities resolving immediately, colour/generic/hybrid/phyrexian costs, additional and alternative costs, cost reduction, X spells.
- Lands: basics, duals, shocks, fetches, checklands, fastlands, painlands, Wasteland-style effects; land drops per turn; sacrifice-and-search.
- Combat (CR 506–511): attack/block declaration, menace, multiple blockers, damage assignment order, first/double strike, trample, deathtouch, lifelink, flying/reach, vigilance, haste, defender, indestructible, hexproof/shroud/protection, ward.
- State-based actions (CR 704) and the legend rule.
- Triggered abilities (CR 603) with APNAP ordering, intervening-if, ETB/LTB/dies/attacks/blocks/upkeep/end-step/cast triggers, and delayed triggers.
- Static abilities and continuous effects with the **layer system** (CR 613): copy, control, text-changing, type, colour, ability add/remove, P/T (set / modify / counters / switch), timestamps and dependency.
- Planeswalkers (CR 306): loyalty abilities once per turn, damage to planeswalkers, redirect rule removed (post-2018 rules), loyalty SBA.
- Counters (+1/+1, −1/−1, loyalty, charge, generic), tokens, copies of permanents.
- Replacement and prevention effects (CR 614–615): "enters tapped", "if X would die instead", damage prevention, "as enters" choices, applying in order chosen by the affected player/controller.
- Card types: creature, instant, sorcery, artifact, enchantment (incl. auras and equipment), land, planeswalker. Kindred/tribal as a supertype-like flag.
- Mulligans: London mulligan (CR 103.4), configurable.
- Game end: life ≤ 0, drawing from empty library, poison ≥ 10, "wins/loses the game" effects, turn cap → draw (default 40 turns), and a per-game decision cap to guard against infinite loops.

**v2 and later (see roadmap):** double-faced and modal double-faced cards, adventures, split/fuse, morph/manifest, sagas, battles, dungeons/initiative, day/night, the monarch, companion, mutate, level up, suspend, cascade, storm and other high-complexity mechanics; commander-only rules; multiplayer.

## State model

```ts
interface GameState {
  version: number;                          // bumped by every update; memoisation key for characteristics()
  rng: RngState;
  turn: number;
  activePlayer: PlayerId;
  step: Step;                               // 'untap' | 'upkeep' | ... | 'cleanup'
  priority: PlayerId | null;
  passesInARow: number;
  players: Record<PlayerId, PlayerState>;   // life, poison, mana pool, landsPlayedThisTurn, flags
  objects: ReadonlyMap<ObjectId, GameObject>;   // every card/token/copy currently in any zone
  zones: Record<ZoneId, ObjectId[]>;        // library/hand/graveyard per player; battlefield/stack/exile/command shared
  nextObjectId: number;
  nextTimestamp: number;                    // layer-system timestamps (CR 613.7)
  config: GameConfig;                       // turnCap, maxHandSize, playerOnPlay
  extraTurns: PlayerId[];                   // owed extra turns, oldest first (CR 500.7)
  effects: ContinuousEffect[];              // active continuous effects with timestamps        (1.9)
  delayedTriggers: DelayedTrigger[];                                                         // (1.8)
  pendingTriggers: TriggeredAbilityInstance[];  // waiting to be put on the stack              (1.8)
  combat: CombatState | null;                                                                // (1.6)
  pendingDecision: Decision | null;         // set when a player must choose; null while it can run
  result: GameResult | null;
}
```

Zones follow the Comprehensive Rules rather than being uniformly per player: library, hand
and graveyard are owned, while the battlefield, stack, exile and command zone are single
shared zones. Control is a property of the object, so a control-changing effect moves
nothing and fires no zone-change trigger. The stack *is* the `stack` zone, bottom → top;
there is no second array, and a spell's targets, modes and X live on its `GameObject`.
Fields marked with a roadmap number are added by the phase that designs them. See ADR 0002.

A `GameObject` holds `definitionId`, `owner`, `controller`, `zone`, `timestamp`, `tapped`, `counters`, `damage`, `attachedTo`, `attachments`, `chosen` (colour/type/name choices), `lastKnownInfo`, and the per-object continuous-effect cache. Characteristics (name, types, colours, P/T, abilities) are **never** stored directly; they are computed by `characteristics(state, objectId)` which starts from the printed definition (or copiable values) and applies the layer system. The result is memoised per state version.

## Decisions

The engine pauses with a `pendingDecision` whenever a player must choose. Decision kinds: `mulligan`, `bottomCards`, `priority` (pass or a list of legal actions: cast, activate, play land, special actions), `chooseTargets`, `chooseMode`, `payCost` (which permanents to sacrifice/tap, which mana to spend when ambiguous), `chooseX`, `declareAttackers`, `declareBlockers`, `orderBlockers`, `assignDamage`, `orderTriggers`, `chooseReplacement`, `chooseCardsFromLibrary`, `discard`, `distributeCounters`, `yesNo`, `chooseOption`. Every decision carries the full list of legal options so the AI never has to compute legality itself and fuzzers can pick uniformly.

`legalActions(state, player, cards)` is the single source of truth for what can be cast/activated/played, including timing restrictions and cost payability (the mana solver checks the pool plus what untapped sources could still make, treating a source that offers a choice of colours as one mana with several possible types). It reads what a card *is* — land, cost, sorcery-speed — through a `CardInfoSource`, which card scripts implement in phase 2.1. Where a source's modes would make different amounts of mana it deliberately under-reports, so the function never offers an action the engine would then reject.

## Stack and priority

- After a spell/ability is put on the stack, and after each resolution, SBAs are checked and repeated until none apply, then pending triggers go on the stack (APNAP, controller orders), then the active player receives priority (CR 117.3c, 117.5).
- Both players passing in succession with an empty stack advances the step; with a non-empty stack resolves the top item.
- Mana abilities never use the stack. The engine auto-activates mana abilities during cost payment through the mana solver; the solver prefers colourless-only sources first and keeps the most flexible sources untapped, but the AI can override with an explicit `payCost` decision. The pool holds individual mana units carrying their type, snow provenance and any spend restriction, and payment is an exact backtracking search; see ADR 0003.

## Continuous effects and layers

Each `ContinuousEffect` records: source object, timestamp (or the effect's own timestamp for one-shot-created effects), affected-object selector (a predicate over characteristics, evaluated at the appropriate layer per CR 611.2c), the layer/sublayer, the change, and duration (`untilEndOfTurn`, `whileSourceOnBattlefield`, `permanent`, custom condition). `characteristics()` applies layers 1 → 7e in order, sorts within a layer by timestamp, and resolves dependencies (CR 613.8) with the standard "apply dependent effects after the effects they depend on" iteration, capped to avoid cycles. Layer 7 sublayers: 7a set, 7b modify, 7c counters, 7d switch.

Control-changing effects trigger zone-independent controller updates; the copy layer uses `copiableValues(definition, overrides)`.

## Replacement and prevention effects

Events are constructed as data (`{ type: 'damage', source, target, amount, combat: true }`, `{ type: 'moveZone', object, from, to }`, `{ type: 'draw', player }` …) and pass through `applyReplacements(state, event)` before execution. Applicable replacements are collected; if more than one applies, the affected player/controller chooses (a `chooseReplacement` decision, which the AI answers with a heuristic and fuzzers randomly). Self-replacement effects apply first (CR 616.1a). A replacement effect never applies twice to the same event.

## Combat

Combat is a sub-state machine: `declareAttackers` (legal attackers computed with summoning sickness, defender, restrictions and requirements), `declareBlockers` (legality: flying/reach, menace, protection, "can't be blocked", block requirements), damage-assignment ordering, first-strike damage step only if a first/double striker is involved, regular damage, then triggers. Damage is dealt simultaneously as one event batch so lifelink and deathtouch interact correctly with SBAs.

## Performance targets

- Median game ≤ 5 ms of engine time with a trivial AI, ≤ 50 ms with the search AI at default depth, on one core.
- `characteristics()` memoisation invalidated only by state version bumps; effect lists are usually short so linear scans are fine.
- No allocation-heavy patterns in the hot path (avoid spread on large arrays; zones as plain arrays; object pool for events).

Benchmarks live in `packages/engine/bench` and run in CI to catch regressions greater than 20%.

## Event log

Every state change emits an event (`GameEvent` in `packages/shared`), which is both the replay source and the statistics source. Events are compact and typed: `gameStart`, `mulligan`, `keep`, `turnStart`, `stepStart`, `draw`, `playLand`, `cast`, `activate`, `trigger`, `putOnStack`, `resolve`, `counter`, `fizzle`, `moveZone`, `tap`, `untap`, `damage`, `lifeChange`, `counterChange`, `attack`, `block`, `combatDamage`, `sba`, `effectStart`, `effectEnd`, `decision` (what was chosen, with the AI's evaluation score attached for debugging), `gameEnd`. Hidden information (library order, opponent's hand) is included in the stored log; the UI chooses what to reveal.

## Known hard problems (tracked in the roadmap)

- Mana payment with hybrid/phyrexian/snow/"spend only on" restrictions is a small constraint-satisfaction problem; the solver must be exact for legality but can be heuristic for choice.
- "Last known information" for dies/LTB triggers and for effects that reference an object that left.
- Dependency resolution in layers with cyclic dependencies (rare; cap and log).
- Infinite loops (CR 726): detected by a repeated-state hash within a turn; the game is a draw and the loop is logged.
