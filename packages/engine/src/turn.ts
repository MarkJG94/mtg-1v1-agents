import type { PlayerId, Step } from '@mtg/shared';
import { opponentOf, STEPS } from '@mtg/shared';
import { characteristics, maxHandSize } from './characteristics.js';
import { anyFirstStrikers, combatDamageQueue } from './combat.js';
import { type Draft, emit, getObj, invalidate, obj } from './draft.js';
import type { Frame } from './frames.js';
import { discardCard, drawCard, emptyManaPool } from './players.js';
import { endGame } from './sba.js';
import {
  expectAnswer,
  IllegalDecision,
  popFrame,
  pushFrame,
  replaceTop,
  setDecision,
} from './stack.js';
import type { DecisionAnswer } from './state.js';
import { fireTrigger } from './triggers.js';
import { untap } from './zones.js';

function nextStep(step: Step): Step | null {
  const i = STEPS.indexOf(step);
  return STEPS[i + 1] ?? null;
}

export function beginTurn(d: Draft, player: PlayerId, extra: boolean): void {
  if (d.turn >= d.config.turnCap && !d.result) {
    endGame(d, null, 'turnCap');
    return;
  }
  d.turn++;
  d.activePlayer = player;
  d.turnFlags = {
    ...d.turnFlags,
    isExtraTurn: extra,
    attackedThisTurn: [],
    stateHashes: [],
    priorityDecisions: 0,
  };
  for (const p of ['A', 'B'] as const) {
    const ps = d.players[p];
    ps.landsPlayedThisTurn = 0;
    ps.lifeGainedThisTurn = 0;
    ps.lifeLostThisTurn = 0;
    ps.spellsCastThisTurn = 0;
    ps.drawnThisTurn = 0;
  }
  for (const p of ['A', 'B'] as const) {
    for (const id of d.zones[p].battlefield) {
      const o = getObj(d, id);
      if (
        o.enteredThisTurn ||
        o.loyaltyActivationsThisTurn > 0 ||
        Object.keys(o.abilityActivationsThisTurn).length > 0 ||
        (o.sick && p === player)
      ) {
        const w = obj(d, id);
        w.enteredThisTurn = false;
        w.loyaltyActivationsThisTurn = 0;
        w.abilityActivationsThisTurn = {};
        if (p === player) w.sick = false;
      }
    }
  }
  // "Until your next turn" effects end.
  const before = d.effects.length;
  d.effects = d.effects.filter(
    (e) =>
      !(
        e.duration.kind === 'untilYourNextTurn' &&
        e.duration.player === player &&
        e.duration.turnSeen < d.turn
      ),
  );
  if (d.effects.length !== before) invalidate(d);
  d.combat = null;
  d.priority = null;
  d.passes = 0;
  emit(d, { type: 'turnStart', player, extra });
  d.step = 'untap';
  pushFrame(d, { k: 'beginStep' });
}

/** Turn-based actions at the start of the current step, then hands priority (or moves on for untap/cleanup). */
export function runBeginStep(d: Draft): void {
  popFrame(d);
  const ap = d.activePlayer;
  emit(d, { type: 'stepStart' });
  d.priority = null;
  d.passes = 0;
  switch (d.step) {
    case 'untap': {
      for (const id of d.zones[ap].battlefield) {
        const c = characteristics(d, id);
        if (c.flags.doesntUntap) continue;
        untap(d, id);
      }
      pushFrame(d, { k: 'advanceStep' });
      return;
    }
    case 'upkeep':
      fireTrigger(d, { on: 'upkeep', player: ap });
      break;
    case 'draw': {
      const skip = d.turn === 1 && ap === d.startingPlayer && !d.config.firstPlayerDraws;
      if (!skip) drawCard(d, ap);
      break;
    }
    case 'beginCombat':
      fireTrigger(d, { on: 'beginCombat', player: ap });
      break;
    case 'declareAttackers':
      pushFrame(d, { k: 'declareAttackers', stage: 'declare' });
      break;
    case 'declareBlockers':
      pushFrame(d, { k: 'declareBlockers', stage: 'declare', orderQueue: [] });
      break;
    case 'firstStrikeDamage':
      pushFrame(d, {
        k: 'combatDamage',
        firstStrike: true,
        queue: combatDamageQueue(d, true),
        assignments: {},
      });
      break;
    case 'combatDamage':
      pushFrame(d, {
        k: 'combatDamage',
        firstStrike: false,
        queue: combatDamageQueue(d, false),
        assignments: {},
      });
      break;
    case 'end':
      fireTrigger(d, { on: 'endStep', player: ap });
      break;
    case 'cleanup': {
      pushFrame(d, { k: 'cleanupDiscard' });
      return;
    }
    default:
      break;
  }
  d.priority = ap;
}

