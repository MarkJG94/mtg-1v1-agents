import type { ObjectId, PlayerId } from '@mtg/shared';
import { opponentOf } from '@mtg/shared';
import { castCost, spellAbility, spellTargetSpecs } from './actions.js';
import { characteristics } from './characteristics.js';
import {
  activateManaAbility,
  applyCostChoice,
  canPayCost,
  costChoiceDecision,
  maxXFor,
  payFixedCosts,
  payMana,
} from './costs.js';
import type { CostDef, Effect, TargetSpec } from './definition.js';
import { type Draft, emit, getObj, hasObj, obj } from './draft.js';
import { type EvalCtx, evalCondition, simpleCtx } from './eval.js';
import type { CastStage, EffectContext, Frame } from './frames.js';
import { loseLife } from './players.js';
import { enterPayOption } from './replacements.js';
import type {
  Characteristics,
  Decision,
  DecisionAnswer,
  StackItem,
  TargetRef,
  TriggerInstance,
} from './state.js';
import { candidatesFor, targetStillLegal, targetsSatisfiable, validateTargets } from './targets.js';
import { fireTrigger } from './triggers.js';
import { addCounters, moveObject, removeCounters } from './zones.js';

export class IllegalDecision extends Error {}

export function pushFrame(d: Draft, f: Frame): void {
  d.frames.push(f);
}

export function popFrame(d: Draft): void {
  d.frames.pop();
}

export function replaceTop(d: Draft, f: Frame): void {
  d.frames[d.frames.length - 1] = f;
}

export function setDecision(d: Draft, dec: Decision): void {
  d.pendingDecision = dec;
}

export function expectAnswer<K extends DecisionAnswer['kind']>(
  answer: DecisionAnswer | null,
  kind: K,
): Extract<DecisionAnswer, { kind: K }> {
  if (!answer || answer.kind !== kind) throw new IllegalDecision(`expected ${kind} answer`);
  return answer as Extract<DecisionAnswer, { kind: K }>;
}

export function targetsToLog(targets: Record<string, TargetRef[]>): (ObjectId | PlayerId)[] {
  const out: (ObjectId | PlayerId)[] = [];
  for (const group of Object.values(targets))
    for (const t of group)
      out.push(t.kind === 'object' ? t.id : t.kind === 'player' ? t.player : t.stackId);
  return out;
}

function nextStage(stage: CastStage): CastStage {
  const order: CastStage[] = [
    'modes',
    'targets',
    'x',
    'sacrifice',
    'discard',
    'exileFromGraveyard',
    'tapOther',
    'mana',
    'done',
  ];
  return order[order.indexOf(stage) + 1] ?? 'done';
}

// ---------------------------------------------------------------------------------------------
// Casting spells (CR 601)

export function beginCast(
  d: Draft,
  player: PlayerId,
  object: ObjectId,
  alternative: boolean,
): void {
  moveObject(d, object, 'stack', { controller: player });
  obj(d, object).wasCast = true;
  pushFrame(d, {
    k: 'cast',
    player,
    object,
    abilityIndex: -1,
    alternative,
    stage: 'modes',
    modes: [],
    targetSpecs: [],
    targets: {},
    x: 0,
    costPaid: {
      sacrificed: [],
      discarded: [],
      exiled: [],
      tappedOthers: [],
      manaPaid: false,
      lifePaid: 0,
      x: 0,
    },
  });
}

function abortCast(d: Draft, object: ObjectId): void {
  if (hasObj(d, object) && getObj(d, object).zone === 'stack') moveObject(d, object, 'hand');
  popFrame(d);
}

