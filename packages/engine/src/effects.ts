import type { ObjectId, PlayerId } from '@mtg/shared';
import { opponentOf } from '@mtg/shared';
import { characteristics } from './characteristics.js';
import { canPayCost, payFixedCosts, payMana, sacrifice } from './costs.js';
import { type DamageEntry, dealDamage } from './damage.js';
import type { DurationDef, Effect, Filter, StaticEffectDef } from './definition.js';
import { type Draft, emit, getObj, hasObj, invalidate, nextTimestamp, obj } from './draft.js';
import {
  evalCondition,
  evalQuantity,
  findObjects,
  matchesObject,
  refObjects,
  resolvePlayer,
  resolveRef,
} from './eval.js';
import type { EffectContext, EffectStage, Frame } from './frames.js';
import {
  discardCard,
  drawCards,
  gainLife,
  loseLife,
  millCards,
  setLife,
  shuffleLibrary,
} from './players.js';
import {
  counterStackItem,
  expectAnswer,
  IllegalDecision,
  popFrame,
  pushFrame,
  replaceTop,
  setDecision,
  validateChooseObjects,
} from './stack.js';
import type {
  ContinuousEffect,
  Decision,
  DecisionAnswer,
  Duration,
  ObjectRef,
  TargetRef,
} from './state.js';
import { fireTrigger } from './triggers.js';
import {
  addCounters,
  attach,
  createToken,
  moveObject,
  moveObjects,
  removeCounters,
  tap,
  untap,
} from './zones.js';

type EffectsFrame = Extract<Frame, { k: 'effects' }>;

/** `push` lists child frames in execution order; the parent resumes after the last one. */
type StepResult = { next: true } | { decision: Decision; stage: EffectStage } | { push: Frame[] };

function ref(d: Draft, id: ObjectId): ObjectRef {
  return { id, instance: getObj(d, id).instance };
}

function toDuration(d: Draft, dur: DurationDef | undefined, ctx: EffectContext): Duration {
  switch (dur ?? 'untilEndOfTurn') {
    case 'untilEndOfTurn':
      return { kind: 'untilEndOfTurn' };
    case 'permanent':
      return { kind: 'permanent' };
    case 'untilYourNextTurn':
      return { kind: 'untilYourNextTurn', player: ctx.controller, turnSeen: d.turn };
    case 'whileSourceOnBattlefield':
    case 'untilSourceLeaves':
      return { kind: 'untilSourceLeaves', source: ctx.source ?? { id: -1, instance: -1 } };
  }
}

export function addContinuousEffect(
  d: Draft,
  ctx: EffectContext,
  effect: StaticEffectDef,
  affected: ObjectRef[] | null,
  duration: Duration,
): ContinuousEffect {
  const ce: ContinuousEffect = {
    id: d.nextEffectId++,
    source: ctx.source ?? { id: -1, instance: -1 },
    controller: ctx.controller,
    timestamp: nextTimestamp(d),
    effect,
    affected,
    duration,
  };
  d.effects.push(ce);
  invalidate(d);
  emit(d, { type: 'effectStart', effect: ce.id, source: ce.source.id });
  return ce;
}

function targetsOf(d: Draft, r: string, ctx: EffectContext): TargetRef[] {
  return resolveRef(d, r, ctx);
}

function objects(d: Draft, r: string, ctx: EffectContext): ObjectId[] {
  return refObjects(d, r, ctx);
}

/** Destroys a permanent (CR 701.7), honouring indestructible and regeneration. */
export function destroy(d: Draft, id: ObjectId, noRegenerate = false): boolean {
  if (!hasObj(d, id) || getObj(d, id).zone !== 'battlefield') return false;
  const c = characteristics(d, id);
  if (c.keywords.has('indestructible')) return false;
  const o = getObj(d, id);
  if (!noRegenerate && o.regenerationShields > 0) {
    const w = obj(d, id);
    w.regenerationShields--;
    w.damage = 0;
    w.deathtouched = false;
    w.tapped = true;
    if (d.combat) {
      for (const a of d.combat.attackers) {
        if (a.attacker === id) a.removedFromCombat = true;
        a.blockers = a.blockers.filter((b) => b !== id);
        a.blockerOrder = a.blockerOrder.filter((b) => b !== id);
      }
      delete d.combat.blockers[id];
    }
    emit(d, { type: 'sba', kind: 'regenerate', object: id });
    return true;
  }
  moveObject(d, id, 'graveyard');
  return true;
}

