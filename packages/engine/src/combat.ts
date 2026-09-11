import type { ObjectId, PlayerId } from '@mtg/shared';
import { opponentOf } from '@mtg/shared';
import { characteristics } from './characteristics.js';
import { type DamageEntry, dealDamage, hasProtectionFrom } from './damage.js';
import { type Draft, emit, getObj, hasObj } from './draft.js';
import { matchesObject, simpleCtx } from './eval.js';
import type { Frame } from './frames.js';
import { expectAnswer, IllegalDecision, popFrame, replaceTop, setDecision } from './stack.js';
import type { Characteristics, DecisionAnswer } from './state.js';
import { fireTrigger } from './triggers.js';
import { tap } from './zones.js';

export function canAttack(d: Draft, id: ObjectId): boolean {
  const o = getObj(d, id);
  const c = characteristics(d, id);
  if (!c.types.includes('creature') || o.tapped) return false;
  if (o.sick && !c.keywords.has('haste')) return false;
  if (c.keywords.has('defender') || c.flags.cantAttack) return false;
  return true;
}

export function attackCandidates(
  d: Draft,
): { attacker: ObjectId; defenders: (ObjectId | PlayerId)[] }[] {
  const ap = d.activePlayer;
  const opp = opponentOf(ap);
  const defenders: (ObjectId | PlayerId)[] = [opp];
  for (const id of d.zones[opp].battlefield)
    if (characteristics(d, id).types.includes('planeswalker')) defenders.push(id);
  const out: { attacker: ObjectId; defenders: (ObjectId | PlayerId)[] }[] = [];
  for (const id of d.zones[ap].battlefield)
    if (canAttack(d, id)) out.push({ attacker: id, defenders });
  return out;
}

export function runDeclareAttackers(
  d: Draft,
  frame: Extract<Frame, { k: 'declareAttackers' }>,
  answer: DecisionAnswer | null,
): void {
  const candidates = attackCandidates(d);
  const required = candidates
    .filter((c) => characteristics(d, c.attacker).flags.mustAttack)
    .map((c) => c.attacker);
  if (candidates.length === 0) {
    popFrame(d);
    d.combat = {
      attackers: [],
      blockers: {},
      firstStrikeStepHappened: false,
      dealtFirstStrike: [],
    };
    return;
  }
  if (!answer) {
    replaceTop(d, frame);
    setDecision(d, { kind: 'declareAttackers', player: d.activePlayer, candidates, required });
    return;
  }
  const ans = expectAnswer(answer, 'declareAttackers');
  const seen = new Set<ObjectId>();
  for (const a of ans.attacks) {
    const cand = candidates.find((c) => c.attacker === a.attacker);
    if (!cand || seen.has(a.attacker)) throw new IllegalDecision(`illegal attacker ${a.attacker}`);
    if (!cand.defenders.includes(a.defender)) throw new IllegalDecision('illegal defender');
    seen.add(a.attacker);
  }
  for (const r of required)
    if (!seen.has(r)) throw new IllegalDecision(`creature ${r} must attack`);
  popFrame(d);
  d.combat = {
    attackers: ans.attacks.map((a) => ({
      attacker: a.attacker,
      defender: a.defender,
      blockers: [],
      blockerOrder: [],
      blocked: false,
      removedFromCombat: false,
    })),
    blockers: {},
    firstStrikeStepHappened: false,
    dealtFirstStrike: [],
  };
  for (const a of ans.attacks) {
    const c = characteristics(d, a.attacker);
    if (!c.keywords.has('vigilance')) tap(d, a.attacker);
    d.turnFlags.attackedThisTurn.push(a.attacker);
    emit(d, { type: 'attack', attacker: a.attacker, defender: a.defender });
  }
  for (const a of ans.attacks)
    fireTrigger(d, { on: 'attacks', object: a.attacker, defender: a.defender });
}

export function canBlock(d: Draft, blocker: ObjectId, attacker: ObjectId): boolean {
  const bo = getObj(d, blocker);
  const bc = characteristics(d, blocker);
  if (!bc.types.includes('creature') || bo.tapped || bc.flags.cantBlock) return false;
  if (!hasObj(d, attacker)) return false;
  const ac = characteristics(d, attacker);
  if (ac.flags.cantBeBlocked) return false;
  if (ac.keywords.has('flying') && !bc.keywords.has('flying') && !bc.keywords.has('reach'))
    return false;
  if (
    ac.protections.length > 0 &&
    hasProtectionFrom(d, ac, bc, blocker, getObj(d, attacker).controller)
  )
    return false;
  for (const f of ac.flags.cantBeBlockedBy) {
    if (matchesObject(d, f, blocker, simpleCtx(d, getObj(d, attacker).controller, attacker)))
      return false;
  }
  return true;
}