function chooseTargetsStage(
  d: Draft,
  player: PlayerId,
  source: ObjectId,
  sourceChars: Characteristics,
  specs: TargetSpec[],
  answer: DecisionAnswer | null,
  reason: string,
): { targets: Record<string, TargetRef[]> } | { decision: Decision } | { impossible: true } {
  if (specs.length === 0) return { targets: {} };
  const ctx: EvalCtx = { ...simpleCtx(d, player, source), sourceLki: sourceChars };
  const candidates = specs.map((s) => candidatesFor(d, s, ctx, sourceChars));
  if (!targetsSatisfiable(specs, candidates)) return { impossible: true };
  if (!answer) return { decision: { kind: 'chooseTargets', player, specs, candidates, reason } };
  const a = expectAnswer(answer, 'chooseTargets');
  const err = validateTargets(specs, candidates, a.targets);
  if (err) throw new IllegalDecision(err);
  const targets: Record<string, TargetRef[]> = {};
  specs.forEach((s, i) => {
    targets[s.id] = a.targets[i]!;
  });
  return { targets };
}

export function runCast(
  d: Draft,
  frame: Extract<Frame, { k: 'cast' }>,
  answer: DecisionAnswer | null,
): void {
  let f = frame;
  const c = characteristics(d, f.object);
  const a = spellAbility(c);
  for (;;) {
    switch (f.stage) {
      case 'modes': {
        if (a?.modes) {
          if (!answer) {
            replaceTop(d, f);
            setDecision(d, {
              kind: 'chooseMode',
              player: f.player,
              modes: a.modes.map((m) => m.label),
              min: 1,
              max: 1,
            });
            return;
          }
          const ans = expectAnswer(answer, 'chooseMode');
          answer = null;
          if (ans.modes.length !== 1 || ans.modes.some((m) => m < 0 || m >= a.modes!.length))
            throw new IllegalDecision('bad mode');
          f = {
            ...f,
            modes: ans.modes,
            targetSpecs: spellTargetSpecs(c, ans.modes),
            stage: 'targets',
          };
        } else {
          f = { ...f, targetSpecs: a?.targets ?? [], stage: 'targets' };
        }
        break;
      }
      case 'targets': {
        const r = chooseTargetsStage(d, f.player, f.object, c, f.targetSpecs, answer, 'cast');
        answer = null;
        if ('impossible' in r) {
          abortCast(d, f.object);
          return;
        }
        if ('decision' in r) {
          replaceTop(d, f);
          setDecision(d, r.decision);
          return;
        }
        f = { ...f, targets: r.targets, stage: 'x' };
        break;
      }
      case 'x': {
        const cost = castCost(d, f.player, f.object, c, f.alternative);
        if (cost.x) {
          if (!answer) {
            replaceTop(d, f);
            setDecision(d, {
              kind: 'chooseX',
              player: f.player,
              max: maxXFor(d, cost, { player: f.player, source: f.object, x: 0 }),
            });
            return;
          }
          const ans = expectAnswer(answer, 'chooseX');
          answer = null;
          const max = maxXFor(d, cost, { player: f.player, source: f.object, x: 0 });
          if (!Number.isInteger(ans.x) || ans.x < 0 || ans.x > max)
            throw new IllegalDecision('bad X');
          f = { ...f, x: ans.x, stage: 'sacrifice' };
        } else f = { ...f, stage: 'sacrifice' };
        break;
      }
      case 'sacrifice':
      case 'discard':
      case 'exileFromGraveyard':
      case 'tapOther': {
        const cost = castCost(d, f.player, f.object, c, f.alternative);
        const dec = costChoiceDecision(
          d,
          cost,
          { player: f.player, source: f.object, x: f.x },
          f.stage,
        );
        if (dec) {
          if (!answer) {
            replaceTop(d, f);
            setDecision(d, dec);
            return;
          }
          const ans = expectAnswer(answer, 'chooseObjects');
          answer = null;
          validateChooseObjects(dec, ans.objects);
          applyCostChoice(d, f.stage, ans.objects);
        }
        f = { ...f, stage: nextStage(f.stage) };
        break;
      }
      case 'mana': {
        const cost = castCost(d, f.player, f.object, c, f.alternative);
        const ctx = { player: f.player, source: f.object, x: f.x };
        if (
          !canPayCost(
            d,
            {
              ...cost,
              sacrifice: undefined as never,
              discard: undefined as never,
              exileFromGraveyard: undefined as never,
              tapOther: undefined as never,
            },
            ctx,
          )
        ) {
          abortCast(d, f.object);
          return;
        }
        payFixedCosts(d, { life: cost.life ?? 0 }, ctx);
        if (!payMana(d, cost, ctx)) {
          abortCast(d, f.object);
          return;
        }
        f = { ...f, stage: 'done' };
        break;
      }
      case 'done': {
        finishCast(
          d,
          f,
          c,
          a?.modes ? f.modes.flatMap((m) => a.modes![m]!.effects) : (a?.effects ?? []),
          a?.modes ? f.modes.map((m) => a.modes![m]!.label) : [],
        );
        return;
      }
    }
  }
}

