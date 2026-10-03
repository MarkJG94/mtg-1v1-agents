# ADR 0014 — The replacement search ranks twice: printed facts before scripting, the script after

- Status: accepted
- Date: 2026-09-26

## Context

docs/05's replacement search ranks the pool "by a static quality model (rarity-agnostic:
mana efficiency (stats per mana), keyword value, card-advantage ops, removal breadth, plus
any prior statistics on the card from earlier cycles and matchup tags vs the opponent's
observed deck) with a temperature", then scripts the top `shortlistSize` and keeps the
first `trialTopK` the engine can play.

Half of that model cannot be computed at the point docs/05 puts it. Card-advantage *ops*,
removal breadth and matchup tags are read off a card's **script**: the tags of 4.6 come
from `destroy`, `damage` and `counter` ops and the filters of their targets, and a card
has no script until the search has decided to script it. The pool the search ranks is
thousands of cards, most never scripted and most unscriptable (10.9% of Scryfall is
supported). Scripting all of them to rank them would cost seconds per change and fill the
unsupported-request log with cards nobody asked for; reading "removal breadth" out of the
oracle text with patterns would be a second, weaker parser that disagrees with the first.

## Decision

**The search ranks twice.**

1. **Before scripting**, every candidate the pool returns is ranked by what its printing
   says: power and toughness per mana, its keywords, and — for a land — how many of the
   deck's colours its colour identity covers; plus its own record in this deck from
   earlier cycles; plus Gumbel noise at `temperature`. The top `shortlistSize` of that
   order are scripted.
2. **After scripting**, each card the engine can play is scored again with what its
   script says: the kinds of thing it answers (`vs` tags), the cards it draws for its
   controller, and the share of the opponent's observed nonland cards it answers; for a
   land, the colours it actually makes that the deck needs. The best `trialTopK` of those
   go to trial.

Both steps together are the docs/05 model; the split is where each term can be known.

Two smaller departures ride along, since they are about the same search:

- **Basic lands are cut at most four at a time.** docs/05's change is "all copies of one
  name", which for a basic land is half a mana base; a flood or a colour fix cuts four.
- **A sideboard card never boarded in scores as an average main-deck card**, and a
  main-deck card goes first on a tie. docs/05 makes it "a candidate for removal"; scoring
  it below average made every early cycle cut the sideboard while the main deck, which
  plays every game, never changed.

## Consequences

- A card that is strong only for what its script does — a two-mana "draw two" with no
  body — starts the first ranking at a flat base and reaches the shortlist on its keywords
  or the noise, not on its text. The second ranking then scores it fairly among the
  shortlisted. A larger `shortlistSize` is the knob if this turns out to matter.
- The agents package still never sees a card definition (ADR 0009): the pool hands it
  printed facts before scripting and the same data the sideboarding agent gets after.
- The evidence records both scores for every shortlisted card, and whether it could be
  scripted, so the UI can show why a card was or was not tried.
