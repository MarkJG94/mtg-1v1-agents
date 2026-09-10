import type { ObjectId, PlayerId } from '@mtg/shared';
import { characteristics } from './characteristics.js';
import type { CostDef, Filter } from './definition.js';
import { type Draft, emit, getObj, hasObj, obj } from './draft.js';
import { findObjects, matchesObject, simpleCtx } from './eval.js';
import {
  type ManaCost,
  type ManaPool,
  manaValue,
  parseMana,
  parseManaCost,
  poolTotal,
} from './mana/cost.js';
import { type ManaSource, manaSources, maxX, solvePayment } from './mana/solver.js';
import { loseLife } from './players.js';
import type { Decision } from './state.js';
import { fireTrigger } from './triggers.js';
import { moveObject, removeCounters, tap, untap } from './zones.js';

export interface CostContext {
  player: PlayerId;
  source: ObjectId;
  x: number;
  /** Precomputed mana sources for the player (legalActions computes them once per call). */
  sources?: ManaSource[];
  /** Memo of solver results for identical mana costs within one legalActions call. */
  payCache?: Map<string, boolean>;
}

export function availableManaSources(
  d: Draft,
  player: PlayerId,
  cost: CostDef,
  source: ObjectId,
  precomputed?: ManaSource[],
): ManaSource[] {
  let sources = precomputed ?? manaSources(d, player);
  if (cost.tap || cost.sacrifice === 'self') sources = sources.filter((s) => s.object !== source);
  return sources;
}

function maxMana(pool: ManaPool, sources: ManaSource[]): number {
  let n = poolTotal(pool);
  const seen = new Set<ObjectId>();
  for (const s of sources) {
    if (seen.has(s.object)) continue;
    seen.add(s.object);
    n += Math.max(...s.options.map((o) => o.length));
  }
  return n;
}

/** Can every component of the cost be paid right now? Mana is checked with the solver. */
export function canPayCost(d: Draft, cost: CostDef, ctx: CostContext): boolean {
  const { player, source } = ctx;
  const p = d.players[player];
  const o = hasObj(d, source) ? getObj(d, source) : null;
  if (cost.tap) {
    if (o?.zone !== 'battlefield' || o.tapped) return false;
    const c = characteristics(d, source);
    if (c.types.includes('creature') && o.sick && !c.keywords.has('haste')) return false;
  }
  if (cost.untap) {
    if (o?.zone !== 'battlefield' || !o.tapped) return false;
  }
  if (cost.life !== undefined && p.life < cost.life) return false;
  if (cost.sacrifice) {
    if (cost.sacrifice === 'self') {
      if (o?.zone !== 'battlefield') return false;
    } else if (
      findObjects(d, { ...cost.sacrifice, controller: 'you' }, simpleCtx(d, player, source))
        .length === 0
    )
      return false;
  }
  if (cost.discard !== undefined) {
    const n = typeof cost.discard === 'number' ? cost.discard : cost.discard.count;
    const filter = typeof cost.discard === 'number' ? undefined : cost.discard.filter;
    const hand = d.zones[player].hand.filter(
      (id) =>
        id !== source && (!filter || matchesObject(d, filter, id, simpleCtx(d, player, source))),
    );
    if (hand.length < n) return false;
  }
  if (cost.exileFromGraveyard) {
    const f = cost.exileFromGraveyard.filter;
    const gy = d.zones[player].graveyard.filter(
      (id) => !f || matchesObject(d, f, id, simpleCtx(d, player, source)),
    );
    if (gy.length < cost.exileFromGraveyard.count) return false;
  }
  if (cost.removeCounters) {
    if (!o || (o.counters[cost.removeCounters.counter] ?? 0) < cost.removeCounters.count)
      return false;
  }
  if (cost.tapOther) {
    const opts = findObjects(
      d,
      { ...cost.tapOther.filter, controller: 'you', untapped: true },
      simpleCtx(d, player, source),
    ).filter((id) => id !== source);
    if (opts.length < cost.tapOther.count) return false;
  }
  if (cost.mana || cost.x) {
    const mana = parseManaCost(cost.mana);
    const sources = availableManaSources(d, player, cost, source, ctx.sources);
    // Cheap upper bound before running the solver.
    if (manaValue(mana, ctx.x) > maxMana(p.pool, sources) + phyrexianSlack(mana)) return false;
    if (cost.x) return maxX(mana, p.pool, sources, p.life) >= 0;
    const key = ctx.payCache ? `${cost.mana}|${ctx.x}|${sources.length}` : null;
    if (key !== null) {
      const hit = ctx.payCache!.get(key);
      if (hit !== undefined) return hit;
    }
    const ok = solvePayment(mana, p.pool, sources, ctx.x, p.life) !== null;
    if (key !== null) ctx.payCache!.set(key, ok);
    return ok;
  }
  return true;
}

function phyrexianSlack(cost: ManaCost): number {
  let n = 0;
  for (const s of cost.symbols) if (s.kind === 'phyrexian' || s.kind === 'phyrexianHybrid') n++;
  return n;
}

export function maxXFor(d: Draft, cost: CostDef, ctx: CostContext): number {
  const p = d.players[ctx.player];
  return Math.max(
    0,
    maxX(
      parseManaCost(cost.mana),
      p.pool,
      availableManaSources(d, ctx.player, cost, ctx.source, ctx.sources),
      p.life,
    ),
  );
}

