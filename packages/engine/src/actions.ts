import type { ObjectId, PlayerId } from '@mtg/shared';
import { characteristics, landDropsAllowed, playerLevelEffects } from './characteristics.js';
import { type CostContext, canPayCost } from './costs.js';
import type { AbilityDef, CostDef, TargetSpec } from './definition.js';
import type { Draft } from './draft.js';
import { getObj } from './draft.js';
import { type EvalCtx, evalCondition, evalQuantity, matchesObject, simpleCtx } from './eval.js';
import { formatManaCost, parseManaCost, reduceGeneric } from './mana/cost.js';
import { type ManaSource, manaSources } from './mana/solver.js';
import type { Action, Characteristics } from './state.js';
import { candidatesFor, targetsSatisfiable } from './targets.js';

export function isMainPhase(d: Draft): boolean {
  return d.step === 'main1' || d.step === 'main2';
}

export function sorceryTiming(d: Draft, player: PlayerId): boolean {
  return d.activePlayer === player && isMainPhase(d) && d.stack.length === 0;
}

function splitSecondOnStack(d: Draft): boolean {
  return d.stack.some((s) => s.splitSecond);
}

/** The mana cost of a spell after cost reductions/increases from static effects (CR 601.2f). */
export function effectiveManaCost(
  d: Draft,
  player: PlayerId,
  object: ObjectId,
  c: Characteristics,
): string {
  let cost = c.manaCost;
  let delta = 0;
  for (const { effect, controller, source } of playerLevelEffects(d)) {
    if (effect.type !== 'costReduction' && effect.type !== 'costIncrease') continue;
    const ctx: EvalCtx = {
      ...simpleCtx(d, controller, source),
      chars: (id) => (id === object ? c : characteristics(d, id)),
    };
    if (!matchesObject(d, { ...effect.affects, zone: getObj(d, object).zone }, object, ctx))
      continue;
    if (effect.affects.controller === 'you' && controller !== player) continue;
    if (effect.affects.controller === 'opponent' && controller === player) continue;
    const n = evalQuantity(d, effect.amount, ctx);
    delta += effect.type === 'costReduction' ? -n : n;
  }
  if (delta < 0) cost = reduceGeneric(cost, -delta);
  else if (delta > 0) cost = { symbols: [{ kind: 'generic', amount: delta }, ...cost.symbols] };
  return formatManaCost(cost);
}

export function spellAbility(c: Characteristics): Extract<AbilityDef, { kind: 'spell' }> | null {
  for (const a of c.abilities) if (a.kind === 'spell') return a;
  return null;
}

export function spellTargetSpecs(c: Characteristics, modes: number[]): TargetSpec[] {
  const a = spellAbility(c);
  if (!a) return [];
  if (a.modes && modes.length > 0) return modes.flatMap((m) => a.modes![m]?.targets ?? []);
  return a.targets ?? [];
}

/** Full cost of casting: mana (after reductions) plus additional/alternative costs. */
export function castCost(
  d: Draft,
  player: PlayerId,
  object: ObjectId,
  c: Characteristics,
  alternative: boolean,
): CostDef {
  const a = spellAbility(c);
  const base: CostDef =
    alternative && a?.alternativeCost
      ? { ...a.alternativeCost }
      : { mana: effectiveManaCost(d, player, object, c) };
  if (a?.additionalCost) {
    const add = a.additionalCost;
    const merged: CostDef = { ...base };
    if (add.mana) merged.mana = (merged.mana ?? '') + add.mana;
    if (add.sacrifice) merged.sacrifice = add.sacrifice;
    if (add.discard !== undefined) merged.discard = add.discard;
    if (add.life !== undefined) merged.life = (merged.life ?? 0) + add.life;
    if (add.exileFromGraveyard) merged.exileFromGraveyard = add.exileFromGraveyard;
    if (add.tapOther) merged.tapOther = add.tapOther;
    if (add.x) merged.x = true;
    return merged;
  }
  if (parseManaCost(base.mana).symbols.some((s) => s.kind === 'x')) base.x = true;
  return base;
}

function cantCast(d: Draft, player: PlayerId, object: ObjectId, c: Characteristics): boolean {
  for (const { effect, controller, source } of playerLevelEffects(d)) {
    if (effect.type !== 'cantCast') continue;
    const who = effect.who ?? 'any';
    if (who === 'you' && controller !== player) continue;
    if (who === 'opponent' && controller === player) continue;
    const ctx: EvalCtx = {
      ...simpleCtx(d, controller, source),
      chars: (id) => (id === object ? c : characteristics(d, id)),
    };
    if (matchesObject(d, { ...effect.affects, zone: 'hand' }, object, ctx)) return true;
  }
  return false;
}

function cantActivate(d: Draft, _player: PlayerId, source: ObjectId): boolean {
  for (const { effect, controller, source: es } of playerLevelEffects(d)) {
    if (effect.type !== 'cantActivate') continue;
    if (matchesObject(d, effect.affects, source, simpleCtx(d, controller, es))) return true;
  }
  return false;
}

