import type { ObjectId, PlayerId } from '@mtg/shared';
import type { Rng } from '../rng.js';
import type { Decision, DecisionAnswer, GameState, TargetRef } from '../state.js';
import { targetCountRange } from '../targets.js';

function subset<T>(rng: Rng, items: readonly T[], min: number, max: number): T[] {
  const n = min + rng.int(Math.max(1, max - min + 1));
  return rng.shuffle(items).slice(0, Math.min(n, items.length));
}

/**
 * Answers any decision uniformly at random among its legal options. Used by the invariant fuzzer and as the
 * `random` agent level; never inspects hidden information beyond what the decision exposes.
 */
export function randomAnswer(
  state: GameState,
  dec: Decision,
  rng: Rng,
  opts: { passBias?: number } = {},
): DecisionAnswer {
  switch (dec.kind) {
    case 'mulligan':
      return { kind: 'mulligan', keep: dec.mulligans >= 2 || rng.float() < 0.85 };
    case 'bottomCards':
      return { kind: 'bottomCards', cards: subset(rng, dec.hand, dec.count, dec.count) };
    case 'priority': {
      const bias = opts.passBias ?? 0;
      if (dec.actions.length === 1 || rng.float() < bias)
        return { kind: 'priority', action: { kind: 'pass' } };
      return { kind: 'priority', action: rng.pick(dec.actions) };
    }
    case 'chooseTargets': {
      const targets: TargetRef[][] = dec.specs.map((spec, i) => {
        const { min, max } = targetCountRange(spec);
        const cands = dec.candidates[i]!;
        return subset(rng, cands, Math.min(min, cands.length), Math.min(max, cands.length));
      });
      return { kind: 'chooseTargets', targets };
    }
    case 'chooseMode':
      return {
        kind: 'chooseMode',
        modes: subset(
          rng,
          dec.modes.map((_, i) => i),
          dec.min,
          dec.max,
        ),
      };
    case 'chooseX':
      return { kind: 'chooseX', x: rng.int(dec.max + 1) };
    case 'payMana':
      return { kind: 'payMana', option: 0 };
    case 'declareAttackers': {
      const chosen = new Set(
        subset(
          rng,
          dec.candidates.map((c) => c.attacker),
          0,
          dec.candidates.length,
        ),
      );
      for (const r of dec.required) chosen.add(r);
      const attacks = dec.candidates
        .filter((c) => chosen.has(c.attacker))
        .map((c) => ({ attacker: c.attacker, defender: rng.pick(c.defenders) }));
      return { kind: 'declareAttackers', attacks };
    }
    case 'declareBlockers': {
      const chosen = subset(rng, dec.candidates, 0, dec.candidates.length);
      let blocks = chosen.map((c) => ({ blocker: c.blocker, attacker: rng.pick(c.attackers) }));
      for (const m of dec.menace) {
        const bs = blocks.filter((b) => b.attacker === m);
        if (bs.length === 1) blocks = blocks.filter((b) => b.attacker !== m);
      }
      return { kind: 'declareBlockers', blocks };
    }
    case 'orderBlockers':
      return { kind: 'orderBlockers', order: rng.shuffle(dec.blockers) };
    case 'assignDamage': {
      // Lethal to each recipient in order; any remainder to a random later recipient (or the last).
      const assignments: { id: ObjectId | PlayerId; amount: number }[] = [];
      let remaining = dec.amount;
      for (let i = 0; i < dec.recipients.length && remaining > 0; i++) {
        const r = dec.recipients[i]!;
        const last = i === dec.recipients.length - 1;
        const give = last ? remaining : Math.min(remaining, r.lethal);
        if (give > 0) assignments.push({ id: r.id, amount: give });
        remaining -= give;
      }
      if (remaining > 0) {
        const last = dec.recipients[dec.recipients.length - 1]!;
        const existing = assignments.find((a) => a.id === last.id);
        if (existing) existing.amount += remaining;
        else assignments.push({ id: last.id, amount: remaining });
      }
      return { kind: 'assignDamage', assignments };
    }
    case 'orderTriggers':
      return { kind: 'orderTriggers', order: rng.shuffle(dec.triggers.map((_, i) => i)) };
    case 'chooseObjects':
      return { kind: 'chooseObjects', objects: subset(rng, dec.options, dec.min, dec.max) };
    case 'chooseCardsFromLibrary':
      return { kind: 'chooseCardsFromLibrary', cards: subset(rng, dec.options, dec.min, dec.max) };
    case 'scry': {
      const shuffled = rng.shuffle(dec.cards);
      const k = rng.int(shuffled.length + 1);
      return { kind: 'scry', top: shuffled.slice(0, k), bottom: shuffled.slice(k) };
    }
    case 'yesNo':
      return { kind: 'yesNo', yes: rng.bool() };
    case 'chooseOption':
      return { kind: 'chooseOption', option: rng.int(dec.options.length) };
    case 'chooseReplacement':
      return { kind: 'chooseReplacement', option: rng.int(dec.options.length) };
    case 'distributeCounters': {
      const amounts = dec.recipients.map(() => 0);
      for (let i = 0; i < dec.total; i++) amounts[rng.int(amounts.length)]!++;
      return { kind: 'distributeCounters', amounts };
    }
    case 'chooseColor':
      return { kind: 'chooseColor', color: rng.pick(['W', 'U', 'B', 'R', 'G'] as const) };
    case 'declareAttackersOptional':
      return { kind: 'declareAttackersOptional', attack: rng.bool() };
  }
  void state;
}
