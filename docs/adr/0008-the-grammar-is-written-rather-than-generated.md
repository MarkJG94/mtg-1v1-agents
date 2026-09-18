# ADR 0008 — The grammar is written rather than generated

- Status: accepted
- Date: 2026-09-15

## Context

docs/03 specifies the auto-scripter's third step as "a grammar (a PEG via `peggy`)". The
shape is right — ordered choice with backtracking is exactly how Magic templating wants to
be read — but the implementation choice deserved a second look before a dependency and a
code-generation step went into the build.

Three things about *this* parser make a generated one awkward:

- **The actions are where the work is.** What a rule produces is a piece of script —
  `{ op: damage, to: $t, amount: 3 }` — built out of a closed vocabulary. In peggy those
  actions are JavaScript inside a grammar file, which `tsc` never sees. The rest of this
  repository is built on the opposite principle: the validator reads the engine's own
  exported lists so the two cannot drift.
- **Anaphora is state that crosses rules.** "Gain control of target creature until end of
  turn. Untap that creature. It gains haste" is three sentences sharing one binding, and a
  generated parser has nowhere natural to keep that — it becomes a module-level variable
  or an `options` bag threaded through every action.
- **Every rule wants its own test.** The way this repository knows a rule works is that
  disabling it breaks a named test. A rule that is a function can be called; a rule inside
  a generated parser can only be reached through the whole parse.

Against that, a generated parser gives a declarative file, error positions for free, and a
grammar somebody can extend without reading TypeScript.

## Decision

**A PEG's shape, written by hand and typed.**

`reader.ts` is the machinery a generator would have emitted: a cursor over tokens, ordered
choice (`first`), and backtracking (`try`, which puts the cursor back wherever a rule gives
up, so no rule can consume tokens and then fail). `phrases.ts` and `verbs.ts` are the rules,
each a function that either matches and returns what it built or leaves the cursor where it
found it. Failures carry the furthest token any rule reached, which is what docs/03 asks for
when it says an unparseable sentence is recorded with its failing position.

## Consequences

- No new dependency, and no generate step to keep fresh in `pnpm check`, CI and the build.
- Every phrase and every verb is a function with a name, so the tests are per rule and the
  sabotage check that this repository relies on works the same way here as everywhere else.
  That paid immediately: sabotaging ten rules found one with no test behind it, and the
  hole it left was a cost read as cheaper than the printed one.
- The anaphora context is a parameter rather than a global, which also makes it *correct*:
  a rule that declares a target and then fails has its declaration rolled back with the
  cursor, and the first version without that rollback gave Giant Growth three targets for
  its one "target creature" and Time Warp seven.
- What the parser emits is **script form** — the friendly YAML shapes — rather than engine
  objects, because a script is what the resolver hands to the loader. So the loader and the
  validator stay the arbiters of whether a parse is playable, and a test loads every parse
  the bootstrap set produces.
- The declarative grammar file docs/03 imagined does not exist. Somebody adding a template
  writes a small function next to the others rather than a rule in a `.peggy` file. If the
  rule count grows past what that can carry, this is the decision to revisit.

## The limit this leaves, deliberately

Ordered choice makes the order of `verbs` part of the grammar, and nothing enforces it: a
new verb inserted above `removal` that happens to match "Destroy target creature" would
shadow it silently. The run over the bootstrap set is what catches that today, and the
golden corpus in 3.4 is what catches it properly.
