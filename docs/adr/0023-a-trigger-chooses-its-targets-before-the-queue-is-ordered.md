# ADR 0023 — A triggered ability chooses its targets before the queue is ordered

- Status: accepted
- Date: 2026-10-22

## Context

A triggered ability that targets has its targets chosen by its controller as it is put on the stack, and one with no legal target is removed from the stack instead (CR 603.3d). The engine put triggers on the stack without asking for targets at all: docs/03 listed it as a gap ("Bond Beetle"), but the auto-scripter had gone on emitting targeted triggers, and the validator called them supported. Measured on the 2026-10-16 data, **375 supported cards** had a triggered ability that targets, every one of which went on the stack with no targets and did nothing — Reclamation Sage destroyed nothing, Angel of Despair nothing.

The rules order is: the player orders their triggers (CR 603.3b), then each is put on the stack in that order and its targets chosen as it is. The engine asks the order as one `orderTriggers` decision and then stacks the whole group in one go, which has nowhere to stop for a target choice in the middle.

## Decision

Each queued trigger that targets is settled **before** the queue is ordered: `settleTriggerTargets` asks its controller a `chooseTargets` decision, offering every legal way up to the same cap a cast has; takes the only way when there is one; and drops the trigger from the queue when there is none (CR 603.3d). Only once every queued trigger has its targets is the queue ordered and stacked, each ability carrying the targets chosen for it.

## Consequences

- The choices offered are the same as in the rules' order: what goes on the stack between two triggers of one batch is other abilities, which none of the bootstrap or auto-scripted targets can name. A trigger that could target an ability on the stack would see the difference, and would need the stacking loop to stop between triggers.
- `orderTriggers` stays one answer, and agents keep answering it the way they do.
- An ability whose only targets are gone by the time it resolves fizzles as a spell does (CR 608.2b), which the stack already handled once it had targets to check.
- docs/03's "triggered abilities that target" gap is closed, and docs/02 lists `chooseTargets` as built.