/** Pays the mana part of a cost by activating mana abilities (never uses the stack) and removing mana from the pool. */
export function payMana(d: Draft, cost: CostDef, ctx: CostContext): boolean {
  const mana = parseManaCost(cost.mana);
  const p = d.players[ctx.player];
  const sources = availableManaSources(d, ctx.player, cost, ctx.source);
  const solved = solvePayment(mana, p.pool, sources, ctx.x, p.life);
  if (!solved) return false;
  for (const t of solved.taps)
    activateManaAbility(d, ctx.player, t.source.object, t.source.ability, t.option);
  const pool = d.players[ctx.player].pool;
  for (const m of solved.used) {
    if (pool[m] <= 0) throw new Error('mana solver produced an invalid plan');
    pool[m]--;
  }
  if (solved.lifePaid > 0) loseLife(d, ctx.player, solved.lifePaid);
  return true;
}

/** Activates a mana ability: pays its cost (tap/life) and adds mana to the pool (CR 605.3). */
export function activateManaAbility(
  d: Draft,
  player: PlayerId,
  source: ObjectId,
  abilityIndex: number,
  option: number,
): void {
  const c = characteristics(d, source);
  const a = c.abilities[abilityIndex];
  if (a?.kind !== 'mana') throw new Error('not a mana ability');
  if (a.cost.tap) tap(d, source);
  if (a.cost.life) loseLife(d, player, a.cost.life);
  if (a.cost.sacrifice === 'self') moveObject(d, source, 'graveyard');
  const options: string[] = [];
  if (a.produces) options.push(a.produces);
  if (a.choice) options.push(...a.choice);
  if (a.anyColor) options.push('{W}', '{U}', '{B}', '{R}', '{G}');
  const chosen = options[option] ?? options[0];
  if (!chosen) return;
  addManaToPool(d, player, chosen);
  emit(d, {
    type: 'activate',
    player,
    source,
    ability: abilityIndex,
    stackId: -1,
    targets: [],
    mana: true,
  });
}

export function addManaToPool(d: Draft, player: PlayerId, mana: string): void {
  for (const m of parseMana(mana)) d.players[player].pool[m]++;
  emit(d, { type: 'manaAdded', player, mana });
}

/** Pays the simple, choice-free parts of a cost: tap/untap self, life, remove counters, sacrifice self. */
export function payFixedCosts(d: Draft, cost: CostDef, ctx: CostContext): void {
  if (cost.tap) tap(d, ctx.source);
  if (cost.untap) untap(d, ctx.source);
  if (cost.life) loseLife(d, ctx.player, cost.life);
  if (cost.removeCounters)
    removeCounters(d, ctx.source, cost.removeCounters.counter, cost.removeCounters.count);
  if (cost.sacrifice === 'self') sacrifice(d, ctx.source);
}

export function sacrifice(d: Draft, id: ObjectId): void {
  if (!hasObj(d, id) || getObj(d, id).zone !== 'battlefield') return;
  moveObject(d, id, 'graveyard');
  fireTrigger(d, { on: 'sacrificed', object: id });
}

/** Decision for a choice-based cost component, or null if no choice is needed at this stage. */
export function costChoiceDecision(
  d: Draft,
  cost: CostDef,
  ctx: CostContext,
  stage: 'sacrifice' | 'discard' | 'exileFromGraveyard' | 'tapOther',
): Extract<Decision, { kind: 'chooseObjects' }> | null {
  const ectx = simpleCtx(d, ctx.player, ctx.source);
  switch (stage) {
    case 'sacrifice': {
      if (!cost.sacrifice || cost.sacrifice === 'self') return null;
      const options = findObjects(d, { ...cost.sacrifice, controller: 'you' }, ectx);
      return {
        kind: 'chooseObjects',
        player: ctx.player,
        reason: 'sacrifice',
        options,
        min: 1,
        max: 1,
      };
    }
    case 'discard': {
      if (cost.discard === undefined) return null;
      const n = typeof cost.discard === 'number' ? cost.discard : cost.discard.count;
      const filter: Filter | undefined =
        typeof cost.discard === 'number' ? undefined : cost.discard.filter;
      const options = d.zones[ctx.player].hand.filter(
        (id) => id !== ctx.source && (!filter || matchesObject(d, filter, id, ectx)),
      );
      return {
        kind: 'chooseObjects',
        player: ctx.player,
        reason: 'discard',
        options,
        min: n,
        max: n,
      };
    }
    case 'exileFromGraveyard': {
      if (!cost.exileFromGraveyard) return null;
      const f = cost.exileFromGraveyard.filter;
      const options = d.zones[ctx.player].graveyard.filter(
        (id) => !f || matchesObject(d, f, id, ectx),
      );
      return {
        kind: 'chooseObjects',
        player: ctx.player,
        reason: 'exileFromGraveyard',
        options,
        min: cost.exileFromGraveyard.count,
        max: cost.exileFromGraveyard.count,
      };
    }
    case 'tapOther': {
      if (!cost.tapOther) return null;
      const options = findObjects(
        d,
        { ...cost.tapOther.filter, controller: 'you', untapped: true },
        ectx,
      ).filter((id) => id !== ctx.source);
      return {
        kind: 'chooseObjects',
        player: ctx.player,
        reason: 'tap',
        options,
        min: cost.tapOther.count,
        max: cost.tapOther.count,
      };
    }
  }
}

export function applyCostChoice(
  d: Draft,
  stage: 'sacrifice' | 'discard' | 'exileFromGraveyard' | 'tapOther',
  objects: ObjectId[],
): void {
  for (const id of objects) {
    switch (stage) {
      case 'sacrifice':
        sacrifice(d, id);
        break;
      case 'discard':
        moveObject(d, id, 'graveyard');
        emit(d, { type: 'discard', player: getObj(d, id).owner, object: id });
        break;
      case 'exileFromGraveyard':
        moveObject(d, id, 'exile');
        break;
      case 'tapOther':
        tap(d, id);
        break;
    }
  }
  if (objects.length > 0) obj(d, objects[0]!);
}