export function runCleanupDiscard(d: Draft, answer: DecisionAnswer | null): void {
  const ap = d.activePlayer;
  const hand = d.zones[ap].hand;
  const max = maxHandSize(d, ap);
  if (hand.length > max) {
    const n = hand.length - max;
    if (!answer) {
      setDecision(d, {
        kind: 'chooseObjects',
        player: ap,
        reason: 'discardToHandSize',
        options: hand.slice(),
        min: n,
        max: n,
      });
      return;
    }
    const ans = expectAnswer(answer, 'chooseObjects');
    if (
      ans.objects.length !== n ||
      ans.objects.some((id) => !hand.includes(id)) ||
      new Set(ans.objects).size !== n
    )
      throw new IllegalDecision('bad discard');
    for (const id of ans.objects) discardCard(d, ap, id);
  }
  popFrame(d);
  // CR 514.2: damage wears off and "until end of turn" effects end simultaneously.
  for (const p of ['A', 'B'] as const) {
    for (const id of d.zones[p].battlefield) {
      const o = getObj(d, id);
      if (o.damage > 0 || o.deathtouched || o.regenerationShields > 0 || o.preventionShield > 0) {
        const w = obj(d, id);
        w.damage = 0;
        w.deathtouched = false;
        w.regenerationShields = 0;
        w.preventionShield = 0;
      }
    }
  }
  const before = d.effects.length;
  const ended = d.effects.filter((e) => e.duration.kind === 'untilEndOfTurn');
  d.effects = d.effects.filter((e) => e.duration.kind !== 'untilEndOfTurn');
  for (const e of ended) emit(d, { type: 'effectEnd', effect: e.id });
  if (d.effects.length !== before) invalidate(d);
  emptyManaPool(d, 'A');
  emptyManaPool(d, 'B');
  // CR 514.3a: if SBAs or triggers happen now, players get priority and another cleanup step follows.
  d.priority = null;
  d.passes = 0;
  pushFrame(d, { k: 'advanceStep' });
}

function shouldSkip(d: Draft, step: Step): boolean {
  switch (step) {
    case 'declareBlockers':
    case 'combatDamage':
      return !d.combat || d.combat.attackers.every((a) => a.removedFromCombat);
    case 'firstStrikeDamage':
      return (
        !d.combat || d.combat.attackers.every((a) => a.removedFromCombat) || !anyFirstStrikers(d)
      );
    default:
      return false;
  }
}

export function runAdvanceStep(d: Draft): void {
  popFrame(d);
  emptyManaPool(d, 'A');
  emptyManaPool(d, 'B');
  d.priority = null;
  d.passes = 0;
  if (d.step === 'cleanup') {
    // Repeat cleanup if triggers were put on the stack or SBAs happened during it (handled by the caller giving priority).
    if (d.stack.length > 0 || d.pendingTriggers.length > 0) {
      d.step = 'cleanup';
      pushFrame(d, { k: 'beginStep' });
      return;
    }
    const extra = d.turnFlags.extraTurns.shift();
    if (extra !== undefined) beginTurn(d, extra, true);
    else beginTurn(d, opponentOf(d.activePlayer), false);
    return;
  }
  if (d.step === 'endCombat') d.combat = null;
  let next = nextStep(d.step);
  while (next && shouldSkip(d, next)) next = nextStep(next);
  if (!next) throw new Error('advanceStep past cleanup');
  d.step = next;
  pushFrame(d, { k: 'beginStep' });
}

export function runFrameForTurn(d: Draft, f: Frame, answer: DecisionAnswer | null): boolean {
  switch (f.k) {
    case 'beginStep':
      runBeginStep(d);
      return true;
    case 'advanceStep':
      runAdvanceStep(d);
      return true;
    case 'cleanupDiscard':
      runCleanupDiscard(d, answer);
      return true;
    default:
      return false;
  }
}

export { replaceTop };
