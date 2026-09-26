# 05 — Evolution loop, statistics, bans

## Run settings

| Setting | Default | Notes |
| --- | --- | --- |
| `seed` | random 64-bit | Everything derives from it. |
| `matchesPerCycle` | 100 | Bo3 matches; ≈ 200–300 games. |
| `tieMargin` | 0.04 | Win-rate difference below which a cycle is a tie. |
| `tiebreakMatches` | 30 | Extra batch on a tie. |
| `changeSize` | `slot` | Fixed for now (all copies of one name); the setting exists for later experiments. |
| `shortlistSize` | 50 | Candidates scripted per replacement search. |
| `trialTopK` | 3 | Candidates that get a trial batch; 0 disables trials. |
| `trialMatches` | 20 | Matches per trial candidate. |
| `turnCap` | 40 | Game is a draw past this. |
| `agentLevel` | `search` | See 04. |
| `maxSideboardSwaps` | 4 | Pairs of cards swapped between games 2 and 3 of a match. See 04. |
| `seedDeck` | `constrainedRandom` | Or a pasted 75. |
| `seedDeckColours` | random 1–3 | |
| `seedDeckLands` | 24 (±2) | |
| `legalityFilter` | `vintage` | Scryfall legality used as the *base* pool (anything printed for constructed play, excluding un-sets, conspiracies, etc.). The run's own ban list sits on top. |

## Seed deck generation

1. Pick colour identity: 1–3 colours at random (weighted 30/50/20).
2. Lands: `seedDeckLands` total. Basics in proportion to colour count, then replace up to 40% of them with random supported nonbasic lands whose colour identity ⊆ chosen colours.
3. Nonlands: draw uniformly from supported-or-scriptable cards with colour identity ⊆ chosen colours, base legality passing, not on the ban list, until the main deck has 60 cards, subject to max 4 copies per name (restricted → 1), and a mild curve constraint (no more than 8 cards with mana value ≥ 5) so the deck can function.
4. Sideboard: 15 cards by the same draw.
5. Every draw goes through `ScriptResolver`; unsupported cards are re-rolled and logged.
6. Copy count per name is random 1–4 (weighted toward 4 for cheap cards) to look like a real deck rather than 60 singletons.

Both agents start with byte-identical 75s. The deck is recorded as generation 0 of each agent's lineage.

**As built (5.3)**: `generateSeedDeck` in `packages/sim/src/seed-deck.ts`; `pnpm seed:deck` rolls one from the whole of Scryfall and prints it as a decklist. It returns one deck with the definitions of every card in it; giving both agents a copy and recording it as generation 0 is the run's (5.6). Where this section leaves a choice:

- **A card a seed deck may hold** is not digital-only, is `legal` or `restricted` in the run's `legalityFilter`, is not banned by the run, and has a colour identity within the deck's colours. It may hold four copies (CR 100.2a), one if the base format or the run restricts it, and any number of a basic land — snow-covered ones included (CR 205.4c). A card whose own text allows any number of copies is held to four.
- **Colours** are the run's `seedDeckColours` if it names them (one to three, distinct), otherwise one, two or three at 30/50/20 from the five; they come back in WUBRG order.
- **A land** is a card whose front face is a land, so a spell with a land on its back is drawn as a spell.
- **Basics "in proportion to colour count"** is read as an even split across the colours, any remainder going to colours picked at random; weighting them by the spells' coloured pips is left to the deck agent, whose colour-screw diagnosis exists for it. The basic for a colour is the plain basic land whose colour identity is that colour alone. A snow-covered basic is neither a basic the deck is given nor a nonbasic land to draw.
- **Nonbasic lands**: how many is uniform between none and 40% of the lands, rounded down; if the pool runs out of fitting nonbasics first, basics make up the rest.
- **Copies** are drawn with weights 1:1:2:4 for one to four copies of a card of mana value 2 or less, 1:1:1:2 for 3–4, and evenly above that, then cut to what the copy limit, the room left and the curve allow.
- **The curve constraint** counts copies: a name that would take the main deck past eight cards of mana value five or more is cut to what is left, and skipped — without asking the resolver — when nothing is. It does not apply to the sideboard, since it is there so the deck can function.
- **The sideboard** is drawn the same way from the names the main deck did not take.
- **A thin pool**: when there are no new names left, the draw adds copies of names already drawn up to their limits — for the sideboard, of main-deck names too, within four in the 75. If that still falls short the generator fails with `SeedDeckError` saying by how much; it never returns a partial deck.
- **Re-rolls**: every card drawn goes through the `ScriptResolver`. One it cannot support is put back and not drawn again for this deck, listed in the result with the section it was drawn for, and logged by the resolver as an unsupported request with context `seed deck (lands|main|side)` and the run id.
- **Determinism**: the pool is put in oracle-id order before anything is drawn, so its order changes nothing, and colours, lands, main deck and sideboard each draw from their own fork of the seed.

