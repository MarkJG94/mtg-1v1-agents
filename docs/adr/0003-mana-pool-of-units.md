# ADR 0003 — Mana is a pool of units, and phyrexian mana is just hybrid mana

- Status: accepted
- Date: 2026-09-13

## Context

Roadmap 1.1 gave `PlayerState` a mana pool shaped as a count per type,
`Record<ManaType, number>`. Implementing payment in 1.3 showed that shape cannot express
what the rules need.

A unit of mana is not only its colour. It may have come from a snow source, which is the
whole of what `{S}` asks about (CR 107.4h), and it may carry a "spend this mana only
on ..." rider (CR 106.6). Counting by colour throws both away, and docs/02 names exactly
those riders — "hybrid/phyrexian/snow/'spend only on' restrictions" — as what makes
payment a constraint problem rather than a subtraction.

Separately, the symbol types looked like four unrelated cases to implement: coloured,
hybrid `{W/U}`, monocolour hybrid `{2/W}`, and phyrexian `{W/P}`.

## Decision

1. **A pool is a list of `ManaUnit`s**, each with a type, a snow flag and an optional
   restriction, rather than a count per type. Spending names the units to remove, because
   which unit is spent can matter.
2. **Every non-generic symbol is a list of alternative ways to pay it.** `{W}` has one
   alternative, `{W/U}` two colours, `{2/W}` a generic amount or a colour, and `{W/P}` a
   colour or 2 life. Phyrexian mana is therefore not a special case at all — it is hybrid
   mana whose other half is life — and `{B/G/P}`, which is hybrid *and* phyrexian, needs
   no extra code.
3. **Payment searches rather than walking left to right.** Paying `{U/R}{U}` from one blue
   and one red is legal, but a greedy pass spends the blue on the hybrid and then fails.
   The solver tries the most-constrained symbol first and backtracks, so it is exact: a
   `null` result means the cost genuinely cannot be paid. It branches over *distinct kinds*
   of unit rather than units, so ten identical Forest mana branch once.
   Which legal payment it picks is a heuristic — colourless and restricted mana first,
   keeping flexible mana back — and legality never depends on that choice.

## Consequences

- `PlayerState.manaPool` changed type. Only the 1.1 pool helpers and their tests depended
  on it, and both were rewritten here.
- Restrictions are carried but not yet enforced: deciding whether a rider permits a given
  spell needs to know what is being cast, which arrives with casting in roadmap 1.4.
  `payCost` takes a `canSpend` predicate for that, and defaults to permitting everything.
- Snow is fully handled, because a unit knows its own provenance.
- The solver is exponential in the worst case. Real costs have a handful of symbols and
  real pools a handful of distinct kinds, and the most-constrained-first ordering prunes
  hard, but if the 1.14 benchmarks ever show it mattering the fix is a matching algorithm
  rather than a different model.
- Mana *abilities* are modelled here (`ManaAbility`, resolving immediately without the
  stack per CR 605.3b), but the abilities of actual lands come from card scripts, so real
  lands are wired up in roadmap 2.1.