/** Destroys several permanents at once so their dies triggers see each other (CR 603.10a). */
export function destroyAll(d: Draft, ids: ObjectId[], noRegenerate = false): void {
  const toMove: ObjectId[] = [];
  for (const id of ids) {
    if (!hasObj(d, id) || getObj(d, id).zone !== 'battlefield') continue;
    const c = characteristics(d, id);
    if (c.keywords.has('indestructible')) continue;
    if (!noRegenerate && getObj(d, id).regenerationShields > 0) {
      destroy(d, id, false);
      continue;
    }
    toMove.push(id);
  }
  moveObjects(d, toMove, 'graveyard');
}

function chooseObjectsDecision(
  player: PlayerId,
  reason: string,
  options: ObjectId[],
  min: number,
  max: number,
): Decision {
  return {
    kind: 'chooseObjects',
    player,
    reason,
    options,
    min: Math.min(min, options.length),
    max: Math.min(max, options.length),
  };
}

function execute(d: Draft, e: Effect, ctx: EffectContext, f: EffectsFrame): StepResult {
  const next: StepResult = { next: true };
  switch (e.op) {
    case 'noop':
      return next;
    case 'damage': {
      const amount = evalQuantity(d, e.amount, ctx);
      const source = e.from
        ? (objects(d, e.from, ctx)[0] ?? ctx.source?.id ?? -1)
        : (ctx.source?.id ?? -1);
      const refs = (Array.isArray(e.to) ? e.to : [e.to]).flatMap((r) => targetsOf(d, r, ctx));
      const entries: DamageEntry[] = [];
      for (const t of refs) {
        if (t.kind === 'player') entries.push({ source, target: t.player, amount, combat: false });
        else if (t.kind === 'object' && hasObj(d, t.id) && getObj(d, t.id).instance === t.instance)
          entries.push({ source, target: t.id, amount, combat: false });
      }
      ctx.lastDamage = dealDamage(d, entries);
      return next;
    }
    case 'gainLife':
      gainLife(d, resolvePlayer(d, e.player, ctx), evalQuantity(d, e.amount, ctx));
      return next;
    case 'loseLife':
      loseLife(d, resolvePlayer(d, e.player, ctx), evalQuantity(d, e.amount, ctx));
      return next;
    case 'setLife':
      setLife(d, resolvePlayer(d, e.player, ctx), evalQuantity(d, e.amount, ctx));
      return next;
    case 'draw':
      drawCards(d, resolvePlayer(d, e.player, ctx), evalQuantity(d, e.count, ctx));
      return next;
    case 'mill':
      millCards(d, resolvePlayer(d, e.player, ctx), evalQuantity(d, e.count, ctx));
      return next;
    case 'discard': {
      const player = resolvePlayer(d, e.player, ctx);
      const hand = d.zones[player].hand.filter(
        (id) => !e.filter || matchesObject(d, e.filter, id, { ...ctx, controller: player }),
      );
      const n =
        e.count === 'hand' ? hand.length : Math.min(evalQuantity(d, e.count, ctx), hand.length);
      if (n <= 0) return next;
      if (e.count === 'hand' && !e.filter) {
        for (const id of hand) discardCard(d, player, id);
        return next;
      }
      if (e.random) {
        let pool = hand.slice();
        for (let i = 0; i < n; i++) {
          const [idx, rng] = nextIndex(d, pool.length);
          d.rng = rng;
          const id = pool[idx]!;
          pool = pool.filter((x) => x !== id);
          discardCard(d, player, id);
        }
        return next;
      }
      const chooser = e.chooser === 'controller' ? ctx.controller : player;
      return {
        decision: chooseObjectsDecision(chooser, 'discard', hand, n, n),
        stage: { kind: 'chooseObjects', effectIndex: f.i, purpose: 'discard' },
      };
    }
    case 'counter': {
      for (const t of targetsOf(d, e.target, ctx))
        if (t.kind === 'stack') counterStackItem(d, t.stackId, ctx.source?.id ?? null);
      return next;
    }
    case 'destroy':
      destroyAll(d, objects(d, e.target, ctx), e.noRegenerate ?? false);
      return next;
    case 'destroyAll':
      destroyAll(d, findObjects(d, e.filter, ctx), e.noRegenerate ?? false);
      return next;
    case 'exileAll':
      moveObjects(d, findObjects(d, e.filter, ctx, e.zone), 'exile');
      return next;
    case 'bounceAll':
      moveObjects(d, findObjects(d, e.filter, ctx), 'hand');
      return next;
    case 'sacrificeAll': {
      const player = resolvePlayer(d, e.player, ctx);
      const ids = findObjects(
        d,
        { ...e.filter, controller: 'you' },
        { ...ctx, controller: player },
      );
      moveObjects(d, ids, 'graveyard');
      for (const id of ids) fireTrigger(d, { on: 'sacrificed', object: id });
      return next;
    }
    case 'damageEach': {
      const amount = evalQuantity(d, e.amount, ctx);
      const source = ctx.source?.id ?? -1;
      const entries: DamageEntry[] = findObjects(d, e.filter, ctx).map((id) => ({
        source,
        target: id,
        amount,
        combat: false,
      }));
      if (e.players) {
        for (const p of ['A', 'B'] as const) {
          if (
            e.players === 'any' ||
            (e.players === 'you' && p === ctx.controller) ||
            (e.players === 'opponent' && p !== ctx.controller)
          )
            entries.push({ source, target: p, amount, combat: false });
        }
      }
      ctx.lastDamage = dealDamage(d, entries);
      return next;
    }
    case 'exile':
      moveObjects(d, objects(d, e.target, ctx), 'exile');
      return next;
    case 'bounce':
      moveObjects(d, objects(d, e.target, ctx), 'hand');
      return next;
    case 'putOnTopOfLibrary':
      for (const id of objects(d, e.target, ctx))
        moveObject(d, id, 'library', { libraryPosition: 'top' });
      return next;
    case 'moveZone': {
      for (const id of objects(d, e.target, ctx)) {
        if (e.to === 'libraryTop') moveObject(d, id, 'library', { libraryPosition: 'top' });
        else if (e.to === 'libraryBottom')
          moveObject(d, id, 'library', { libraryPosition: 'bottom' });
        else if (e.to === 'battlefield') {
          const opts: { controller: PlayerId; tapped?: boolean } = {
            controller: e.controller ? resolvePlayer(d, e.controller, ctx) : ctx.controller,
          };
          if (e.tapped) opts.tapped = true;
          moveObject(d, id, 'battlefield', opts);
        } else moveObject(d, id, e.to);
      }
      return next;
    }
    case 'sacrifice': {
      if (e.target) {
        for (const id of objects(d, e.target, ctx)) sacrifice(d, id);
        return next;
      }
      const player = resolvePlayer(d, e.player, ctx);
      const filter: Filter = { ...(e.filter ?? {}), controller: 'you' };
      const options = findObjects(d, filter, { ...ctx, controller: player });
      const n = Math.min(e.count === undefined ? 1 : evalQuantity(d, e.count, ctx), options.length);
      if (n <= 0) return next;
      if (n === options.length) {
        for (const id of options) sacrifice(d, id);
        return next;
      }
      return {
        decision: chooseObjectsDecision(player, 'sacrifice', options, n, n),
        stage: { kind: 'chooseObjects', effectIndex: f.i, purpose: 'sacrifice' },
      };
    }
    case 'tap':
      for (const id of objects(d, e.target, ctx)) tap(d, id);
      return next;
    case 'untap':
      for (const id of objects(d, e.target, ctx)) untap(d, id);
      return next;
    case 'createToken': {
      const player = resolvePlayer(d, e.player, ctx);
      const n = e.count === undefined ? 1 : evalQuantity(d, e.count, ctx);
      const opts: { tapped?: boolean; attacking?: boolean } = {};
      if (e.tapped) opts.tapped = true;
      if (e.attacking) opts.attacking = true;
      for (let i = 0; i < n; i++) createToken(d, e.token, player, opts);
      return next;
    }
    case 'addCounters': {
      const n = evalQuantity(d, e.count, ctx);
      for (const id of objects(d, e.target, ctx)) addCounters(d, id, e.counter, n);
      return next;
    }
    case 'removeCounters': {
      const n = evalQuantity(d, e.count, ctx);
      for (const id of objects(d, e.target, ctx)) removeCounters(d, id, e.counter, n);
      return next;
    }
    case 'pump': {
      const ids = objects(d, e.target, ctx).filter((id) => getObj(d, id).zone === 'battlefield');
      if (ids.length === 0) return next;
      const power = evalQuantity(d, e.power, ctx);
      const toughness = evalQuantity(d, e.toughness, ctx);
      addContinuousEffect(
        d,
        ctx,
        { type: 'pt', affects: 'self', power, toughness },
        ids.map((id) => ref(d, id)),
        toDuration(d, e.duration, ctx),
      );
      return next;
    }
    case 'setPT': {
      const ids = objects(d, e.target, ctx).filter((id) => getObj(d, id).zone === 'battlefield');
      if (ids.length === 0) return next;
      addContinuousEffect(
        d,
        ctx,
        {
          type: 'setPT',
          affects: 'self',
          power: evalQuantity(d, e.power, ctx),
          toughness: evalQuantity(d, e.toughness, ctx),
        },
        ids.map((id) => ref(d, id)),
        toDuration(d, e.duration, ctx),
      );
      return next;
    }
    case 'grantAbility': {
      const ids = objects(d, e.target, ctx).filter((id) => getObj(d, id).zone === 'battlefield');
      if (ids.length === 0) return next;
      addContinuousEffect(
        d,
        ctx,
        { type: 'addAbility', affects: 'self', ability: e.ability },
        ids.map((id) => ref(d, id)),
        toDuration(d, e.duration, ctx),
      );
      return next;
    }
    case 'loseAbilities': {
      const ids = objects(d, e.target, ctx).filter((id) => getObj(d, id).zone === 'battlefield');
      if (ids.length === 0) return next;
      addContinuousEffect(
        d,
        ctx,
        { type: 'loseAbility', affects: 'self', keyword: 'all' },
        ids.map((id) => ref(d, id)),
        toDuration(d, e.duration, ctx),
      );
      return next;
    }
    case 'gainControl': {
      const ids = objects(d, e.target, ctx).filter((id) => getObj(d, id).zone === 'battlefield');
      if (ids.length === 0) return next;
      const newController = e.player ? resolvePlayer(d, e.player, ctx) : ctx.controller;
      addContinuousEffect(
        d,
        { ...ctx, controller: newController },
        { type: 'control', affects: 'self', controller: 'you' },
        ids.map((id) => ref(d, id)),
        toDuration(d, e.duration ?? 'permanent', ctx),
      );
      applyControlChanges(d);
      return next;
    }
    case 'createEffect': {
      const affected = e.target
        ? objects(d, e.target, ctx)
            .filter((id) => getObj(d, id).zone === 'battlefield')
            .map((id) => ref(d, id))
        : null;
      if (e.target && affected!.length === 0) return next;
      addContinuousEffect(d, ctx, e.effect, affected, toDuration(d, e.duration, ctx));
      if (e.effect.type === 'control') applyControlChanges(d);
      return next;
    }
    case 'preventDamage': {
      if (e.amount === 'all') {
        const affected = objects(d, e.target, ctx).map((id) => ref(d, id));
        const playerTargets = targetsOf(d, e.target, ctx).filter((t) => t.kind === 'player');
        if (affected.length > 0) {
          const def: StaticEffectDef = { type: 'preventDamage', affects: 'self', amount: 'all' };
          if (e.combat) def.combat = true;
          addContinuousEffect(d, ctx, def, affected, toDuration(d, e.duration, ctx));
        }
        for (const t of playerTargets) {
          if (t.kind !== 'player') continue;
          const def: StaticEffectDef = { type: 'preventDamage', affects: 'you', amount: 'all' };
          if (e.combat) def.combat = true;
          addContinuousEffect(
            d,
            { ...ctx, controller: t.player },
            def,
            [],
            toDuration(d, e.duration, ctx),
          );
        }
        return next;
      }
      const n = evalQuantity(d, e.amount, ctx);
      for (const id of objects(d, e.target, ctx))
        if (getObj(d, id).zone === 'battlefield') obj(d, id).preventionShield += n;
      return next;
    }
    case 'regenerate':
      for (const id of objects(d, e.target, ctx))
        if (getObj(d, id).zone === 'battlefield') obj(d, id).regenerationShields++;
      return next;
    case 'fight': {
      const a = objects(d, e.a, ctx)[0];
      const b = objects(d, e.b, ctx)[0];
      if (a === undefined || b === undefined) return next;
      if (getObj(d, a).zone !== 'battlefield' || getObj(d, b).zone !== 'battlefield') return next;
      const ca = characteristics(d, a);
      const cb = characteristics(d, b);
      if (!ca.types.includes('creature') || !cb.types.includes('creature')) return next;
      dealDamage(d, [
        { source: a, target: b, amount: ca.power, combat: false },
        { source: b, target: a, amount: cb.power, combat: false },
      ]);
      return next;
    }
    case 'attach': {
      const what = objects(d, e.target, ctx)[0];
      const to = objects(d, e.to, ctx)[0];
      if (what === undefined || to === undefined || what === to) return next;
      if (getObj(d, what).zone !== 'battlefield' || getObj(d, to).zone !== 'battlefield')
        return next;
      attach(d, what, to);
      return next;
    }
    case 'search': {
      const player = resolvePlayer(d, e.player, ctx);
      const lib = d.zones[player].library;
      const options = e.filter
        ? lib.filter((id) =>
            matchesObject(d, { ...e.filter, zone: 'library' }, id, { ...ctx, controller: player }),
          )
        : lib.slice();
      const n = e.count === undefined ? 1 : evalQuantity(d, e.count, ctx);
      if (options.length === 0 || n <= 0) {
        shuffleLibrary(d, player);
        return next;
      }
      return {
        decision: {
          kind: 'chooseCardsFromLibrary',
          player,
          options,
          min: 0,
          max: Math.min(n, options.length),
          reason: 'search',
        },
        stage: { kind: 'search', effectIndex: f.i },
      };
    }
    case 'shuffle':
      shuffleLibrary(d, resolvePlayer(d, e.player, ctx));
      return next;
    case 'scry': {
      const player = resolvePlayer(d, e.player, ctx);
      const n = Math.min(evalQuantity(d, e.count, ctx), d.zones[player].library.length);
      if (n <= 0) return next;
      return {
        decision: { kind: 'scry', player, cards: d.zones[player].library.slice(0, n) },
        stage: { kind: 'scry', effectIndex: f.i },
      };
    }
    case 'surveil': {
      const player = resolvePlayer(d, e.player, ctx);
      const n = Math.min(evalQuantity(d, e.count, ctx), d.zones[player].library.length);
      if (n <= 0) return next;
      return {
        decision: { kind: 'scry', player, cards: d.zones[player].library.slice(0, n) },
        stage: { kind: 'scry', effectIndex: f.i },
      };
    }
    case 'addMana': {
      const player = resolvePlayer(d, e.player, ctx);
      for (const ch of e.mana.replace(/[{}]/g, '')) {
        const key = ch.toUpperCase() as keyof typeof d.players.A.pool;
        if (key in d.players[player].pool) d.players[player].pool[key]++;
      }
      emit(d, { type: 'manaAdded', player, mana: e.mana });
      return next;
    }
    case 'extraTurn':
      d.turnFlags.extraTurns.push(resolvePlayer(d, e.player, ctx));
      return next;
    case 'sequence':
      return { push: [{ k: 'effects', effects: e.effects, i: 0, ctx: { ...ctx }, stage: null }] };
    case 'forEach': {
      const ids = findObjects(d, e.filter, ctx, e.zone);
      const frames: Frame[] = [];
      for (const id of ids) {
        const sub: EffectContext = {
          ...ctx,
          bindings: {
            ...ctx.bindings,
            [e.as]: { kind: 'object', id, instance: getObj(d, id).instance },
          },
        };
        frames.push({ k: 'effects', effects: e.effects, i: 0, ctx: sub, stage: null });
      }
      if (frames.length === 0) return next;
      return { push: frames };
    }
    case 'forEachPlayer': {
      const players: PlayerId[] = [d.activePlayer, opponentOf(d.activePlayer)];
      const frames: Frame[] = players.map((p) => ({
        k: 'effects',
        effects: e.effects,
        i: 0,
        ctx: { ...ctx, bindings: { ...ctx.bindings, [e.as]: { kind: 'player', player: p } } },
        stage: null,
      }));
      return { push: frames };
    }
    case 'if': {
      const cond = evalCondition(d, e.condition, ctx);
      const branch = cond ? e.then : (e.else ?? []);
      if (branch.length === 0) return next;
      return { push: [{ k: 'effects', effects: branch, i: 0, ctx: { ...ctx }, stage: null }] };
    }
    case 'may': {
      const player = e.player ? resolvePlayer(d, e.player, ctx) : ctx.controller;
      return {
        decision: { kind: 'yesNo', player, question: 'may', source: ctx.source?.id ?? -1 },
        stage: { kind: 'yesNo', effectIndex: f.i },
      };
    }
    case 'choose': {
      const player = e.player ? resolvePlayer(d, e.player, ctx) : ctx.controller;
      return {
        decision: {
          kind: 'chooseOption',
          player,
          options: e.options.map((o) => o.label),
          source: ctx.source?.id ?? -1,
        },
        stage: { kind: 'chooseOption', effectIndex: f.i },
      };
    }
    case 'unless': {
      const player = resolvePlayer(d, e.player, ctx);
      const source = ctx.source?.id ?? -1;
      const payable = hasObj(d, source)
        ? canPayCost(d, e.cost, { player, source, x: ctx.x })
        : canPayCost(
            d,
            { mana: e.cost.mana ?? '', life: e.cost.life ?? 0 },
            { player, source: -1, x: ctx.x },
          );
      if (!payable)
        return { push: [{ k: 'effects', effects: e.effects, i: 0, ctx: { ...ctx }, stage: null }] };
      return {
        decision: { kind: 'yesNo', player, question: 'pay', source },
        stage: { kind: 'unlessPay', effectIndex: f.i, frameDepth: d.frames.length },
      };
    }
    case 'delayedTrigger': {
      const bindings: Record<string, TargetRef | number | TargetRef[]> = {};
      for (const b of e.bind ?? []) bindings[b.replace(/^\$/, '')] = targetsOf(d, b, ctx);
      d.delayedTriggers.push({
        id: d.nextEffectId++,
        source: ctx.source ?? { id: -1, instance: -1 },
        sourceLki:
          ctx.sourceLki ??
          (ctx.source && hasObj(d, ctx.source.id)
            ? characteristics(d, ctx.source.id)
            : (null as never)),
        controller: ctx.controller,
        trigger: e.trigger,
        effects: e.effects,
        bindings: {
          ...ctx.bindings,
          ...bindings,
          ...Object.fromEntries(Object.entries(ctx.targets).map(([k, v]) => [k, v])),
        },
        createdTurn: d.turn,
        createdInEndStep: d.step === 'end',
      });
      return next;
    }
    case 'winGame': {
      const player = resolvePlayer(d, e.player, ctx);
      d.players[opponentOf(player)].lost = true;
      d.sbaPending = true;
      return next;
    }
    case 'loseGame':
      d.players[resolvePlayer(d, e.player, ctx)].lost = true;
      d.sbaPending = true;
      return next;
    case 'bind':
      ctx.bindings = { ...ctx.bindings, [e.as]: evalQuantity(d, e.value, ctx) };
      return next;
    case 'reveal': {
      if (e.hand) {
        const p = resolvePlayer(d, e.hand, ctx);
        emit(d, { type: 'reveal', player: p, objects: d.zones[p].hand.slice() });
      } else if (e.target) {
        const ids = objects(d, e.target, ctx);
        if (ids.length > 0) emit(d, { type: 'reveal', player: ctx.controller, objects: ids });
      }
      return next;
    }
    case 'copySpell':
    case 'transformTargetsTo':
      return next;
  }
}