export function validateChooseObjects(
  dec: Extract<Decision, { kind: 'chooseObjects' }>,
  objects: ObjectId[],
): void {
  if (objects.length < dec.min || objects.length > dec.max)
    throw new IllegalDecision(`choose ${dec.min}-${dec.max} objects`);
  const seen = new Set<ObjectId>();
  for (const id of objects) {
    if (!dec.options.includes(id) || seen.has(id))
      throw new IllegalDecision('illegal object choice');
    seen.add(id);
  }
}

function finishCast(
  d: Draft,
  f: Extract<Frame, { k: 'cast' }>,
  c: Characteristics,
  effects: Effect[],
  modeLabels: string[],
): void {
  const o = obj(d, f.object);
  o.x = f.x;
  const item: StackItem = {
    stackId: d.nextStackId++,
    kind: 'spell',
    controller: f.player,
    source: { id: f.object, instance: o.instance },
    abilityIndex: -1,
    effects,
    targetSpecs: f.targetSpecs,
    targets: f.targets,
    x: f.x,
    modeLabels,
    sourceLki: c,
    bindings: {},
    condition: null,
    splitSecond: c.keywords.has('split second'),
    cantBeCountered: c.keywords.has('cant be countered'),
    isCopy: false,
    optional: false,
  };
  d.stack.push(item);
  d.charCache = null;
  d.version++;
  emit(d, {
    type: 'cast',
    player: f.player,
    object: f.object,
    stackId: item.stackId,
    targets: targetsToLog(f.targets),
    x: f.x,
  });
  d.players[f.player].spellsCastThisTurn++;
  popFrame(d);
  fireTrigger(d, { on: 'cast', object: f.object, player: f.player, stackId: item.stackId });
  wardTriggers(d, item);
  d.priority = f.player;
  d.passes = 0;
}

