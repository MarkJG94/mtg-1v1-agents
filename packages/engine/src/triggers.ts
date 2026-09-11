import type { ObjectId, PlayerId } from '@mtg/shared';
import { characteristics, playerSelMatches } from './characteristics.js';
import type { AbilityDef, Filter, TriggerDef } from './definition.js';
import { type Draft, getObj, hasObj } from './draft.js';
import { type Binding, type EvalCtx, evalCondition, matchesObject, simpleCtx } from './eval.js';
import type { Characteristics, TargetRef, TriggerInstance } from './state.js';

export type TriggerEvent =
  | { on: 'etb'; object: ObjectId }
  | { on: 'ltb'; object: ObjectId }
  | { on: 'dies'; object: ObjectId }
  | { on: 'cast'; object: ObjectId; player: PlayerId; stackId: number }
  | { on: 'attacks'; object: ObjectId; defender: ObjectId | PlayerId }
  | { on: 'blocks'; object: ObjectId; attacker: ObjectId }
  | { on: 'becomesBlocked'; object: ObjectId; blocker: ObjectId }
  | {
      on: 'dealsDamage';
      object: ObjectId;
      target: ObjectId | PlayerId;
      amount: number;
      combat: boolean;
    }
  | { on: 'dealtDamage'; object: ObjectId; source: ObjectId; amount: number; combat: boolean }
  | { on: 'upkeep'; player: PlayerId }
  | { on: 'draw'; player: PlayerId; object: ObjectId }
  | { on: 'endStep'; player: PlayerId }
  | { on: 'beginCombat'; player: PlayerId }
  | { on: 'landfall'; player: PlayerId; object: ObjectId }
  | { on: 'counterPlaced'; object: ObjectId; counter: string }
  | { on: 'sacrificed'; object: ObjectId }
  | { on: 'tapped'; object: ObjectId }
  | { on: 'lifeGain'; player: PlayerId; amount: number }
  | { on: 'discard'; player: PlayerId; object: ObjectId };

function objectFilterMatches(
  d: Draft,
  filter: Filter | 'self' | undefined,
  self: ObjectId,
  subject: ObjectId,
  ctx: EvalCtx,
): boolean {
  if (filter === undefined || filter === 'self') return self === subject;
  return matchesObject(d, filter, subject, ctx);
}

function triggerMatches(
  d: Draft,
  trig: TriggerDef,
  ev: TriggerEvent,
  self: ObjectId,
  controller: PlayerId,
  ctx: EvalCtx,
): boolean {
  if (trig.on !== ev.on) return false;
  switch (ev.on) {
    case 'etb':
    case 'ltb':
    case 'dies':
    case 'attacks':
    case 'blocks':
    case 'becomesBlocked':
    case 'counterPlaced':
    case 'sacrificed':
    case 'tapped':
    case 'dealtDamage':
      return objectFilterMatches(
        d,
        (trig as { filter?: Filter | 'self' }).filter,
        self,
        ev.object,
        ctx,
      );
    case 'dealsDamage': {
      const t = trig as Extract<TriggerDef, { on: 'dealsDamage' }>;
      if (!objectFilterMatches(d, t.filter, self, ev.object, ctx)) return false;
      if (t.combat !== undefined && t.combat !== ev.combat) return false;
      if (t.toPlayer && typeof ev.target !== 'string') return false;
      return true;
    }
    case 'cast': {
      const t = trig as Extract<TriggerDef, { on: 'cast' }>;
      if (!playerSelMatches(t.who ?? 'you', controller, ev.player)) return false;
      if (t.filter) {
        const item = d.stack.find((s) => s.stackId === ev.stackId);
        if (!item) return false;
        return matchesObject(d, { ...t.filter, zone: 'stack' }, ev.object, ctx);
      }
      return true;
    }
    case 'upkeep':
    case 'endStep':
    case 'beginCombat':
    case 'draw':
    case 'landfall':
    case 'lifeGain':
    case 'discard': {
      const t = trig as { who?: 'you' | 'opponent' | 'any' };
      return playerSelMatches(t.who ?? 'you', controller, ev.player);
    }
  }
}

