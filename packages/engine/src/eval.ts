import type { CardType, ObjectId, PlayerId, ZoneName } from '@mtg/shared';
import { opponentOf } from '@mtg/shared';
import { characteristics } from './characteristics.js';
import type { Condition, Filter, PlayerRef, Quantity, Ref } from './definition.js';
import { getObj, hasObj } from './draft.js';
import type { Characteristics, GameState, ObjectRef, StackItem, TargetRef } from './state.js';

export type Binding = TargetRef | number | TargetRef[];

export interface EvalCtx {
  source: ObjectRef | null;
  controller: PlayerId;
  x: number;
  targets: Record<string, TargetRef[]>;
  bindings: Record<string, Binding>;
  sourceLki: Characteristics | null;
  /** Characteristics override used while the layer system is being computed. */
  chars?: ((id: ObjectId) => Characteristics) | undefined;
  lastDamage: number;
}

export function simpleCtx(d: GameState, controller: PlayerId, source: ObjectId | null): EvalCtx {
  return {
    source:
      source !== null && hasObj(d, source)
        ? { id: source, instance: getObj(d, source).instance }
        : null,
    controller,
    x: 0,
    targets: {},
    bindings: {},
    sourceLki: null,
    lastDamage: 0,
  };
}

export function charsOf(d: GameState, id: ObjectId, ctx: EvalCtx | null): Characteristics {
  if (ctx?.chars) return ctx.chars(id);
  return characteristics(d, id);
}

