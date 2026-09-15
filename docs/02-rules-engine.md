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
- Planeswalkers (CR 306, 606): they enter with loyalty counters equal to their printed loyalty, damage to them removes that many counters, they can be attacked directly (CR 508.1a), the pre-2018 redirect rule is gone, loyalty abilities cost counters and are sorcery-speed and once per permanent per turn, and zero loyalty is a state-based action.
- Counters (+1/+1, −1/−1, loyalty, charge, generic), tokens, copies of permanents.
- Replacement and prevention effects (CR 614–615): "enters tapped", "if X would die instead", damage prevention, "as enters" choices, applying in order chosen by the affected player/controller.
- Card types: creature, instant, sorcery, artifact, enchantment (incl. auras and equipment), land, planeswalker. Kindred/tribal as a supertype-like flag.
- Mulligans: London mulligan (CR 103.4), configurable. Every mulligan draws a fresh seven; the price is paid on keeping, one card under the library per mulligan taken.
- Game end: life ≤ 0, drawing from empty library, poison ≥ 10, conceding, "wins/loses the game" effects, turn cap → draw (default 40 turns), and a per-game decision cap to guard against infinite loops. Everything goes through `endGame`, which is the only thing that writes `state.result`.

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
  config: GameConfig;                       // turnCap, hand sizes, mulligan and decision caps
  extraTurns: PlayerId[];                   // owed extra turns, oldest first (CR 500.7)
  effects: ContinuousEffect[];              // active continuous effects with timestamps
  replacements: ReplacementEffect[];        // replacement and prevention effects (CR 614-616)
  nextEffectId: number;                     // shared by both, so log ids never clash
  pendingReplacement: ReplacementProgress | null;   // a batch paused for a CR 616.1 choice
  delayedTriggers: DelayedTrigger[];        // set up to fire at a later step (CR 603.7)
  pendingTriggers: TriggerInstance[];       // fired, waiting to go on the stack
  triggersFiredThisTurn: string[];          // for once-each-turn abilities
  loyaltyActivatedThisTurn: ObjectId[];     // one loyalty ability per planeswalker per turn
  mulligans: MulliganState | null;          // null once the opening hands are settled
  statesThisTurn: number[];                 // state hashes, for loop detection (CR 726)
  decisionsMade: number;                    // against config.decisionCap
  combat: CombatState | null;               // non-null only during the combat phase
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

## Setting up and decisions

`setUpGame` shuffles, deals the opening hands and runs the mulligans before turn 1 begins; `startGame` skips all of it and takes a board as given, which is what scenario tests and the 1.13 builder want.

The engine pauses with a `pendingDecision` whenever a player must choose. Decision kinds: `mulligan`, `bottomCards`, `priority` (pass or a list of legal actions: cast, activate, play land, special actions), `chooseTargets`, `chooseMode`, `payCost` (which permanents to sacrifice/tap, which mana to spend when ambiguous), `chooseX`, `declareAttackers`, `declareBlockers`, `orderBlockers`, `assignDamage`, `orderTriggers`, `chooseReplacement`, `chooseCardsFromLibrary`, `discard`, `distributeCounters`, `yesNo`, `chooseOption`. Every decision carries the full list of legal options so the AI never has to compute legality itself and fuzzers can pick uniformly.

`legalActions(state, player, cards)` is the single source of truth for what can be cast/activated/played, including timing restrictions and cost payability (the mana solver checks the pool plus what untapped sources could still make, treating a source that offers a choice of colours as one mana with several possible types). It reads what a card *is* — land, cost, sorcery-speed — through a `CardInfoSource`, which card scripts implement in phase 2.1. Where a source's modes would make different amounts of mana it deliberately under-reports, so the function never offers an action the engine would then reject.

## Stack and priority

- After a spell/ability is put on the stack, and after each resolution, SBAs are checked and repeated until none apply, then pending triggers go on the stack (APNAP, controller orders), then the active player receives priority (CR 117.3c, 117.5).
- Both players passing in succession with an empty stack advances the step; with a non-empty stack resolves the top item.
- Mana abilities never use the stack. The engine auto-activates mana abilities during cost payment through the mana solver; the solver prefers colourless-only sources first and keeps the most flexible sources untapped, but the AI can override with an explicit `payCost` decision. The pool holds individual mana units carrying their type, snow provenance and any spend restriction, and payment is an exact backtracking search; see ADR 0003.

## Continuous effects and layers