/** Whether a spell could be cast now: timing, cost, and satisfiable targets (for modal spells, any mode). */
export function canCastSpell(
  d: Draft,
  player: PlayerId,
  object: ObjectId,
  alternative: boolean,
  sources?: ManaSource[],
  payCache?: Map<string, boolean>,
): boolean {
  const c = characteristics(d, object);
  if (!c.types.some((t) => t !== 'land')) return false;
  if (c.types.includes('land')) return false;
  const instantSpeed = c.types.includes('instant') || c.keywords.has('flash');
  if (!instantSpeed && !sorceryTiming(d, player)) return false;
  if (cantCast(d, player, object, c)) return false;
  const a = spellAbility(c);
  if (alternative && !a?.alternativeCost) return false;
  const cost = castCost(d, player, object, c, alternative);
  const costCtx: CostContext = { player, source: object, x: 0 };
  if (sources) costCtx.sources = sources;
  // Spells never tap themselves, so identical costs from hand share one solver result.
  if (payCache && !cost.tap && cost.sacrifice !== 'self') costCtx.payCache = payCache;
  if (!canPayCost(d, cost, costCtx)) return false;
  const ctx = simpleCtx(d, player, object);
  if (a?.modes) {
    return a.modes.some((m) => {
      const specs = m.targets ?? [];
      return targetsSatisfiable(
        specs,
        specs.map((s) => candidatesFor(d, s, ctx, c)),
      );
    });
  }
  const specs = a?.targets ?? [];
  if (specs.length === 0) return true;
  return targetsSatisfiable(
    specs,
    specs.map((s) => candidatesFor(d, s, ctx, c)),
  );
}

export function canActivate(
  d: Draft,
  player: PlayerId,
  source: ObjectId,
  index: number,
  sources?: ManaSource[],
): boolean {
  const o = getObj(d, source);
  const c = characteristics(d, source);
  const a = c.abilities[index];
  if (!a) return false;
  if (a.kind === 'loyalty') {
    if (o.zone !== 'battlefield' || o.controller !== player) return false;
    if (!sorceryTiming(d, player)) return false;
    if (o.loyaltyActivationsThisTurn > 0) return false;
    if (a.cost < 0 && (o.counters.loyalty ?? 0) < -a.cost) return false;
    if (cantActivate(d, player, source)) return false;
    const specs = a.targets ?? [];
    const ctx = simpleCtx(d, player, source);
    return targetsSatisfiable(
      specs,
      specs.map((s) => candidatesFor(d, s, ctx, c)),
    );
  }
  if (a.kind !== 'activated') return false;
  const zone = a.zone ?? 'battlefield';
  if (o.zone !== zone) return false;
  if (zone === 'battlefield' && o.controller !== player) return false;
  if (zone !== 'battlefield' && o.owner !== player) return false;
  if (a.timing === 'sorcery' && !sorceryTiming(d, player)) return false;
  if (a.oncePerTurn && (o.abilityActivationsThisTurn[index] ?? 0) > 0) return false;
  if (a.condition && !evalCondition(d, a.condition, simpleCtx(d, player, source))) return false;
  if (cantActivate(d, player, source)) return false;
  const costCtx: CostContext = { player, source, x: 0 };
  if (sources) costCtx.sources = sources;
  if (!canPayCost(d, a.cost, costCtx)) return false;
  const specs = a.targets ?? [];
  const ctx = simpleCtx(d, player, source);
  return targetsSatisfiable(
    specs,
    specs.map((s) => candidatesFor(d, s, ctx, c)),
  );
}

/** All actions the player may take with priority (CR 117.1). */
export function legalActions(d: Draft, player: PlayerId): Action[] {
  const actions: Action[] = [{ kind: 'pass' }];
  if (d.priority !== player || d.result) return actions;
  const splitSecond = splitSecondOnStack(d);
  const zones = d.zones[player];
  const sources = manaSources(d, player);
  const payCache = new Map<string, boolean>();

  if (!splitSecond) {
    if (
      sorceryTiming(d, player) &&
      d.players[player].landsPlayedThisTurn < landDropsAllowed(d, player)
    ) {
      for (const id of zones.hand)
        if (characteristics(d, id).types.includes('land'))
          actions.push({ kind: 'playLand', object: id });
    }
    for (const id of zones.hand) {
      const c = characteristics(d, id);
      if (c.types.includes('land')) continue;
      if (canCastSpell(d, player, id, false, sources, payCache))
        actions.push({ kind: 'cast', object: id, text: `cast ${c.name}` });
      if (spellAbility(c)?.alternativeCost && canCastSpell(d, player, id, true, sources, payCache))
        actions.push({
          kind: 'cast',
          object: id,
          alternative: true,
          text: `cast ${c.name} (alternative cost)`,
        });
    }
    const scanActivations = (ids: ObjectId[]) => {
      for (const id of ids) {
        const c = characteristics(d, id);
        c.abilities.forEach((a, i) => {
          if (a.kind === 'activated' && canActivate(d, player, id, i, sources))
            actions.push({
              kind: 'activate',
              source: id,
              ability: i,
              text: `${c.name}: ability ${i}`,
            });
          if (a.kind === 'loyalty' && canActivate(d, player, id, i, sources))
            actions.push({
              kind: 'loyalty',
              source: id,
              ability: i,
              text: `${c.name}: ${a.cost >= 0 ? '+' : ''}${a.cost}`,
            });
        });
      }
    };
    scanActivations(zones.battlefield);
    scanActivations(zones.hand);
    scanActivations(zones.graveyard);
  }
  for (const id of zones.battlefield) {
    const c = characteristics(d, id);
    const o = getObj(d, id);
    c.abilities.forEach((a, i) => {
      if (a.kind !== 'mana') return;
      if (
        a.cost.tap &&
        (o.tapped || (c.types.includes('creature') && o.sick && !c.keywords.has('haste')))
      )
        return;
      if (a.cost.sacrifice) return;
      if (a.condition && !evalCondition(d, a.condition, simpleCtx(d, player, id))) return;
      actions.push({ kind: 'activateMana', source: id, ability: i, text: `${c.name}: mana` });
    });
  }
  return actions;
}
