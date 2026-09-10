import type { ObjectId, PlayerId } from '@mtg/shared';
import { characteristics } from './characteristics.js';
import type { Affects } from './definition.js';
import { type Draft, emit, getObj, hasObj, obj } from './draft.js';
import { evalQuantity, matchesObject, simpleCtx } from './eval.js';
import { gainLife, loseLife } from './players.js';
import { activeReplacements, replacementAppliesToObject } from './replacements.js';
import type { Characteristics } from './state.js';
import { fireTrigger } from './triggers.js';
import { removeCounters } from './zones.js';

export interface DamageEntry {
  source: ObjectId;
  target: ObjectId | PlayerId;
  amount: number;
  combat: boolean;
}

function affectsMatches(
  d: Draft,
  affects: Affects | 'you',
  source: ObjectId,
  controller: PlayerId,
  target: ObjectId | PlayerId,
): boolean {
  if (typeof target === 'string') return affects === 'you' && target === controller;
  if (affects === 'you') return false;
  if (affects === 'self') return source === target;
  if (affects === 'attached') return hasObj(d, source) && getObj(d, source).attachedTo === target;
  return matchesObject(d, affects, target, simpleCtx(d, controller, source));
}

/** Applies prevention (CR 615) and damage-modifying replacement effects to one damage entry. */
function modifyDamage(d: Draft, e: DamageEntry): number {
  let amount = e.amount;
  // Damage-doubling / extra damage replacements from permanents.
  for (const r of activeReplacements(d, 'damage', typeof e.target === 'number' ? e.target : null)) {
    if (r.def.event !== 'damage' || !('double' in r.def || 'extra' in r.def)) continue;
    if (!affectsMatches(d, r.def.to, r.source, r.controller, e.target)) continue;
    if ('double' in r.def && r.def.double) amount *= 2;
    if ('extra' in r.def && r.def.extra !== undefined)
      amount += evalQuantity(d, r.def.extra, simpleCtx(d, r.controller, r.source));
  }
  // Prevention from permanents' replacement abilities.
  for (const r of activeReplacements(d, 'damage', typeof e.target === 'number' ? e.target : null)) {
    if (r.def.event !== 'damage' || !('prevent' in r.def)) continue;
    if (r.def.combat && !e.combat) continue;
    if (r.def.noncombat && e.combat) continue;
    if (r.def.from && !replacementAppliesToObject(d, r, r.def.from, e.source)) continue;
    if (!affectsMatches(d, r.def.to, r.source, r.controller, e.target)) continue;
    if (r.def.prevent === 'all') amount = 0;
    else
      amount = Math.max(
        0,
        amount - evalQuantity(d, r.def.prevent, simpleCtx(d, r.controller, r.source)),
      );
  }
  // Prevention effects created by resolved spells/abilities.
  for (const ce of d.effects) {
    if (ce.effect.type !== 'preventDamage') continue;
    if (ce.effect.combat && !e.combat) continue;
    if (ce.effect.noncombat && e.combat) continue;
    const applies = ce.affected
      ? ce.affected.some(
          (r) =>
            typeof e.target === 'number' &&
            r.id === e.target &&
            hasObj(d, r.id) &&
            getObj(d, r.id).instance === r.instance,
        ) ||
        (ce.effect.affects === 'you' && e.target === ce.controller)
      : affectsMatches(d, ce.effect.affects, ce.source.id, ce.controller, e.target);
    if (!applies) continue;
    if (ce.effect.amount === 'all') amount = 0;
    else amount = Math.max(0, amount - ce.effect.amount);
  }
  // Per-object shields ("prevent the next N damage").
  if (typeof e.target === 'number' && amount > 0 && hasObj(d, e.target)) {
    const t = getObj(d, e.target);
    if (t.preventionShield > 0) {
      const used = Math.min(t.preventionShield, amount);
      obj(d, e.target).preventionShield -= used;
      amount -= used;
    }
  }
  // Protection prevents damage from sources with the protected quality (CR 702.16b).
  if (
    typeof e.target === 'number' &&
    amount > 0 &&
    hasObj(d, e.target) &&
    getObj(d, e.target).zone === 'battlefield'
  ) {
    const tc = characteristics(d, e.target);
    if (tc.protections.length > 0 && hasObj(d, e.source)) {
      const sc = sourceChars(d, e.source);
      if (hasProtectionFrom(d, tc, sc, e.source, getObj(d, e.target).controller)) amount = 0;
    }
  }
  return amount;
}

export function sourceChars(d: Draft, id: ObjectId): Characteristics {
  const o = getObj(d, id);
  if (o.zone === 'battlefield' || o.zone === 'stack') return characteristics(d, id);
  return o.lki ?? characteristics(d, id);
}

export function hasProtectionFrom(
  d: Draft,
  target: Characteristics,
  source: Characteristics,
  sourceId: ObjectId,
  targetController: PlayerId,
): boolean {
  for (const p of target.protections) {
    if ('everything' in p) return true;
    if ('color' in p && source.colors.includes(p.color)) return true;
    if ('colored' in p && source.colors.length > 0) return true;
    if ('type' in p && source.types.includes(p.type)) return true;
    if ('filter' in p) {
      const ctx = {
        ...simpleCtx(d, targetController, null),
        chars: (x: ObjectId) => (x === sourceId ? source : characteristics(d, x)),
      };
      if (matchesObject(d, { ...p.filter, zone: undefined as never }, sourceId, ctx)) return true;
    }
  }
  return false;
}

/**
 * Deals a batch of damage simultaneously (CR 510.2, 120.3). Lifelink life gain and deathtouch marking happen as
 * part of the same event batch so SBAs see the combined result.
 */
export function dealDamage(d: Draft, entries: DamageEntry[]): number {
  let total = 0;
  const applied: { e: DamageEntry; amount: number }[] = [];
  for (const e of entries) {
    if (e.amount <= 0) continue;
    if (
      typeof e.target === 'number' &&
      (!hasObj(d, e.target) || getObj(d, e.target).zone !== 'battlefield')
    )
      continue;
    const amount = modifyDamage(d, e);
    if (amount <= 0) continue;
    applied.push({ e, amount });
  }
  for (const { e, amount } of applied) {
    const sc = hasObj(d, e.source) ? sourceChars(d, e.source) : null;
    if (typeof e.target === 'string') {
      loseLife(d, e.target, amount);
    } else {
      const t = obj(d, e.target);
      const tc = characteristics(d, e.target);
      if (tc.types.includes('planeswalker')) {
        removeCounters(d, e.target, 'loyalty', amount);
      }
      if (tc.types.includes('creature')) {
        t.damage += amount;
        if (sc?.keywords.has('deathtouch')) t.deathtouched = true;
      }
    }
    emit(d, { type: 'damage', source: e.source, target: e.target, amount, combat: e.combat });
    total += amount;
    if (sc?.keywords.has('lifelink') && hasObj(d, e.source))
      gainLife(d, getObj(d, e.source).controller, amount);
  }
  d.sbaPending = true;
  for (const { e, amount } of applied) {
    fireTrigger(d, {
      on: 'dealsDamage',
      object: e.source,
      target: e.target,
      amount,
      combat: e.combat,
    });
    if (typeof e.target === 'number')
      fireTrigger(d, {
        on: 'dealtDamage',
        object: e.target,
        source: e.source,
        amount,
        combat: e.combat,
      });
  }
  return total;
}