Each `ContinuousEffect` records: source object, timestamp (or the effect's own timestamp for one-shot-created effects), affected-object selector (a predicate over characteristics, evaluated at the appropriate layer per CR 611.2c), the layer/sublayer, the change, and duration (`untilEndOfTurn`, `whileSourceOnBattlefield`, `permanent`, custom condition). `characteristics(state, id)` applies layers 1 → 7e in order, memoised per state. Layer 7 has five sublayers, not four: 7a characteristic-defining, 7b set, 7c modify, 7d counters, 7e switch (CR 613.4). Within a layer, effects that do not depend on one another go in timestamp order (CR 613.7); where one depends on another the independent one goes first, and a circular dependency falls back to timestamp order (CR 613.8b). Dependency is detected by asking whether applying one effect changes what another applies to — the Opalescence shape. "Changes what it does" cannot arise yet, because every change in the effect vocabulary is a fixed value rather than something read off the board; the one function to widen is `dependsOn` when 2.1 adds one that is not.

Control-changing effects trigger zone-independent controller updates; the copy layer uses `copiableValues(definition, overrides)`.

## Replacement and prevention effects

Nothing in the engine deals damage, draws a card or moves a permanent directly. It builds a `RulesEvent` — `{ kind: 'damage', source, target, amount, combat }`, `{ kind: 'moveZone', object, from, to, destruction }`, `{ kind: 'draw', player }`, `{ kind: 'entersBattlefield', object, tapped, counters }`, life, counters — and hands a list of them to `runBatch`, which runs each past every applicable replacement effect before any of it happens. What survives is applied by `performEvents`. These are not the `GameEvent`s of the log: those are the record written afterwards, of what the replacements left.

Applicable effects are collected; self-replacement applies first (CR 616.1a), an effect never applies twice to the same event (CR 614.5), and when more than one still applies the affected player chooses — a `chooseReplacement` decision, which the AI answers with a heuristic and fuzzers randomly. The order is not cosmetic: prevent 2 and then double leaves 2 damage where doubling and then preventing 2 leaves 4.

Because that choice is a decision, a batch can stop half-way. The work in progress — events already resolved, events still queued, effect ids already applied to the current one — is written to `state.pendingReplacement` and picked back up by `resumeBatch`. What to do once the batch finishes is a closed union (`{ kind: 'plain' }`, `{ kind: 'combatDamage', firstStrike }`) rather than a callback, so a paused batch is plain data that replays and clones like the rest of the state. See ADR 0004.

Prevention effects (CR 615) are replacement effects, not a separate system: a shield replaces some or all of a damage event with nothing and shrinks by what it absorbed (CR 615.7). Regeneration (CR 701.15) is a one-use shield over *destruction* specifically, which is why a `moveZone` event records whether it is destruction — a creature with zero toughness is put into its graveyard rather than destroyed (CR 704.5f), and no shield saves it.

A state-based action logs the `sba` event that applied even when a replacement then changes the result, so a regenerated creature shows `creatureLethalDamage` with no `moveZone` after it. That is the faithful record: the rule applied and was replaced.

## Combat

Combat is a sub-state machine: `declareAttackers` (legal attackers computed with summoning sickness, defender, restrictions and requirements; each attacker also picks who it attacks from `legalDefenders` — the defending player and the planeswalkers they control, CR 508.1a), `declareBlockers` (legality: flying/reach, menace, protection, "can't be blocked", block requirements), damage-assignment ordering, first-strike damage step only if a first/double striker is involved, regular damage, then triggers. Damage is dealt simultaneously as one event batch so lifelink and deathtouch interact correctly with SBAs.

## Performance targets

- Median game ≤ 5 ms of engine time with a trivial AI, ≤ 50 ms with the search AI at default depth, on one core.
- `characteristics()` memoisation invalidated only by state version bumps; effect lists are usually short so linear scans are fine.
- No allocation-heavy patterns in the hot path (avoid spread on large arrays; zones as plain arrays; object pool for events).

Measured (roadmap 1.14, `pnpm bench`): a median game with the random agent takes **2.2 ms**
over ~510 decisions, about 400 games and 200,000 decisions a second on one core. Nothing is
cast yet, so that is the framework's cost — the turn loop, priority, combat, the layer
system, state-based actions, cleanup — and the floor under a real game rather than an
estimate of one.

Getting there meant fixing the engine's hottest function rather than the benchmark. Loop
detection hashed a full position at every decision point and was nine tenths of a game's
time; it now mixes integers as integers and, more importantly, only watches a turn once it
has run longer than any ordinary turn (`config.loopCheckAfter`). A loop never stops being
one, so a detector that starts late still catches it. The same investigation found the
projection was ignoring `state.combat`, which was ending 36% of wide-board games as false
draws. See ADR 0005.

Benchmarks live in `packages/engine/bench` and run in CI, which compares each run against
the last one recorded on `main` and fails on a regression greater than 20%.

## Event log

Every state change emits an event (`GameEvent` in `packages/shared`), which is both the replay source and the statistics source. Events are compact and typed: `gameStart`, `mulligan`, `keep`, `turnStart`, `stepStart`, `draw`, `playLand`, `cast`, `activate`, `trigger`, `putOnStack`, `resolve`, `counter`, `fizzle`, `moveZone`, `tap`, `untap`, `damage`, `lifeChange`, `counterChange`, `attack`, `block`, `combatDamage`, `sba`, `effectStart`, `effectEnd`, `decision` (what was chosen, with the AI's evaluation score attached for debugging), `gameEnd`. Hidden information (library order, opponent's hand) is included in the stored log; the UI chooses what to reveal.

## Known hard problems (tracked in the roadmap)

- Mana payment with hybrid/phyrexian/snow/"spend only on" restrictions is a small constraint-satisfaction problem; the solver must be exact for legality but can be heuristic for choice.
- "Last known information" for dies/LTB triggers and for effects that reference an object that left.
- Dependency resolution in layers with cyclic dependencies (rare; cap and log).
- Infinite loops (CR 726): detected by a repeated-state hash within a turn; the game is a draw. The hash covers everything that makes two positions different — pass counts and the generator's position included — because a false positive is a game silently called a draw rather than a crash. It is 53 bits across two FNV passes for the same reason. A loop the hash cannot see, such as one that shuffles a library, is caught by the decision cap instead and ends the same way.