export function blockCandidates(d: Draft): { blocker: ObjectId; attackers: ObjectId[] }[] {
  if (!d.combat) return [];
  const def = opponentOf(d.activePlayer);
  const attackers = d.combat.attackers.filter((a) => !a.removedFromCombat).map((a) => a.attacker);
  const out: { blocker: ObjectId; attackers: ObjectId[] }[] = [];
  for (const id of d.zones[def].battlefield) {
    const can = attackers.filter((a) => canBlock(d, id, a));
    if (can.length > 0) out.push({ blocker: id, attackers: can });
  }
  return out;
}

export function runDeclareBlockers(
  d: Draft,
  frame: Extract<Frame, { k: 'declareBlockers' }>,
  answer: DecisionAnswer | null,
): void {
  let f = frame;
  if (!d.combat) {
    popFrame(d);
    return;
  }
  if (f.stage === 'declare') {
    const candidates = blockCandidates(d);
    if (candidates.length === 0) {
      popFrame(d);
      return;
    }
    const menace = d.combat.attackers
      .filter((a) => !a.removedFromCombat && characteristics(d, a.attacker).keywords.has('menace'))
      .map((a) => a.attacker);
    if (!answer) {
      replaceTop(d, f);
      setDecision(d, {
        kind: 'declareBlockers',
        player: opponentOf(d.activePlayer),
        candidates,
        menace,
      });
      return;
    }
    const ans = expectAnswer(answer, 'declareBlockers');
    answer = null;
    const seen = new Set<ObjectId>();
    const perAttacker = new Map<ObjectId, ObjectId[]>();
    for (const b of ans.blocks) {
      const cand = candidates.find((c) => c.blocker === b.blocker);
      if (!cand || seen.has(b.blocker) || !cand.attackers.includes(b.attacker))
        throw new IllegalDecision('illegal block');
      seen.add(b.blocker);
      perAttacker.set(b.attacker, [...(perAttacker.get(b.attacker) ?? []), b.blocker]);
    }
    for (const m of menace)
      if ((perAttacker.get(m)?.length ?? 0) === 1)
        throw new IllegalDecision('menace requires two or more blockers');
    for (const a of d.combat.attackers) {
      const bs = perAttacker.get(a.attacker) ?? [];
      a.blockers = bs;
      a.blockerOrder = bs.slice();
      a.blocked = bs.length > 0;
    }
    for (const b of ans.blocks) {
      d.combat.blockers[b.blocker] = [...(d.combat.blockers[b.blocker] ?? []), b.attacker];
      emit(d, { type: 'block', blocker: b.blocker, attacker: b.attacker });
    }
    for (const b of ans.blocks)
      fireTrigger(d, { on: 'blocks', object: b.blocker, attacker: b.attacker });
    for (const a of d.combat.attackers)
      if (a.blocked)
        fireTrigger(d, { on: 'becomesBlocked', object: a.attacker, blocker: a.blockers[0]! });
    f = {
      ...f,
      stage: 'order',
      orderQueue: d.combat.attackers.filter((a) => a.blockers.length > 1).map((a) => a.attacker),
    };
  }
  // Damage assignment order for attackers blocked by multiple creatures (CR 509.2).
  while (f.orderQueue.length > 0) {
    const attackerId = f.orderQueue[0]!;
    const a = d.combat.attackers.find((x) => x.attacker === attackerId);
    if (!a || a.blockers.length < 2) {
      f = { ...f, orderQueue: f.orderQueue.slice(1) };
      continue;
    }
    if (!answer) {
      replaceTop(d, f);
      setDecision(d, {
        kind: 'orderBlockers',
        player: d.activePlayer,
        attacker: attackerId,
        blockers: a.blockers.slice(),
      });
      return;
    }
    const ans = expectAnswer(answer, 'orderBlockers');
    answer = null;
    if (
      ans.order.length !== a.blockers.length ||
      new Set(ans.order).size !== ans.order.length ||
      ans.order.some((b) => !a.blockers.includes(b))
    )
      throw new IllegalDecision('bad blocker order');
    a.blockerOrder = ans.order.slice();
    f = { ...f, orderQueue: f.orderQueue.slice(1) };
  }
  popFrame(d);
}