/** Ward (CR 702.21): targeting a permanent with ward triggers "counter unless its controller pays". */
function wardTriggers(d: Draft, item: StackItem): void {
  for (const group of Object.values(item.targets)) {
    for (const t of group) {
      if (t.kind !== 'object' || !hasObj(d, t.id)) continue;
      const o = getObj(d, t.id);
      if (o.zone !== 'battlefield' || o.controller === item.controller) continue;
      const c = characteristics(d, t.id);
      for (const a of c.abilities) {
        if (a.kind !== 'keyword' || a.keyword !== 'ward') continue;
        const trig: TriggerInstance = {
          controller: o.controller,
          source: { id: t.id, instance: o.instance },
          abilityIndex: -1,
          ability: null,
          effects: [
            {
              op: 'unless',
              player: '$caster',
              cost: a.cost,
              effects: [{ op: 'counter', target: '$spell' }],
            },
          ],
          targetSpecs: [],
          sourceLki: c,
          bindings: {
            spell: { kind: 'stack', stackId: item.stackId },
            caster: { kind: 'player', player: item.controller },
          },
          condition: null,
          optional: false,
          delayedId: null,
        };
        d.pendingTriggers.push(trig);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Activated and loyalty abilities (CR 602, 606)

export function beginActivate(
  d: Draft,
  player: PlayerId,
  source: ObjectId,
  abilityIndex: number,
  loyalty: boolean,
): void {
  pushFrame(d, {
    k: 'activate',
    player,
    source,
    abilityIndex,
    loyalty,
    stage: 'targets',
    targetSpecs: [],
    targets: {},
    x: 0,
    costPaid: {
      sacrificed: [],
      discarded: [],
      exiled: [],
      tappedOthers: [],
      manaPaid: false,
      lifePaid: 0,
      x: 0,
    },
  });
}

export function runActivate(
  d: Draft,
  frame: Extract<Frame, { k: 'activate' }>,
  answer: DecisionAnswer | null,
): void {
  let f = frame;
  const c = characteristics(d, f.source);
  const a = c.abilities[f.abilityIndex];
  if (!a || (a.kind !== 'activated' && a.kind !== 'loyalty')) {
    popFrame(d);
    return;
  }
  const cost: CostDef = a.kind === 'activated' ? a.cost : {};
  const specs = a.targets ?? [];
  for (;;) {
    switch (f.stage) {
      case 'modes':
        f = { ...f, stage: 'targets' };
        break;
      case 'targets': {
        const r = chooseTargetsStage(d, f.player, f.source, c, specs, answer, 'activate');
        answer = null;
        if ('impossible' in r) {
          popFrame(d);
          return;
        }
        if ('decision' in r) {
          replaceTop(d, f);
          setDecision(d, r.decision);
          return;
        }
        f = { ...f, targetSpecs: specs, targets: r.targets, stage: 'x' };
        break;
      }
      case 'x': {
        if (cost.x) {
          if (!answer) {
            replaceTop(d, f);
            setDecision(d, {
              kind: 'chooseX',
              player: f.player,
              max: maxXFor(d, cost, { player: f.player, source: f.source, x: 0 }),
            });
            return;
          }
          const ans = expectAnswer(answer, 'chooseX');
          answer = null;
          const max = maxXFor(d, cost, { player: f.player, source: f.source, x: 0 });
          if (!Number.isInteger(ans.x) || ans.x < 0 || ans.x > max)
            throw new IllegalDecision('bad X');
          f = { ...f, x: ans.x, stage: 'sacrifice' };
        } else f = { ...f, stage: 'sacrifice' };
        break;
      }
      case 'sacrifice':
      case 'discard':
      case 'exileFromGraveyard':
      case 'tapOther': {
        const dec = costChoiceDecision(
          d,
          cost,
          { player: f.player, source: f.source, x: f.x },
          f.stage,
        );
        if (dec) {
          if (!answer) {
            replaceTop(d, f);
            setDecision(d, dec);
            return;
          }
          const ans = expectAnswer(answer, 'chooseObjects');
          answer = null;
          validateChooseObjects(dec, ans.objects);
          applyCostChoice(d, f.stage, ans.objects);
        }
        f = { ...f, stage: nextStage(f.stage) };
        break;
      }
      case 'mana': {
        const ctx = { player: f.player, source: f.source, x: f.x };
        if (a.kind === 'loyalty') {
          const o = obj(d, f.source);
          if (a.cost > 0) addCounters(d, f.source, 'loyalty', a.cost);
          else if (a.cost < 0) removeCounters(d, f.source, 'loyalty', -a.cost);
          o.loyaltyActivationsThisTurn++;
        } else {
          payFixedCosts(d, cost, ctx);
          if (cost.mana || cost.x) {
            if (!payMana(d, cost, ctx)) {
              popFrame(d);
              return;
            }
          }
        }
        f = { ...f, stage: 'done' };
        break;
      }
      case 'done': {
        if (hasObj(d, f.source)) {
          const o = obj(d, f.source);
          o.abilityActivationsThisTurn[f.abilityIndex] =
            (o.abilityActivationsThisTurn[f.abilityIndex] ?? 0) + 1;
        }
        const item: StackItem = {
          stackId: d.nextStackId++,
          kind: 'ability',
          controller: f.player,
          source: {
            id: f.source,
            instance: hasObj(d, f.source) ? getObj(d, f.source).instance : -1,
          },
          abilityIndex: f.abilityIndex,
          effects: a.effects,
          targetSpecs: f.targetSpecs,
          targets: f.targets,
          x: f.x,
          modeLabels: [],
          sourceLki: c,
          bindings: {},
          condition: null,
          splitSecond: false,
          cantBeCountered: false,
          isCopy: false,
          optional: false,
        };
        d.stack.push(item);
        emit(d, {
          type: 'activate',
          player: f.player,
          source: f.source,
          ability: f.abilityIndex,
          stackId: item.stackId,
          targets: targetsToLog(f.targets),
          mana: false,
        });
        popFrame(d);
        wardTriggers(d, item);
        d.priority = f.player;
        d.passes = 0;
        return;
      }
    }
  }
}

export function runActivateManaChoice(
  d: Draft,
  f: Extract<Frame, { k: 'activateManaChoice' }>,
  answer: DecisionAnswer | null,
): void {
  const c = characteristics(d, f.source);
  const a = c.abilities[f.abilityIndex];
  if (a?.kind !== 'mana') {
    popFrame(d);
    return;
  }
  const options: string[] = [];
  if (a.produces) options.push(a.produces);
  if (a.choice) options.push(...a.choice);
  if (a.anyColor) options.push('{W}', '{U}', '{B}', '{R}', '{G}');
  let option = 0;
  if (options.length > 1) {
    if (!answer) {
      setDecision(d, { kind: 'chooseOption', player: f.player, options, source: f.source });
      return;
    }
    const ans = expectAnswer(answer, 'chooseOption');
    if (ans.option < 0 || ans.option >= options.length)
      throw new IllegalDecision('bad mana option');
    option = ans.option;
  }
  popFrame(d);
  activateManaAbility(d, f.player, f.source, f.abilityIndex, option);
  d.priority = f.player;
}

// ---------------------------------------------------------------------------------------------
// Triggered abilities onto the stack (CR 603.3)

export function runPutTriggers(
  d: Draft,
  frame: Extract<Frame, { k: 'putTriggers' }>,
  answer: DecisionAnswer | null,
): void {
  let f = frame;
  for (;;) {
    if (f.stage === 'order') {
      if (f.items.length === 0) {
        if (d.pendingTriggers.length === 0) {
          popFrame(d);
          return;
        }
        // APNAP: the active player's triggers go on the stack first (so resolve last).
        const ap = d.activePlayer;
        const player = d.pendingTriggers.some((t) => t.controller === ap) ? ap : opponentOf(ap);
        const items = d.pendingTriggers.filter((t) => t.controller === player);
        d.pendingTriggers = d.pendingTriggers.filter((t) => t.controller !== player);
        f = { ...f, player, items };
      }
      if (f.items.length > 1) {
        if (!answer) {
          replaceTop(d, f);
          setDecision(d, {
            kind: 'orderTriggers',
            player: f.player!,
            triggers: f.items.map((t, i) => ({
              index: i,
              source: t.source.id,
              text: `${t.sourceLki.name} trigger`,
            })),
          });
          return;
        }
        const ans = expectAnswer(answer, 'orderTriggers');
        answer = null;
        const n = f.items.length;
        if (
          ans.order.length !== n ||
          new Set(ans.order).size !== n ||
          ans.order.some((i) => i < 0 || i >= n)
        )
          throw new IllegalDecision('bad trigger order');
        f = { ...f, items: ans.order.map((i) => f.items[i]!), stage: 'targets' };
      } else f = { ...f, stage: 'targets' };
    }
    // stage 'targets'
    while (f.items.length > 0) {
      const t = f.items[0]!;
      const rest = f.items.slice(1);
      const specs = t.targetSpecs;
      if (specs.length > 0) {
        const r = chooseTargetsStage(
          d,
          t.controller,
          t.source.id,
          t.sourceLki,
          specs,
          answer,
          'trigger',
        );
        answer = null;
        if ('impossible' in r) {
          // CR 603.3d: a trigger with no legal targets is removed.
          removeDelayed(d, t);
          f = { ...f, items: rest };
          continue;
        }
        if ('decision' in r) {
          replaceTop(d, f);
          setDecision(d, r.decision);
          return;
        }
        putTriggerOnStack(d, t, r.targets);
      } else putTriggerOnStack(d, t, {});
      f = { ...f, items: rest };
    }
    f = { ...f, stage: 'order', items: [] };
  }
}

function removeDelayed(d: Draft, t: TriggerInstance): void {
  if (t.delayedId !== null)
    d.delayedTriggers = d.delayedTriggers.filter((x) => x.id !== t.delayedId);
}

function putTriggerOnStack(
  d: Draft,
  t: TriggerInstance,
  targets: Record<string, TargetRef[]>,
): void {
  removeDelayed(d, t);
  const item: StackItem = {
    stackId: d.nextStackId++,
    kind: 'trigger',
    controller: t.controller,
    source: t.source,
    abilityIndex: t.abilityIndex,
    effects: t.optional ? [{ op: 'may', effects: t.effects }] : t.effects,
    targetSpecs: t.targetSpecs,
    targets,
    x: 0,
    modeLabels: [],
    sourceLki: t.sourceLki,
    bindings: t.bindings,
    condition: t.condition,
    splitSecond: false,
    cantBeCountered: false,
    isCopy: false,
    optional: t.optional,
  };
  d.stack.push(item);
  emit(d, {
    type: 'trigger',
    player: t.controller,
    source: t.source.id,
    ability: t.abilityIndex,
    stackId: item.stackId,
    targets: targetsToLog(targets),
  });
  wardTriggers(d, item);
}

// ---------------------------------------------------------------------------------------------
// Resolution (CR 608)

export function effectContextFor(_d: Draft, item: StackItem): EffectContext {
  return {
    source: item.source,
    controller: item.controller,
    targets: item.targets,
    x: item.x,
    bindings: item.bindings,
    sourceLki: item.sourceLki,
    stackId: item.stackId,
    lastDamage: 0,
  };
}

export function runResolveTop(d: Draft): void {
  popFrame(d);
  const item = d.stack.pop();
  d.priority = d.activePlayer;
  d.passes = 0;
  if (!item) return;
  d.charCache = null;
  emit(d, { type: 'resolve', stackId: item.stackId });
  const ctx = effectContextFor(d, item);

  // CR 608.2b: check targets; if every target is illegal the spell/ability doesn't resolve.
  if (item.targetSpecs.length > 0) {
    let total = 0;
    let legal = 0;
    const evalCtx: EvalCtx = {
      ...simpleCtx(d, item.controller, item.source.id),
      source: item.source,
      sourceLki: item.sourceLki,
      x: item.x,
    };
    const filtered: Record<string, TargetRef[]> = {};
    for (const spec of item.targetSpecs) {
      const group = item.targets[spec.id] ?? [];
      filtered[spec.id] = group.filter((t) => {
        total++;
        const ok = targetStillLegal(d, spec, t, evalCtx, item.sourceLki);
        if (ok) legal++;
        return ok;
      });
    }
    if (total > 0 && legal === 0) {
      emit(d, { type: 'fizzle', stackId: item.stackId });
      if (item.kind === 'spell') moveObject(d, item.source.id, 'graveyard');
      return;
    }
    ctx.targets = filtered;
  }

  if (item.condition) {
    const evalCtx: EvalCtx = {
      ...simpleCtx(d, item.controller, item.source.id),
      bindings: item.bindings,
      sourceLki: item.sourceLki,
      targets: ctx.targets,
    };
    if (!evalCondition(d, item.condition, evalCtx)) return;
  }

  if (item.kind === 'spell') {
    const c = characteristics(d, item.source.id);
    const isPermanent = c.types.some(
      (t) =>
        t === 'creature' ||
        t === 'artifact' ||
        t === 'enchantment' ||
        t === 'planeswalker' ||
        t === 'land',
    );
    if (isPermanent) {
      let attachTo: ObjectId | undefined;
      if (item.targetSpecs.length > 0) {
        const first = ctx.targets[item.targetSpecs[0]!.id]?.[0];
        if (first?.kind === 'object') attachTo = first.id;
      }
      enterBattlefield(
        d,
        item.controller,
        item.source.id,
        item.controller,
        attachTo ?? null,
        item.effects.length > 0 ? item.effects : null,
        item.effects.length > 0 ? ctx : null,
      );
      return;
    }
    pushFrame(d, { k: 'finishSpell', object: item.source.id });
  }
  pushFrame(d, { k: 'effects', effects: item.effects, i: 0, ctx, stage: null });
}

/**
 * Puts a permanent onto the battlefield from the stack or a land drop, first asking its controller whether to
 * pay an "unless you pay N life" enters-tapped cost (CR 614.1c) when one applies and can be paid.
 */
export function enterBattlefield(
  d: Draft,
  player: PlayerId,
  object: ObjectId,
  controller: PlayerId,
  attachTo: ObjectId | null,
  effects: Effect[] | null,
  ctx: EffectContext | null,
): void {
  const life = enterPayOption(d, object);
  if (life !== null && d.players[player].life > life) {
    pushFrame(d, { k: 'enterPay', player, object, life, controller, attachTo, effects, ctx });
    return;
  }
  finishEnter(d, object, controller, attachTo, effects, ctx, false);
}

function finishEnter(
  d: Draft,
  object: ObjectId,
  controller: PlayerId,
  attachTo: ObjectId | null,
  effects: Effect[] | null,
  ctx: EffectContext | null,
  paidUnless: boolean,
): void {
  const opts: { controller: PlayerId; attachTo?: ObjectId; paidUnless: boolean } = {
    controller,
    paidUnless,
  };
  if (attachTo !== null) opts.attachTo = attachTo;
  moveObject(d, object, 'battlefield', opts);
  if (effects && ctx) pushFrame(d, { k: 'effects', effects, i: 0, ctx, stage: null });
}

export function runEnterPay(
  d: Draft,
  f: Extract<Frame, { k: 'enterPay' }>,
  answer: DecisionAnswer | null,
): void {
  if (!answer) {
    setDecision(d, {
      kind: 'yesNo',
      player: f.player,
      question: `pay ${f.life} life`,
      source: f.object,
    });
    return;
  }
  const ans = expectAnswer(answer, 'yesNo');
  popFrame(d);
  if (ans.yes) loseLife(d, f.player, f.life);
  finishEnter(d, f.object, f.controller, f.attachTo, f.effects, f.ctx, ans.yes);
}

export function runFinishSpell(d: Draft, f: Extract<Frame, { k: 'finishSpell' }>): void {
  popFrame(d);
  if (hasObj(d, f.object) && getObj(d, f.object).zone === 'stack')
    moveObject(d, f.object, 'graveyard');
}

/** Counters a spell or ability on the stack (CR 701.5). */
export function counterStackItem(d: Draft, stackId: number, by: ObjectId | null): boolean {
  const item = d.stack.find((s) => s.stackId === stackId);
  if (!item || item.cantBeCountered) return false;
  d.stack = d.stack.filter((s) => s.stackId !== stackId);
  emit(d, by !== null ? { type: 'counter', stackId, by } : { type: 'counter', stackId });
  if (
    item.kind === 'spell' &&
    hasObj(d, item.source.id) &&
    getObj(d, item.source.id).zone === 'stack'
  )
    moveObject(d, item.source.id, 'graveyard');
  return true;
}
