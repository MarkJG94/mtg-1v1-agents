import type { ObjectId, PlayerId } from '@mtg/shared';
import { characteristics, playerSelMatches } from './characteristics.js';
import type { Filter, ReplacementDef } from './definition.js';
import type { Draft } from './draft.js';
import { getObj, hasObj } from './draft.js';
import { type EvalCtx, evalCondition, evalQuantity, matchesObject, simpleCtx } from './eval.js';

export interface ActiveReplacement {
  source: ObjectId;
  controller: PlayerId;
  timestamp: number;
  def: ReplacementDef;
  /** Self-replacement effects apply first (CR 616.1a). */
  self: boolean;
}

/** Replacement abilities of permanents on the battlefield, ordered self-first then by timestamp. */
export function activeReplacements(
  d: Draft,
  event: ReplacementDef['event'],
  subject: ObjectId | null,
): ActiveReplacement[] {
  const out: ActiveReplacement[] = [];
  const consider = (id: ObjectId) => {
    if (!hasObj(d, id)) return;
    const c = characteristics(d, id);
    if (c.flags.noAbilities) return;
    const o = getObj(d, id);
    for (const a of c.abilities) {
      if (a.kind !== 'replacement' || a.replaces.event !== event) continue;
      if (a.condition && !evalCondition(d, a.condition, simpleCtx(d, c.controller, id))) continue;
      const filter = 'filter' in a.replaces ? a.replaces.filter : undefined;
      const isSelf = filter === 'self' || ('to' in a.replaces && a.replaces.to === 'self');
      out.push({
        source: id,
        controller: c.controller,
        timestamp: o.timestamp,
        def: a.replaces,
        self: isSelf && subject === id,
      });
    }
  };
  for (const p of ['A', 'B'] as const) for (const id of d.zones[p].battlefield) consider(id);
  // The subject's own replacement abilities apply even when it is not yet on the battlefield (e.g. "enters tapped").
  if (subject !== null && hasObj(d, subject) && getObj(d, subject).zone !== 'battlefield')
    consider(subject);
  out.sort((a, b) => Number(b.self) - Number(a.self) || a.timestamp - b.timestamp);
  return out;
}

export function replacementAppliesToObject(
  d: Draft,
  r: ActiveReplacement,
  filter: Filter | 'self',
  subject: ObjectId,
  lkiCtx?: EvalCtx,
): boolean {
  if (filter === 'self') return r.source === subject;
  const ctx = lkiCtx ?? simpleCtx(d, r.controller, r.source);
  return matchesObject(d, filter, subject, {
    ...ctx,
    controller: r.controller,
    source: { id: r.source, instance: hasObj(d, r.source) ? getObj(d, r.source).instance : -1 },
  });
}

export interface EtbModifiers {
  tapped: boolean;
  counters: Record<string, number>;
}

/** Applies "enters tapped" / "enters with counters" replacements (CR 614.1c). */
export function etbModifiers(
  d: Draft,
  object: ObjectId,
  base: { tapped: boolean; paidUnless: boolean },
): EtbModifiers {
  const mods: EtbModifiers = { tapped: base.tapped, counters: {} };
  for (const r of activeReplacements(d, 'etb', object)) {
    if (r.def.event !== 'etb') continue;
    if (!replacementAppliesToObject(d, r, r.def.filter, object)) continue;
    if (r.def.tapped && !(r.def.unlessPay && base.paidUnless)) mods.tapped = true;
    if (r.def.withCounters) {
      const ctx = simpleCtx(d, r.controller, object);
      ctx.x = getObj(d, object).x;
      const n = evalQuantity(d, r.def.withCounters.count, ctx);
      mods.counters[r.def.withCounters.counter] =
        (mods.counters[r.def.withCounters.counter] ?? 0) + n;
    }
  }
  return mods;
}

/** Life the controller may pay to stop an "enters tapped unless" replacement of the object itself, if any. */
export function enterPayOption(d: Draft, object: ObjectId): number | null {
  for (const r of activeReplacements(d, 'etb', object)) {
    if (r.def.event !== 'etb' || !r.def.unlessPay || !r.def.tapped) continue;
    if (!replacementAppliesToObject(d, r, r.def.filter, object)) continue;
    return r.def.unlessPay.life;
  }
  return null;
}

/** Destination override when a creature would die ("if ~ would die, exile it instead"). */
export function diesReplacement(
  d: Draft,
  object: ObjectId,
  lkiCtx: EvalCtx,
): 'exile' | 'libraryBottom' | 'libraryTop' | 'hand' | null {
  for (const r of activeReplacements(d, 'dies', object)) {
    if (r.def.event !== 'dies') continue;
    if (!replacementAppliesToObject(d, r, r.def.filter, object, lkiCtx)) continue;
    return r.def.instead;
  }
  return null;
}

export function drawReplacement(
  d: Draft,
  player: PlayerId,
): Extract<ReplacementDef, { event: 'draw' }> | null {
  for (const r of activeReplacements(d, 'draw', null)) {
    if (r.def.event !== 'draw') continue;
    if (!playerSelMatches(r.def.who, r.controller, player)) continue;
    return r.def;
  }
  return null;
}

export function lifeGainMultiplier(d: Draft, player: PlayerId): number {
  let m = 1;
  for (const r of activeReplacements(d, 'lifeGain', null)) {
    if (r.def.event !== 'lifeGain') continue;
    if (!playerSelMatches(r.def.who, r.controller, player)) continue;
    m *= r.def.multiplier;
  }
  return m;
}

export function extraCounters(d: Draft, object: ObjectId): number {
  let extra = 0;
  for (const r of activeReplacements(d, 'counterPlaced', object)) {
    if (r.def.event !== 'counterPlaced') continue;
    if (!replacementAppliesToObject(d, r, r.def.filter, object)) continue;
    extra += r.def.extra;
  }
  return extra;
}

export function extraTokens(d: Draft, player: PlayerId): number {
  let extra = 0;
  for (const r of activeReplacements(d, 'tokenCreated', null)) {
    if (r.def.event !== 'tokenCreated') continue;
    if (!playerSelMatches(r.def.who, r.controller, player)) continue;
    extra += r.def.extra;
  }
  return extra;
}