function dealsDamageInStep(
  c: Characteristics,
  firstStrike: boolean,
  alreadyDealtFirstStrike: boolean,
): boolean {
  const fs = c.keywords.has('first strike');
  const ds = c.keywords.has('double strike');
  if (firstStrike) return fs || ds;
  if (ds) return true;
  if (fs) return false;
  return !alreadyDealtFirstStrike;
}

export function anyFirstStrikers(d: Draft): boolean {
  if (!d.combat) return false;
  for (const a of d.combat.attackers) {
    if (
      a.removedFromCombat ||
      !hasObj(d, a.attacker) ||
      getObj(d, a.attacker).zone !== 'battlefield'
    )
      continue;
    const c = characteristics(d, a.attacker);
    if (c.keywords.has('first strike') || c.keywords.has('double strike')) return true;
    for (const b of a.blockers) {
      if (!hasObj(d, b) || getObj(d, b).zone !== 'battlefield') continue;
      const bc = characteristics(d, b);
      if (bc.keywords.has('first strike') || bc.keywords.has('double strike')) return true;
    }
  }
  return false;
}

function lethalFor(d: Draft, target: ObjectId, deathtouch: boolean, assigned: number): number {
  if (deathtouch) return Math.max(0, 1 - assigned);
  const c = characteristics(d, target);
  const o = getObj(d, target);
  return Math.max(0, c.toughness - o.damage - assigned);
}

interface Recipient {
  id: ObjectId | PlayerId;
  lethal: number;
}

function recipientsFor(
  d: Draft,
  attacker: ObjectId,
  a: { defender: ObjectId | PlayerId; blockerOrder: ObjectId[]; blocked: boolean },
  trample: boolean,
  deathtouch: boolean,
): Recipient[] {
  const out: Recipient[] = [];
  if (!a.blocked) {
    if (
      typeof a.defender === 'number' &&
      (!hasObj(d, a.defender) || getObj(d, a.defender).zone !== 'battlefield')
    )
      return out;
    out.push({ id: a.defender, lethal: 0 });
    return out;
  }
  for (const b of a.blockerOrder) {
    if (!hasObj(d, b) || getObj(d, b).zone !== 'battlefield') continue;
    out.push({ id: b, lethal: lethalFor(d, b, deathtouch, 0) });
  }
  if (
    trample &&
    !(
      typeof a.defender === 'number' &&
      (!hasObj(d, a.defender) || getObj(d, a.defender).zone !== 'battlefield')
    )
  )
    out.push({ id: a.defender, lethal: 0 });
  if (out.length === 0 && trample) out.push({ id: a.defender, lethal: 0 });
  void attacker;
  return out;
}

/** Default assignment: lethal to each blocker in order, remainder to the last (or the defender with trample). */
function _autoAssign(
  recipients: Recipient[],
  amount: number,
  trample: boolean,
): { id: ObjectId | PlayerId; amount: number }[] {
  const out: { id: ObjectId | PlayerId; amount: number }[] = [];
  let remaining = amount;
  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i]!;
    const isLast = i === recipients.length - 1;
    const isDefender = trample && isLast && typeof r.id === 'string';
    let give: number;
    if (isDefender) give = remaining;
    else if (isLast) give = remaining;
    else give = Math.min(remaining, r.lethal);
    if (give > 0) out.push({ id: r.id, amount: give });
    remaining -= give;
    if (remaining <= 0) break;
  }
  return out;
}

function validateAssignment(
  recipients: Recipient[],
  amount: number,
  assignments: { id: ObjectId | PlayerId; amount: number }[],
): void {
  let total = 0;
  for (const a of assignments) {
    if (!recipients.some((r) => r.id === a.id))
      throw new IllegalDecision('damage assigned to a non-recipient');
    if (a.amount < 0 || !Number.isInteger(a.amount)) throw new IllegalDecision('bad damage amount');
    total += a.amount;
  }
  if (total !== amount) throw new IllegalDecision(`must assign exactly ${amount} damage`);
  // CR 510.1c-d: lethal damage to each earlier recipient before assigning to a later one.
  let deficitSeen = false;
  for (const r of recipients) {
    const got = assignments.filter((a) => a.id === r.id).reduce((acc, a) => acc + a.amount, 0);
    if (deficitSeen && got > 0) throw new IllegalDecision('must assign lethal damage in order');
    if (typeof r.id === 'number' && got < r.lethal) deficitSeen = true;
  }
}

