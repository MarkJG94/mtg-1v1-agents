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