Over the full pool (34,733 cards, 10.9% supported) a deck takes about half a second including the smoke test of every card it resolves, and puts back 120–300 draws.

## The cycle

```
loop while run.status == running:
  play matchesPerCycle Bo3 matches (play/draw for game 1 alternates each match; loser of a game chooses in games 2–3)
  aggregate statistics
  if |winRateA − winRateB| < tieMargin:
      play tiebreakMatches more; re-aggregate
      if still within margin: loser = seeded coin flip
  loser = agent with lower match win rate
  change = deckAgent.chooseChange(loser.deck, stats, opponentKnowledge, banList)
  apply change → loser.deck generation += 1
  legalise both decks against the current ban list (usually a no-op)
  persist cycle record
```

Games within a cycle are independent and run in parallel across the worker's game queue when `SIM_WORKERS` allows more than one worker per run (default: one worker per run; multi-worker per run is a later optimisation).

**As built (5.1)**, in `packages/sim/src`:

- **`deckBoard`** (`deck.ts`) makes a game from two decks: each main deck in its owner's library, the definitions of every card in them, and the chooser named, so `setUpGame` asks who plays first before it shuffles and deals (CR 103.1–103.3). Sideboards stay out of the game (CR 100.4a). A card with no definition is refused rather than left out.
- **`playMatch`** (`match.ts`) plays best of three. Game 1's chooser is given; after that the loser of the previous game chooses, and after a drawn game whoever chose in it chooses again (CR 103.1) — the chooser's own agent answers the `playOrDraw` decision, so a deck whose record says it wins more on the draw takes it. A drawn game counts for neither player; the match stops at two wins or three games, and level wins after three is a drawn match. Between games 2 and 3, and only if there is a game 3, each player's sideboarding hook is shown what the opponent has shown so far (their cards in public zones at the end of each game) and the games so far, and returns the deck for game 3; a plan that changes the seventy-five, or the sixty in the main, is refused. Each game's seed, chooser, player on the play, result, main decks and every decision are kept, so any game can be replayed.
- **`runCycle`** (`cycle.ts`) plays `matchesPerCycle` matches with game 1's chooser alternating from match to match, scores a match one for a win and a half for a draw, and treats two rates closer than `tieMargin` — or exactly level, whatever the margin — as a tie: `tiebreakMatches` more are played and counted with the rest, and a coin flipped from `${seed}:coin` names the loser if it is still a tie. Each deck's play/draw record is kept game by game and every match's agents are made knowing the record so far (docs/04 item 6). Sideboarding is docs/04's `sideboard()` by default, told the opponent's shown cards and this deck's games and wins against the other this cycle; per-card matchup records wait for the statistics aggregator (5.2).

## Statistics

Per cycle, per agent, per card (oracle id), the aggregator computes from the event logs:

| Statistic | Meaning |
| --- | --- |
| `gamesDrawn` / `gamesNotDrawn` | Games in which the card appeared in hand at any point. |
| `winRateDrawn` / `winRateNotDrawn` | "GIHWR"-style: win rate when drawn vs when not. The difference (Δ) is the primary contribution signal. |
| `castRate` | Of games drawn, fraction in which it was cast at least once. |
| `deadInHandRate` | Fraction of games where it was in hand at game end uncast. |
| `avgTurnCast` | Mean turn of first cast vs its mana value (tempo). |
| `impact` | Mean evaluator swing across its resolutions (from `decision` events' scores). |
| `mulliganBlame` | How often it was in a mulliganed hand. |
| `matchupWinRate` | Same as above but keyed by the opponent's deck generation, used for sideboarding. |
| Deck-level | mana screw rate (< 3 lands by turn 4), flood rate (> 7 lands by turn 8), average game length, win rate on play vs draw, colour-screw rate (spell held for lack of a colour). |

Statistics are stored per cycle and also rolled up across cycles with exponential decay (half-life 3 cycles) so the deck agent has both fresh and historical evidence. Small-sample noise is handled with a Bayesian shrinkage toward the deck mean (Beta prior with `n0 = 20`).

**As built (5.2).** Every game now leaves an **event log** (`eventLogOf` in `packages/sim/src/event-log.ts`, the docs/06 format): what the engine emitted, a header naming each object's card — an object keeps its id wherever it goes in this engine, so the final table names every card — and each player's deck generation and the sixty it played with. When asked, `playGame` also records every decision as a `decision` event scored by the evaluator on the decider's own view, which is what `impact` is read from. **The aggregator** (`packages/sim/src/stats.ts`) reads a log alone, with each card's printed facts passed in, replaying just enough to know what was in each hand and on each battlefield when, and returns counts. **Counts, not rates, are what is stored** (`packages/shared/src/stats.ts`): they add, so a cycle's statistics are the sum of its games', and `rollUp` weights each cycle by 2^(−age/3) to decay them; rates are read off counts with `cardStats`/`deckStats`, the contribution Δ between shrunk drawn and not-drawn rates (`shrunkRate`, n0 = 20). Where this table leaves a choice:

- *drawn* is in hand at any point after the hand was kept — the kept hand, draws, and anything returned to hand; a hand mulliganed away counts toward `mulliganBlame` instead, and cards put on the bottom are not drawn;
- *cast* includes playing a land; *dead in hand* is a copy still in hand when the game ended;
- *turn of first cast* is in the player's own turns, so the draw is not charged a turn;
- *impact* is the caster's score at its first decision after the spell resolved, less its score at its last decision before casting it;
- *screw* and *flood* are lands on the battlefield at the end of the player's fourth and eighth turns, over the games that reached them; *colour screw* is ending a turn holding a spell the lands could pay for but not in its colours;
- *matchup* records are the drawn and not-drawn tallies filed under the opponent's deck generation.

`runCycle` scores its decisions, reads every game into each deck's counts as it finishes (a cycle's logs would run to hundreds of megabytes, so none are kept unless `onGame` keeps them), returns them as `stats`, and hands the sideboarding agent each card's record against the opponent's current generation, from earlier cycles' rolled-up `history` and this cycle so far.