export function runCombatDamage(
  d: Draft,
  frame: Extract<Frame, { k: 'combatDamage' }>,
  answer: DecisionAnswer | null,
): void {
  let f = frame;
  if (!d.combat) {
    popFrame(d);
    return;
  }
  const combat = d.combat;
  while (f.queue.length > 0) {
    const attackerId = f.queue[0]!;
    const a = combat.attackers.find((x) => x.attacker === attackerId);
    if (
      !a ||
      a.removedFromCombat ||
      !hasObj(d, attackerId) ||
      getObj(d, attackerId).zone !== 'battlefield'
    ) {
      f = { ...f, queue: f.queue.slice(1) };
      continue;
    }
    const c = characteristics(d, attackerId);
    const amount = Math.max(0, c.power);
    const trample = c.keywords.has('trample');
    const deathtouch = c.keywords.has('deathtouch');
    const recipients = recipientsFor(d, attackerId, a, trample, deathtouch);
    if (amount === 0 || recipients.length === 0) {
      f = { ...f, queue: f.queue.slice(1), assignments: { ...f.assignments, [attackerId]: [] } };
      continue;
    }
    const needsChoice = recipients.length > 1;
    let assignment: { id: ObjectId | PlayerId; amount: number }[];
    if (!needsChoice) assignment = [{ id: recipients[0]!.id, amount }];
    else if (!answer) {
      replaceTop(d, f);
      setDecision(d, {
        kind: 'assignDamage',
        player: d.activePlayer,
        attacker: attackerId,
        amount,
        recipients,
        trample,
        defender: a.defender,
      });
      return;
    } else {
      const ans = expectAnswer(answer, 'assignDamage');
      answer = null;
      validateAssignment(recipients, amount, ans.assignments);
      assignment = ans.assignments;
    }
    f = {
      ...f,
      queue: f.queue.slice(1),
      assignments: { ...f.assignments, [attackerId]: assignment },
    };
  }
  replaceTop(d, f);
  popFrame(d);
  dealCombatDamage(d, f);
}

function dealCombatDamage(d: Draft, f: Extract<Frame, { k: 'combatDamage' }>): void {
  const combat = d.combat!;
  const entries: DamageEntry[] = [];
  for (const a of combat.attackers) {
    if (
      a.removedFromCombat ||
      !hasObj(d, a.attacker) ||
      getObj(d, a.attacker).zone !== 'battlefield'
    )
      continue;
    const c = characteristics(d, a.attacker);
    if (!dealsDamageInStep(c, f.firstStrike, combat.dealtFirstStrike.includes(a.attacker)))
      continue;
    const assignment = f.assignments[a.attacker];
    if (!assignment) continue;
    for (const x of assignment)
      entries.push({ source: a.attacker, target: x.id, amount: x.amount, combat: true });
    if (f.firstStrike) combat.dealtFirstStrike.push(a.attacker);
  }
  // Blockers deal damage to the attackers they block (CR 510.1c).
  for (const a of combat.attackers) {
    if (
      a.removedFromCombat ||
      !hasObj(d, a.attacker) ||
      getObj(d, a.attacker).zone !== 'battlefield'
    )
      continue;
    for (const b of a.blockers) {
      if (!hasObj(d, b) || getObj(d, b).zone !== 'battlefield') continue;
      const bc = characteristics(d, b);
      if (!dealsDamageInStep(bc, f.firstStrike, combat.dealtFirstStrike.includes(b))) continue;
      if (bc.power > 0)
        entries.push({ source: b, target: a.attacker, amount: bc.power, combat: true });
      if (f.firstStrike) combat.dealtFirstStrike.push(b);
    }
  }
  if (f.firstStrike) combat.firstStrikeStepHappened = true;
  dealDamage(d, entries);
}

/** Attackers whose damage needs to be assigned this step (those that deal damage in it). */
export function combatDamageQueue(d: Draft, firstStrike: boolean): ObjectId[] {
  if (!d.combat) return [];
  const out: ObjectId[] = [];
  for (const a of d.combat.attackers) {
    if (
      a.removedFromCombat ||
      !hasObj(d, a.attacker) ||
      getObj(d, a.attacker).zone !== 'battlefield'
    )
      continue;
    const c = characteristics(d, a.attacker);
    if (dealsDamageInStep(c, firstStrike, d.combat.dealtFirstStrike.includes(a.attacker)))
      out.push(a.attacker);
  }
  return out;
}
