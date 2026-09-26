# ADR 0007 — The sentence classifier's categories are the engine's ability kinds

- Status: accepted
- Date: 2026-09-15

## Context

docs/03 describes the auto-scripter's second step as classifying each sentence into
**keyword / activated / triggered / static / spell / loyalty / unknown**. That list was
written before the engine had card definitions; roadmap 2.1 gave `CardAbility` seven
kinds, and two of them are missing from it:

- **`mana`.** CR 605.1a makes a mana ability a distinct thing from an ordinary activated
  ability: it does not use the stack, it cannot be responded to, and the engine's
  `manaAbilitiesOf` only ever looks at abilities declared `kind: mana`. Every land in the
  set is one.
- **`replacement`.** "This land enters tapped" is a replacement effect (CR 614.1c), not a
  static ability, and the engine treats the two completely differently — one is derived as
  a `ReplacementEffect`, the other as a `ContinuousEffect` in a layer.

If the classifier keeps the doc's list, the emitter in 3.4 has to take a line the
classifier already read, notice that "static" really means "replacement" and that
"activated" really means "mana", and read the text a second time to find out. That second
reader is where the two would disagree, and a disagreement means a card whose ability the
engine registers as the wrong kind — a mana ability that can be countered, or an enters-tapped
land that comes down untapped.

## Decision

**The classifier's categories are `CardAbility['kind']`, plus `keyword` and `unknown`.**

Those two are not ability kinds and cannot be: a keyword line is the card's `keywords:`
list rather than an ability at all, and `unknown` is the honest answer for a line whose
shape none of the rules reach.

A test asserts the correspondence, so a new ability kind in the engine cannot be added
without the classifier gaining a category for it.

## Consequences

- The emitter maps a classification to a `kind:` directly. There is no second reader and
  therefore nothing for it to disagree with.
- Most of the classifier is the Comprehensive Rules rather than heuristics, which is what
  makes it worth trusting: CR 603.1 for trigger words, CR 602.1 for cost-colon-effect,
  CR 605.1a for which of those are mana abilities, CR 614 for replacement templating, and
  CR 112.3 for the residual — text on an instant or sorcery is a spell ability, text on a
  permanent that is none of the others is static.
- The coverage report in 3.5 counts `unknown` lines by the reason they carry, so what it
  reports is a list of templates to teach the parser rather than a pile of failures.
- Saying what *kind* of ability a line is remains a different question from whether the
  grammar can parse it. "All creatures lose all abilities and have base power and toughness
  1/1" is a static ability by rule; whether 3.3 can read it is 3.3's problem.

## The limit this leaves, deliberately

The residual rule is only as good as the rules above it. A line the classifier does not
recognise as triggered, activated or a replacement is called static on a permanent — so a
replacement template nobody has taught it is silently a static ability rather than an
`unknown`. That is the right trade while the templates are the common ones, and the
differential harness in 2.5 is what would catch it on a card that also has a hand script:
the two scripts would play differently, which is exactly the disagreement it exists to find.