function nextIndex(d: Draft, n: number): [number, typeof d.rng] {
  // Local import to avoid a circular import at module top-level.
  const { nextInt } = rngModule;
  return nextInt(d.rng, n);
}

import * as rngModule from './rng.js';

/** Control-changing effects move permanents between battlefields immediately (CR 613.2). */
export function applyControlChanges(d: Draft): void {
  for (const p of ['A', 'B'] as const) {
    for (const id of d.zones[p].battlefield.slice()) {
      const c = characteristics(d, id);
      const o = getObj(d, id);
      if (c.controller !== o.controller) {
        const w = obj(d, id);
        w.timestamp = nextTimestamp(d);
        const from = d.zones[w.controller].battlefield;
        const idx = from.indexOf(id);
        if (idx >= 0) from.splice(idx, 1);
        w.controller = c.controller;
        w.sick = true;
        d.zones[c.controller].battlefield.push(id);
        invalidate(d);
        emit(d, { type: 'controlChange', object: id, controller: c.controller });
      }
    }
  }
}

function handleAnswer(
  d: Draft,
  e: Effect,
  ctx: EffectContext,
  stage: EffectStage,
  answer: DecisionAnswer,
): Frame | null {
  switch (stage.kind) {
    case 'chooseObjects': {
      const ans = expectAnswer(answer, 'chooseObjects');
      const dec = d.pendingDecision;
      if (dec?.kind === 'chooseObjects') validateChooseObjects(dec, ans.objects);
      if (stage.purpose === 'discard' && e.op === 'discard') {
        const player = resolvePlayer(d, e.player, ctx);
        for (const id of ans.objects) discardCard(d, player, id);
      } else if (stage.purpose === 'sacrifice') {
        for (const id of ans.objects) sacrifice(d, id);
      }
      return null;
    }
    case 'yesNo': {
      const ans = expectAnswer(answer, 'yesNo');
      if (e.op === 'may' && ans.yes)
        return { k: 'effects', effects: e.effects, i: 0, ctx: { ...ctx }, stage: null };
      return null;
    }
    case 'chooseOption': {
      const ans = expectAnswer(answer, 'chooseOption');
      if (e.op !== 'choose') return null;
      const opt = e.options[ans.option];
      if (!opt) throw new IllegalDecision('bad option');
      return { k: 'effects', effects: opt.effects, i: 0, ctx: { ...ctx }, stage: null };
    }
    case 'search': {
      const ans = expectAnswer(answer, 'chooseCardsFromLibrary');
      if (e.op !== 'search') return null;
      const dec = d.pendingDecision;
      if (dec?.kind !== 'chooseCardsFromLibrary') throw new IllegalDecision('no search pending');
      if (
        ans.cards.length < dec.min ||
        ans.cards.length > dec.max ||
        ans.cards.some((c) => !dec.options.includes(c)) ||
        new Set(ans.cards).size !== ans.cards.length
      )
        throw new IllegalDecision('bad search choice');
      const player = dec.player;
      for (const id of ans.cards) {
        if (e.to === 'battlefield') {
          const opts: { controller: PlayerId; tapped?: boolean } = { controller: ctx.controller };
          if (e.tapped) opts.tapped = true;
          moveObject(d, id, 'battlefield', opts);
        } else if (e.to === 'libraryTop') moveObject(d, id, 'library', { libraryPosition: 'top' });
        else moveObject(d, id, e.to);
        if (e.reveal) emit(d, { type: 'reveal', player, objects: [id] });
      }
      shuffleLibrary(d, player);
      if (e.to === 'libraryTop')
        for (const id of ans.cards) moveObject(d, id, 'library', { libraryPosition: 'top' });
      return null;
    }
    case 'scry': {
      const ans = expectAnswer(answer, 'scry');
      const dec = d.pendingDecision;
      if (dec?.kind !== 'scry') throw new IllegalDecision('no scry pending');
      const all = [...ans.top, ...ans.bottom];
      if (
        all.length !== dec.cards.length ||
        new Set(all).size !== all.length ||
        all.some((c) => !dec.cards.includes(c))
      )
        throw new IllegalDecision('bad scry choice');
      const player = dec.player;
      const lib = d.zones[player].library;
      const rest = lib.filter((id) => !dec.cards.includes(id));
      if (e.op === 'surveil') {
        d.zones[player].library = [...ans.top, ...rest];
        for (const id of ans.bottom) moveObject(d, id, 'graveyard');
      } else {
        d.zones[player].library = [...ans.top, ...rest, ...ans.bottom];
      }
      return null;
    }
    case 'unlessPay': {
      const ans = expectAnswer(answer, 'yesNo');
      if (e.op !== 'unless') return null;
      const player = resolvePlayer(d, e.player, ctx);
      const source = ctx.source?.id ?? -1;
      if (ans.yes) {
        const cctx = { player, source, x: ctx.x };
        if (hasObj(d, source)) payFixedCosts(d, { life: e.cost.life ?? 0 }, cctx);
        else if (e.cost.life) loseLife(d, player, e.cost.life);
        if (e.cost.mana) {
          if (!payMana(d, e.cost, cctx))
            return { k: 'effects', effects: e.effects, i: 0, ctx: { ...ctx }, stage: null };
        }
        return null;
      }
      return { k: 'effects', effects: e.effects, i: 0, ctx: { ...ctx }, stage: null };
    }
    default:
      return null;
  }
}

export function runEffects(d: Draft, frame: EffectsFrame, answer: DecisionAnswer | null): void {
  let f = frame;
  if (f.stage) {
    if (!answer) throw new Error('effects frame awaiting an answer');
    const e = f.effects[f.stage.effectIndex]!;
    const child = handleAnswer(d, e, f.ctx, f.stage, answer);
    d.pendingDecision = null;
    f = { ...f, i: f.stage.effectIndex + 1, stage: null };
    replaceTop(d, f);
    if (child) {
      pushFrame(d, child);
      return;
    }
  }
  while (f.i < f.effects.length) {
    if (d.result) {
      popFrame(d);
      return;
    }
    const e = f.effects[f.i]!;
    const r = execute(d, e, f.ctx, f);
    if ('decision' in r) {
      replaceTop(d, { ...f, stage: r.stage });
      setDecision(d, r.decision);
      return;
    }
    f = { ...f, i: f.i + 1 };
    replaceTop(d, f);
    if ('push' in r) {
      for (let i = r.push.length - 1; i >= 0; i--) pushFrame(d, r.push[i]!);
      return;
    }
  }
  popFrame(d);
}
