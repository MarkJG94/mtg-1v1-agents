import type { ObjectId, PlayerId } from '@mtg/shared';
import { characteristics } from './characteristics.js';
import { hasProtectionFrom, sourceChars } from './damage.js';
import type { TargetSpec } from './definition.js';
import type { Draft } from './draft.js';
import { getObj, hasObj } from './draft.js';
import { type EvalCtx, matchesTarget } from './eval.js';
import type { Characteristics, TargetRef } from './state.js';

/** Can `source` (controlled by `player`) target the object? Checks hexproof, shroud, protection and "can't be targeted" (CR 115.5). */
export function canTargetObject(
  d: Draft,
  player: PlayerId,
  source: ObjectId | null,
  sourceChars_: Characteristics | null,
  id: ObjectId,
): boolean {
  if (!hasObj(d, id)) return false;
  const o = getObj(d, id);
  if (o.zone !== 'battlefield') return true;
  const c = characteristics(d, id);
  if (c.keywords.has('shroud')) return false;
  if (c.keywords.has('hexproof') && o.controller !== player) return false;
  for (const ce of d.effects) {
    if (ce.effect.type !== 'cantBeTargeted') continue;
    const applies =
      ce.affected?.some(
        (r) => r.id === id && hasObj(d, r.id) && getObj(d, r.id).instance === r.instance,
      ) ?? false;
    if (!applies) continue;
    if (ce.effect.by === 'opponents' && o.controller === player) continue;
    return false;
  }
  if (c.protections.length > 0 && source !== null && hasObj(d, source)) {
    const sc = sourceChars_ ?? sourceChars(d, source);
    if (hasProtectionFrom(d, c, sc, source, o.controller)) return false;
  }
  return true;
}

/** Legal targets for one target spec. */
export function candidatesFor(
  d: Draft,
  spec: TargetSpec,
  ctx: EvalCtx,
  sourceLki: Characteristics | null,
): TargetRef[] {
  const out: TargetRef[] = [];
  const f = spec.filter;
  const source = ctx.source?.id ?? null;
  const sc = sourceLki ?? (source !== null && hasObj(d, source) ? sourceChars(d, source) : null);
  if (f.player || f.any) {
    for (const p of ['A', 'B'] as const) {
      const ref: TargetRef = { kind: 'player', player: p };
      if (matchesTarget(d, f, ref, ctx)) out.push(ref);
    }
  }
  if (f.spell || f.ability) {
    for (const item of d.stack) {
      const ref: TargetRef = { kind: 'stack', stackId: item.stackId };
      if (matchesTarget(d, f, ref, ctx)) out.push(ref);
    }
  }
  if (!f.player && !f.spell && !f.ability) {
    const zone = f.zone ?? 'battlefield';
    const ids: ObjectId[] = [];
    const scan = (arr: ObjectId[]) => ids.push(...arr);
    if (zone === 'stack') {
      for (const item of d.stack) if (item.kind === 'spell') ids.push(item.source.id);
    } else {
      scan(d.zones.A[zone]);
      scan(d.zones.B[zone]);
    }
    for (const id of ids) {
      const ref: TargetRef = { kind: 'object', id, instance: getObj(d, id).instance };
      if (!matchesTarget(d, f, ref, ctx)) continue;
      if (!canTargetObject(d, ctx.controller, source, sc, id)) continue;
      out.push(ref);
    }
  }
  return out;
}

export function targetCountRange(spec: TargetSpec): { min: number; max: number } {
  const count = spec.count ?? 1;
  if (count === 'any') return { min: 0, max: Number.POSITIVE_INFINITY };
  if (typeof count === 'number') return { min: spec.optional ? 0 : count, max: count };
  return { min: 0, max: count.upTo };
}

export function sameTarget(a: TargetRef, b: TargetRef): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'player' && b.kind === 'player') return a.player === b.player;
  if (a.kind === 'stack' && b.kind === 'stack') return a.stackId === b.stackId;
  if (a.kind === 'object' && b.kind === 'object') return a.id === b.id && a.instance === b.instance;
  return false;
}

/** Validates a full target choice against the specs and candidate lists. */
export function validateTargets(
  specs: TargetSpec[],
  candidates: TargetRef[][],
  chosen: TargetRef[][],
): string | null {
  if (chosen.length !== specs.length) return 'wrong number of target groups';
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    const { min, max } = targetCountRange(spec);
    const group = chosen[i]!;
    if (group.length < min || group.length > max)
      return `target ${spec.id}: expected ${min}-${max} targets, got ${group.length}`;
    for (let j = 0; j < group.length; j++) {
      const t = group[j]!;
      if (!candidates[i]!.some((c) => sameTarget(c, t))) return `target ${spec.id}: illegal target`;
      for (let k = 0; k < j; k++)
        if (sameTarget(group[k]!, t)) return `target ${spec.id}: duplicate target`;
    }
  }
  return null;
}

/** Whether the specs can be satisfied at all (every mandatory group has enough candidates). */
export function targetsSatisfiable(specs: TargetSpec[], candidates: TargetRef[][]): boolean {
  for (let i = 0; i < specs.length; i++) {
    const { min } = targetCountRange(specs[i]!);
    if (candidates[i]!.length < min) return false;
  }
  return true;
}

/** Is a chosen target still legal on resolution (CR 608.2b)? */
export function targetStillLegal(
  d: Draft,
  spec: TargetSpec,
  ref: TargetRef,
  ctx: EvalCtx,
  sourceLki: Characteristics | null,
): boolean {
  if (!matchesTarget(d, spec.filter, ref, ctx)) return false;
  if (ref.kind === 'object') {
    const source = ctx.source?.id ?? null;
    return canTargetObject(d, ctx.controller, source, sourceLki, ref.id);
  }
  return true;
}