function asArray<T>(v: T | T[] | undefined): T[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

export function isPermanentZone(z: ZoneName): boolean {
  return z === 'battlefield';
}

/** Does the object match the filter? Zone must be checked by the caller unless `filter.zone` is set. */
export function matchesObject(d: GameState, f: Filter, id: ObjectId, ctx: EvalCtx): boolean {
  if (!hasObj(d, id)) return false;
  const o = getObj(d, id);
  if (f.player && !f.any) return false;
  if (f.spell || f.ability) return false;
  if (f.self) return ctx.source?.id === id;
  if (f.other && ctx.source?.id === id) return false;
  if (f.zone && o.zone !== f.zone) return false;
  if (f.not && matchesObject(d, f.not, id, ctx)) return false;
  if (f.and && !f.and.every((sub) => matchesObject(d, sub, id, ctx))) return false;
  if (f.or && !f.or.some((sub) => matchesObject(d, sub, id, ctx))) return false;
  const c = charsOf(d, id, ctx);
  if (f.any || f.anyPermanent) {
    if (!(c.types.includes('creature') || c.types.includes('planeswalker'))) return false;
    if (o.zone !== 'battlefield') return false;
  }
  const types = asArray(f.type);
  if (types && !types.some((t) => c.types.includes(t))) return false;
  const notTypes = asArray(f.notType);
  if (notTypes?.some((t) => c.types.includes(t))) return false;
  const subtypes = asArray(f.subtype);
  if (subtypes && !subtypes.some((s) => c.subtypes.includes(s))) return false;
  const supertypes = asArray(f.supertype);
  if (supertypes && !supertypes.some((s) => c.supertypes.includes(s))) return false;
  const colors = asArray(f.color);
  if (colors && !colors.some((col) => c.colors.includes(col))) return false;
  if (f.colorless && c.colors.length > 0) return false;
  if (f.multicolored && c.colors.length < 2) return false;
  if (f.controller === 'you' && c.controller !== ctx.controller) return false;
  if (f.controller === 'opponent' && c.controller === ctx.controller) return false;
  if (f.owner === 'you' && o.owner !== ctx.controller) return false;
  if (f.owner === 'opponent' && o.owner === ctx.controller) return false;
  if (f.tapped && !o.tapped) return false;
  if (f.untapped && o.tapped) return false;
  if (f.mvLTE !== undefined && c.manaValue > evalQuantity(d, f.mvLTE, ctx)) return false;
  if (f.mvGTE !== undefined && c.manaValue < evalQuantity(d, f.mvGTE, ctx)) return false;
  if (f.mvEQ !== undefined && c.manaValue !== evalQuantity(d, f.mvEQ, ctx)) return false;
  if (f.powerGTE !== undefined && c.power < evalQuantity(d, f.powerGTE, ctx)) return false;
  if (f.powerLTE !== undefined && c.power > evalQuantity(d, f.powerLTE, ctx)) return false;
  if (f.toughnessGTE !== undefined && c.toughness < evalQuantity(d, f.toughnessGTE, ctx))
    return false;
  if (f.toughnessLTE !== undefined && c.toughness > evalQuantity(d, f.toughnessLTE, ctx))
    return false;
  if (f.hasKeyword && !c.keywords.has(f.hasKeyword)) return false;
  if (f.lacksKeyword && c.keywords.has(f.lacksKeyword)) return false;
  if (f.isToken && !o.isToken) return false;
  if (f.nonToken && o.isToken) return false;
  if (f.name !== undefined && c.name !== f.name) return false;
  if (f.attacking !== undefined && isAttacking(d, id) !== f.attacking) return false;
  if (f.blocking !== undefined && isBlocking(d, id) !== f.blocking) return false;
  if (f.blocked !== undefined && isBlocked(d, id) !== f.blocked) return false;
  if (f.hasCounter && !(o.counters[f.hasCounter] ?? 0)) return false;
  if (f.damaged !== undefined && o.damage > 0 !== f.damaged) return false;
  if (f.enteredThisTurn !== undefined && o.enteredThisTurn !== f.enteredThisTurn) return false;
  if (f.attachedTo) {
    if (o.attachedTo === null || !matchesObject(d, f.attachedTo, o.attachedTo, ctx)) return false;
  }
  return true;
}

export function matchesPlayer(f: Filter, player: PlayerId, ctx: EvalCtx): boolean {
  const sel = f.player ?? (f.any ? 'any' : undefined);
  if (!sel) return false;
  if (sel === 'you') return player === ctx.controller;
  if (sel === 'opponent') return player !== ctx.controller;
  return true;
}

export function matchesStackItem(d: GameState, f: Filter, item: StackItem, ctx: EvalCtx): boolean {
  if (f.ability && item.kind !== 'spell') return true;
  if (!f.spell) return false;
  if (item.kind !== 'spell') return false;
  if (f.controller === 'you' && item.controller !== ctx.controller) return false;
  if (f.controller === 'opponent' && item.controller === ctx.controller) return false;
  const c = charsOf(d, item.source.id, ctx);
  const types = asArray(f.type);
  if (types && !types.some((t) => c.types.includes(t))) return false;
  const notTypes = asArray(f.notType);
  if (notTypes?.some((t) => c.types.includes(t))) return false;
  const colors = asArray(f.color);
  if (colors && !colors.some((col) => c.colors.includes(col))) return false;
  if (f.colorless && c.colors.length > 0) return false;
  if (f.mvLTE !== undefined && c.manaValue > evalQuantity(d, f.mvLTE, ctx)) return false;
  if (f.mvGTE !== undefined && c.manaValue < evalQuantity(d, f.mvGTE, ctx)) return false;
  if (f.not && matchesStackItem(d, f.not, item, ctx)) return false;
  return true;
}

export function matchesTarget(d: GameState, f: Filter, ref: TargetRef, ctx: EvalCtx): boolean {
  switch (ref.kind) {
    case 'player':
      return matchesPlayer(f, ref.player, ctx);
    case 'stack': {
      const item = d.stack.find((s) => s.stackId === ref.stackId);
      return item ? matchesStackItem(d, f, item, ctx) : false;
    }
    case 'object':
      if (!hasObj(d, ref.id) || getObj(d, ref.id).instance !== ref.instance) return false;
      return matchesObject(d, f, ref.id, ctx);
  }
}

/** All objects matching a filter. Default zone is the battlefield unless the filter names one. */
export function findObjects(
  d: GameState,
  f: Filter,
  ctx: EvalCtx,
  zone?: ZoneName | 'any',
): ObjectId[] {
  const z = zone ?? f.zone ?? 'battlefield';
  const out: ObjectId[] = [];
  if (z === 'stack') {
    for (const item of d.stack)
      if (item.kind === 'spell' && matchesObject(d, f, item.source.id, ctx))
        out.push(item.source.id);
    return out;
  }
  const scan = (ids: ObjectId[]) => {
    for (const id of ids) if (matchesObject(d, f, id, ctx)) out.push(id);
  };
  if (z === 'any') {
    for (const p of ['A', 'B'] as const) {
      const zs = d.zones[p];
      scan(zs.battlefield);
      scan(zs.hand);
      scan(zs.graveyard);
      scan(zs.exile);
      scan(zs.library);
      scan(zs.command);
    }
    for (const item of d.stack)
      if (item.kind === 'spell' && matchesObject(d, f, item.source.id, ctx))
        out.push(item.source.id);
  } else {
    scan(d.zones.A[z]);
    scan(d.zones.B[z]);
  }
  return out;
}

export function isAttacking(d: GameState, id: ObjectId): boolean {
  return d.combat?.attackers.some((a) => a.attacker === id && !a.removedFromCombat) ?? false;
}

export function isBlocking(d: GameState, id: ObjectId): boolean {
  return (d.combat?.blockers[id]?.length ?? 0) > 0;
}

export function isBlocked(d: GameState, id: ObjectId): boolean {
  return d.combat?.attackers.some((a) => a.attacker === id && a.blocked) ?? false;
}

export function resolvePlayer(d: GameState, ref: PlayerRef | undefined, ctx: EvalCtx): PlayerId {
  if (ref === undefined || ref === 'controller') return ctx.controller;
  if (ref === 'opponent') return opponentOf(ctx.controller);
  if (ref === 'activePlayer') return d.activePlayer;
  const refs = resolveRef(d, ref, ctx);
  for (const r of refs) {
    if (r.kind === 'player') return r.player;
    if (r.kind === 'object' && hasObj(d, r.id)) return getObj(d, r.id).controller;
    if (r.kind === 'stack') {
      const item = d.stack.find((s) => s.stackId === r.stackId);
      if (item) return item.controller;
    }
  }
  throw new Error(`Cannot resolve player ref ${ref}`);
}

/** Resolves an object/player reference to the current targets or bindings. */
export function resolveRef(d: GameState, ref: Ref, ctx: EvalCtx): TargetRef[] {
  if (ref === '~' || ref === 'self') {
    return ctx.source ? [{ kind: 'object', id: ctx.source.id, instance: ctx.source.instance }] : [];
  }
  if (ref === 'controller') return [{ kind: 'player', player: ctx.controller }];
  if (ref === 'opponent') return [{ kind: 'player', player: opponentOf(ctx.controller) }];
  if (ref === 'activePlayer') return [{ kind: 'player', player: d.activePlayer }];
  if (ref === 'each')
    return [
      { kind: 'player', player: 'A' },
      { kind: 'player', player: 'B' },
    ];
  if (ref === 'attached') {
    if (!ctx.source || !hasObj(d, ctx.source.id)) return [];
    const to = getObj(d, ctx.source.id).attachedTo;
    return to !== null && hasObj(d, to)
      ? [{ kind: 'object', id: to, instance: getObj(d, to).instance }]
      : [];
  }
  if (ref.startsWith('$')) {
    const name = ref.slice(1);
    const t = ctx.targets[name];
    if (t) return t;
    const b = ctx.bindings[name];
    if (b !== undefined) return bindingToRefs(b);
    return [];
  }
  const b = ctx.bindings[ref];
  if (b !== undefined) return bindingToRefs(b);
  throw new Error(`Unknown reference ${ref}`);
}

function bindingToRefs(b: Binding): TargetRef[] {
  if (typeof b === 'number') return [];
  return Array.isArray(b) ? b : [b];
}

export function refObjects(d: GameState, ref: Ref, ctx: EvalCtx): ObjectId[] {
  const out: ObjectId[] = [];
  for (const r of resolveRef(d, ref, ctx)) {
    if (r.kind === 'object' && hasObj(d, r.id) && getObj(d, r.id).instance === r.instance)
      out.push(r.id);
  }
  return out;
}

export function evalQuantity(d: GameState, q: Quantity, ctx: EvalCtx): number {
  if (typeof q === 'number') return q;
  if (q === 'x') return ctx.x;
  if ('count' in q) return findObjects(d, q.count, ctx, q.zone).length;
  if ('countTypes' in q) {
    const types = new Set<CardType>();
    for (const p of ['A', 'B'] as const) {
      for (const id of d.zones[p].graveyard)
        for (const t of charsOf(d, id, ctx).types) types.add(t);
    }
    return types.size;
  }
  if ('add' in q) return q.add.reduce((acc: number, v) => acc + evalQuantity(d, v, ctx), 0);
  if ('sub' in q) return evalQuantity(d, q.sub[0], ctx) - evalQuantity(d, q.sub[1], ctx);
  if ('mul' in q) return evalQuantity(d, q.mul[0], ctx) * evalQuantity(d, q.mul[1], ctx);
  if ('max' in q) return Math.max(...q.max.map((v) => evalQuantity(d, v, ctx)));
  if ('min' in q) return Math.min(...q.min.map((v) => evalQuantity(d, v, ctx)));
  if ('negate' in q) return -evalQuantity(d, q.negate, ctx);
  if ('lifeTotal' in q) return d.players[resolvePlayer(d, q.lifeTotal, ctx)].life;
  if ('cardsInHand' in q) return d.zones[resolvePlayer(d, q.cardsInHand, ctx)].hand.length;
  if ('cardsInGraveyard' in q)
    return d.zones[resolvePlayer(d, q.cardsInGraveyard, ctx)].graveyard.length;
  if ('lands' in q) {
    const p = resolvePlayer(d, q.lands, ctx);
    return d.zones[p].battlefield.filter((id) => charsOf(d, id, ctx).types.includes('land')).length;
  }
  if ('power' in q) return sumOverRef(d, q.power, ctx, (c) => c.power);
  if ('toughness' in q) return sumOverRef(d, q.toughness, ctx, (c) => c.toughness);
  if ('manaValue' in q) return sumOverRef(d, q.manaValue, ctx, (c) => c.manaValue);
  if ('counters' in q) {
    let total = 0;
    for (const id of refObjects(d, q.counters, ctx))
      total += getObj(d, id).counters[q.counter] ?? 0;
    return total;
  }
  if ('devotion' in q) {
    const p = resolvePlayer(d, q.player, ctx);
    let total = 0;
    for (const id of d.zones[p].battlefield) {
      for (const s of charsOf(d, id, ctx).manaCost.symbols) {
        if (s.kind === 'colored' || s.kind === 'phyrexian' || s.kind === 'monoHybrid') {
          if (q.devotion.includes(s.color)) total++;
        } else if (s.kind === 'hybrid' || s.kind === 'phyrexianHybrid') {
          if (q.devotion.includes(s.colors[0]) || q.devotion.includes(s.colors[1])) total++;
        }
      }
    }
    return total;
  }
  if ('damageDealt' in q) return ctx.lastDamage;
  if ('bound' in q) {
    const b = ctx.bindings[q.bound];
    return typeof b === 'number' ? b : 0;
  }
  throw new Error(`Unknown quantity ${JSON.stringify(q)}`);
}

function sumOverRef(
  d: GameState,
  ref: Ref,
  ctx: EvalCtx,
  pick: (c: Characteristics) => number,
): number {
  let total = 0;
  for (const r of resolveRef(d, ref, ctx)) {
    if (r.kind !== 'object') continue;
    if (hasObj(d, r.id) && getObj(d, r.id).instance === r.instance)
      total += pick(charsOf(d, r.id, ctx));
    else if (ctx.sourceLki && ctx.source?.id === r.id) total += pick(ctx.sourceLki);
  }
  return total;
}

export function evalCondition(d: GameState, c: Condition, ctx: EvalCtx): boolean {
  if ('compare' in c) {
    const a = evalQuantity(d, c.compare, ctx);
    const b = evalQuantity(d, c.to, ctx);
    switch (c.op) {
      case '<':
        return a < b;
      case '<=':
        return a <= b;
      case '=':
        return a === b;
      case '>=':
        return a >= b;
      case '>':
        return a > b;
      case '!=':
        return a !== b;
    }
  }
  if ('controls' in c) {
    const p = resolvePlayer(d, c.player, ctx);
    const sub: EvalCtx = { ...ctx, controller: p };
    const n = findObjects(d, { ...c.controls, controller: 'you' }, sub).length;
    return n >= (c.count ?? 1);
  }
  if ('exists' in c) return findObjects(d, c.exists, ctx, c.zone).length >= (c.count ?? 1);
  if ('isYourTurn' in c) return d.activePlayer === ctx.controller;
  if ('isTapped' in c) return refObjects(d, c.isTapped, ctx).some((id) => getObj(d, id).tapped);
  if ('isAttacking' in c) return refObjects(d, c.isAttacking, ctx).some((id) => isAttacking(d, id));
  if ('hasKeyword' in c)
    return refObjects(d, c.hasKeyword, ctx).some((id) =>
      charsOf(d, id, ctx).keywords.has(c.keyword),
    );
  if ('matches' in c)
    return resolveRef(d, c.matches, ctx).some((r) => matchesTarget(d, c.filter, r, ctx));
  if ('onBattlefield' in c)
    return refObjects(d, c.onBattlefield, ctx).some((id) => getObj(d, id).zone === 'battlefield');
  if ('inZone' in c)
    return refObjects(d, c.inZone, ctx).some((id) => getObj(d, id).zone === c.zone);
  if ('landsPlayedThisTurn' in c) {
    const n = d.players[ctx.controller].landsPlayedThisTurn;
    const { op, count } = c.landsPlayedThisTurn;
    return op === '<' ? n < count : op === '>=' ? n >= count : n === count;
  }
  if ('step' in c) return c.step.includes(d.step);
  if ('not' in c) return !evalCondition(d, c.not, ctx);
  if ('and' in c) return c.and.every((sub) => evalCondition(d, sub, ctx));
  if ('or' in c) return c.or.some((sub) => evalCondition(d, sub, ctx));
  if ('lifeGainedThisTurn' in c)
    return d.players[resolvePlayer(d, c.lifeGainedThisTurn, ctx)].lifeGainedThisTurn > 0;
  if ('spellsCastThisTurn' in c) {
    const n = d.players[resolvePlayer(d, c.spellsCastThisTurn.player, ctx)].spellsCastThisTurn;
    return c.spellsCastThisTurn.op === '>='
      ? n >= c.spellsCastThisTurn.count
      : n < c.spellsCastThisTurn.count;
  }
  throw new Error(`Unknown condition ${JSON.stringify(c)}`);
}