function bindingsFor(d: Draft, ev: TriggerEvent): Record<string, Binding> {
  const b: Record<string, Binding> = {};
  const objRef = (id: ObjectId): TargetRef => ({
    kind: 'object',
    id,
    instance: hasObj(d, id) ? getObj(d, id).instance : -1,
  });
  const anyRef = (t: ObjectId | PlayerId): TargetRef =>
    typeof t === 'string' ? { kind: 'player', player: t } : objRef(t);
  if ('object' in ev) {
    b.triggerObject = objRef(ev.object);
    b.it = b.triggerObject;
  }
  if ('player' in ev) b.triggerPlayer = { kind: 'player', player: ev.player };
  if ('amount' in ev) b.amount = ev.amount;
  if ('defender' in ev) b.defender = anyRef(ev.defender);
  if ('attacker' in ev) b.attacker = objRef(ev.attacker);
  if ('blocker' in ev) b.blocker = objRef(ev.blocker);
  if ('target' in ev) b.target = anyRef(ev.target);
  if ('source' in ev) b.damageSource = objRef(ev.source);
  if ('stackId' in ev) b.spell = { kind: 'stack', stackId: ev.stackId };
  return b;
}

/**
 * Collects triggered abilities that trigger on `ev` into `pendingTriggers`. `lki` supplies characteristics for
 * objects that just left the battlefield (CR 603.10) so "dies" and "leaves" triggers look back in time.
 */
export function fireTrigger(
  d: Draft,
  ev: TriggerEvent,
  lki?: Map<ObjectId, Characteristics>,
): void {
  const lookup = (id: ObjectId): Characteristics => lki?.get(id) ?? characteristics(d, id);
  const candidates: { id: ObjectId; chars: Characteristics }[] = [];
  for (const p of ['A', 'B'] as const) {
    for (const id of d.zones[p].battlefield) candidates.push({ id, chars: lookup(id) });
  }
  // Leaves-the-battlefield abilities of the object(s) that just left, using their last known information.
  if (lki) {
    for (const [id, chars] of lki) {
      if (!candidates.some((c) => c.id === id)) candidates.push({ id, chars });
    }
  }
  for (const { id, chars } of candidates) {
    if (chars.flags.noAbilities) continue;
    chars.abilities.forEach((a: AbilityDef, i) => {
      if (a.kind !== 'triggered') return;
      const controller = chars.controller;
      const ctx: EvalCtx = { ...simpleCtx(d, controller, id), chars: lookup, sourceLki: chars };
      if (!triggerMatches(d, a.trigger, ev, id, controller, ctx)) return;
      if (a.oncePerTurn) {
        const o = hasObj(d, id) ? getObj(d, id) : null;
        if (o && (o.abilityActivationsThisTurn[i] ?? 0) > 0) return;
      }
      const bindings = bindingsFor(d, ev);
      const condCtx: EvalCtx = { ...ctx, bindings };
      if (a.condition && !evalCondition(d, a.condition, condCtx)) return;
      if (a.oncePerTurn && hasObj(d, id)) {
        const o = getObj(d, id);
        d.objects[id] = {
          ...o,
          abilityActivationsThisTurn: { ...o.abilityActivationsThisTurn, [i]: 1 },
        };
      }
      const inst: TriggerInstance = {
        controller,
        source: { id, instance: hasObj(d, id) ? getObj(d, id).instance : -1 },
        abilityIndex: i,
        ability: a,
        effects: a.effects,
        targetSpecs: a.targets ?? [],
        sourceLki: chars,
        bindings,
        condition: a.condition ?? null,
        optional: a.optional ?? false,
        delayedId: null,
      };
      d.pendingTriggers.push(inst);
    });
  }
  // Delayed triggers.
  for (const dt of d.delayedTriggers) {
    const trig = dt.trigger;
    let fires = false;
    if (trig.on === 'nextEndStep')
      fires = ev.on === 'endStep' && !(dt.createdInEndStep && dt.createdTurn === d.turn);
    else if (trig.on === 'nextUpkeep') fires = ev.on === 'upkeep';
    else {
      const ctx: EvalCtx = {
        ...simpleCtx(d, dt.controller, dt.source.id),
        chars: lookup,
        sourceLki: dt.sourceLki,
        bindings: dt.bindings,
      };
      fires = triggerMatches(d, trig, ev, dt.source.id, dt.controller, ctx);
    }
    if (!fires) continue;
    d.pendingTriggers.push({
      controller: dt.controller,
      source: dt.source,
      abilityIndex: -1,
      ability: null,
      effects: dt.effects,
      targetSpecs: [],
      sourceLki: dt.sourceLki,
      bindings: { ...dt.bindings, ...bindingsFor(d, ev) },
      condition: null,
      optional: false,
      delayedId: dt.id,
    });
  }
}
