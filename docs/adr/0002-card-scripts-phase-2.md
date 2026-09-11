# ADR 0002 — Card scripts: decisions made during Phase 2

- Status: accepted
- Date: 2026-09-10

## Context

Phase 2 implemented `packages/cards` against docs 03 and 09. Two constraints shaped it: the build sandbox
could not reach api.scryfall.com, and several planned bootstrap cards need mechanics the engine does not
have yet.

## Decisions

1. **Scryfall data for tests is a committed fixture** (`packages/cards/test/fixtures/scryfall-subset.json`)
   with the fields of the `cards` projection in doc 06. Its entries were written by hand from Oracle text;
   oracle ids are `fixture:<slug>` placeholders. `pnpm scryfall:subset` rebuilds the fixture from the real
   bulk file and rewrites the placeholder ids in the YAML scripts, so the first run on a machine with
   network access makes the ids real without touching anything else.

2. **Text coverage rules**: every normalised sentence must be claimed by at least one ability; a sentence
   claimed by two or more non-keyword abilities is an error; keyword abilities may share a keyword line
   ("Flying, vigilance"). Reminder text is dropped and reminder-only text (basics, duals) needs no abilities.
   Unclaimed sentences make a script `partial`, which is never played.

3. **Executability smoke** runs four synthetic boards (empty; opponent has a vanilla 2/2, an artifact and an
   enchantment and the caster has a 2/2; the opponent's turn with priority; responding to an opponent's
   spell) × three seeds, with 30 basic lands and a spare card in hand, driving every decision with the random
   agent under the engine's invariant checks, then activating each of the permanent's abilities once and
   finishing the turn. A card that cannot be played in any board (no legal target anywhere) is unsupported.

4. **Effect-op registry** lives in the engine (`EFFECT_OPS`, `TRIGGERS`, `STATIC_EFFECTS`, `REPLACEMENTS`,
   `KEYWORDS`) and the zod schema is built from it, so a script can only name what the interpreter runs.
   `copySpell`/`transformTargetsTo` are parsed but listed as unimplemented; using them makes a script `partial`.

5. **Bootstrap substitutions** where the planned card needs an unsupported mechanic: Fireball → Blaze
   (divided damage), Kitchen Finks → Lone Missionary (persist), Fling → Tormenting Voice (binding the
   sacrificed creature's power), Rest in Peace / Circle of Protection: Red dropped (all-zone replacement,
   activated shield), Ajani Goldmane → Nissa, Voice of Zendikar (X/X token). No ward card is in the set yet.

6. **Shocklands** are supported through a new engine decision: a permanent with an "enters tapped unless you
   pay N life" replacement asks its controller (`yesNo`) before entering from a land drop or a resolving
   spell; permanents put onto the battlefield by effects (fetches, Rampant Growth) enter tapped without the
   option.

7. The differential harness compares two definitions of one card by playing the smoke boards with the same
   seeded random decisions and diffing a compact state summary; it is ready for Phase 3's auto scripts.

## Consequences

- `docs/03` example schema is realised with `covers: [sentenceIndex...]` on every ability and an optional
  `tests:` section whose vocabulary is implemented in `packages/cards/src/scenarioTests.ts`.
- The mechanics listed in (5) are candidates for Phase 7's engine widening and Phase 3's grammar.