## Choosing the change (`DeckAgent`)

```ts
interface DeckAgent {
  chooseChange(input: { deck: Deck75; stats: DeckStats; opponent: OpponentKnowledge;
                        banList: BanList; pool: CardPoolQuery; rng: Rng }): Promise<DeckChange>;
}
```

The default `StatisticalDeckAgent`:

1. **Diagnose**: if screw rate is high, the "removal" candidate is a spell slot and the "addition" is a land (or the reverse for flood). If colour-screw is high, prefer fixing lands or cutting the off-colour slot. Otherwise pick the slot with the lowest shrunk Δ, weighting `deadInHandRate` and low `castRate`. Sideboard slots are diagnosed by their sideboarded-in performance; a sideboard card that never gets boarded in is a candidate for removal.
2. **Search the pool** (Scryfall via `CardPoolQuery`):
   - filter: base legality, not banned, restricted respected, colour identity ⊆ deck colours (or, with small probability, a colour the deck's lands could support), mana value within ±1 of the removed slot (relaxed when fixing screw/flood), not already at 4 copies in the 75, and not the card just removed;
   - rank by a **static quality model** (rarity-agnostic: mana efficiency (stats per mana), keyword value, card-advantage ops, removal breadth, plus any prior statistics on the card from earlier cycles and matchup tags vs the opponent's observed deck) with a temperature so lower-ranked cards are occasionally tried;
   - take the top `shortlistSize`, script them on demand (skip unsupported), keep the first `trialTopK` supported.
3. **Trial** (optional): play `trialMatches` for each candidate deck against the opponent's current deck and pick the highest win rate; ties by static score. Trial results are recorded and count toward the candidate card's statistics.
4. **Emit** `DeckChange { remove: {oracleId, zone, count}, add: {oracleId, zone, count}, reason: string, evidence: {...} }`. The `reason` is a human-readable sentence built from the diagnosis ("Cut Grizzly Bears (Δ −8%, dead in hand 31%) for Watchwolf (trial 62% vs 51%)"), shown in the UI.

Moves between main and side are one of the change shapes: remove a main slot and add the same card to the side (or vice versa), replacing what was there. The change always keeps 60/15.

Reverts are allowed. There is no convergence protection (decision D11).

An `LLMDeckAgent` implementing the same interface is a later option; the statistics and shortlist code is reusable for it.

**As built (5.4).** `StatisticalDeckAgent` (`packages/agents/src/deck-agent.ts`) is a plain function of data, like the sideboarding agent: it never sees a card definition or a game (ADR 0009). Its input is the loser's deck (`Deck75`), what `@mtg/sim` says about each card in it (`DeckCard`: tags, land or not, colours cost and made, name, mana value, basic or not, cards drawn), the deck's counts (earlier cycles rolled up with this one), what it has seen of the opponent's deck (`OpponentKnowledge`, from the cycle's `shown`), the ban list, the injected RNG, and two ports: `CardPoolQuery` and an optional `TrialRunner`. It returns a `DeckChange` (`@mtg/shared`), which `applyDeckChange` applies. The interface above differs in naming, not in what goes in or out: the stats arrive as counts, and the trial runner is a port rather than something the agent owns. Where this section leaves a choice:

- **Thresholds.** A deck-level rate is believed over at least `minGames` (20) games that could show it; screw and flood are "high" at 25% and colour screw at 20%, and when screw and flood are both high the higher one is fixed.
- **Screw** trades the main deck's worst spell for as many lands, searched in the deck's colours. **Flood** trades a land for a spell of any mana value, never cutting the last land that makes a colour the spells need. **Colour screw** finds the colour with the most spell copies needing it per land copy making it, and trades a land of the most over-supplied colour for one whose script makes the starved colour; if the pool has none, it cuts the worst spell that needs the colour for one that does not.
- **The worst slot** is the one with the lowest shrunk Δ, less 0.1 × its dead-in-hand rate and 0.05 × the share of its draws it was never cast. A sideboard card is scored by its record when boarded in; one never boarded in scores as an average card, and a main-deck card goes first on a tie (ADR 0014). A sideboard card whose record beats the worst main-deck card's by 3 points, with as many copies and colours the lands make, **swaps** with it — the change's `shape` is `swap`, and no search is made.
- **A basic land is cut four at a time at most** (ADR 0014); any other slot goes whole.
- **The search** asks the pool for cards in the deck's colours — with probability 0.1, the colours its lands make too — within one mana value of the card cut, or any mana value when the mana is being fixed, excluding the card cut and anything banned; then drops what the 75 cannot hold that many more copies of. **It ranks twice** (ADR 0014): before scripting, by body per mana and keywords (or, for a land, the deck colours its identity covers), the card's own record in this deck from earlier cycles, and Gumbel noise at temperature 0.15; after scripting, adding 0.1 per kind of thing its script answers, 0.25 per card it draws, and 0.5 × the share of the opponent's observed nonland cards it answers (for a land, 0.5 per deck colour it makes). The top `shortlistSize` are scripted, and the best `trialTopK` the engine can play go to trial. If none can be played the band is dropped; if still none, a colour-screw fix falls back to cutting the spell; if still none, the agent says so rather than making no change.
- **Trials** (`trials` in `packages/sim/src/trial.ts`) play each finalist's deck against the opponent's current deck as a short cycle — `trialMatches` matches, alternating first choice, sideboarding and statistics — and the best win rate wins, ties to the higher score. What each trial recorded is kept for the caller to add to the deck's counts; storing it is 5.6's.
- **The reason** reads like the example above: "Cut 4 Ogre (Δ −9%, dead in hand 31%) for 4 Wolf (trial 62% over 20 matches vs 41% this cycle)", with the diagnosis first when it was the mana ("Mana screw in 34% of games: …", "Short of green mana (colour screw in 30% of games): …"). The evidence holds the deck-level rates read, the cut slot's record, the starved colour, and every shortlisted card with both scores, whether it could be scripted, and its trial.
- **The pool** (`ScryfallPool`, `packages/sim/src/pool.ts`) is Scryfall's projections less digital-only cards and those the base format does not allow; scripting runs the `ScriptResolver` in-process behind an asynchronous interface that 5.7's scripting worker will sit behind, keeps every definition it makes for the games that follow, and logs what it cannot script as a request from the run with context `deck change`.

## Bans and restrictions

Each run has a ban list: `Map<oracleId, 'banned' | 'restricted'>` with an audit trail (who/when/note). The operator edits it live from the UI at any time.

Semantics (Vintage-style, decision D12):

- **banned**: 0 copies in the 75.
- **restricted**: at most 1 copy in the 75 (main + side combined).
- Takes effect at the end of the game currently in progress. The match in progress continues with legalised decks (the remaining games of that match are still counted).
- **Legalisation** is a forced change applied to *both* agents independently and does not consume the cycle's normal change: for each illegal slot, remove the excess copies and fill the hole via the same replacement search (mana-value band around the removed card, same colour identity, all copies of one new card if the hole is ≥ 2 cards, otherwise 1 copy). The legalisation is recorded as a deck generation with `cause: 'ban'`.
- Unbanning never changes decks automatically.
- The seed deck generator and the pool query always respect the current list, so a banned card can't re-enter.
- Restricted cards cannot be "moved" to make room; if a deck holds 1 copy of a restricted card in the main and gains another via a change, the change is rejected at validation.

Every ban also emits a `RunEvent` on the WebSocket so the UI shows a banner in live view and a marker on the run timeline.

## Run lifecycle

`created → running → paused → running … → stopped`. `fork(runId, cycle)` creates a new run with the decks and stats as of that cycle and a fresh seed; the ban list is copied. `export(runId)` produces a JSON bundle (settings, ban history, every deck generation with reasons, per-cycle stats, and optionally every event log) and a plain-text decklist per generation.
