import type { CardType, Color, ObjectId, PlayerId } from '@mtg/shared';
import type {
  AbilityDef,
  Affects,
  CardDefinition,
  Condition,
  Keyword,
  Quantity,
  StaticEffectDef,
} from './definition.js';
import type { Draft } from './draft.js';
import { getObj, hasObj } from './draft.js';
import { type EvalCtx, evalCondition, evalQuantity, matchesObject, simpleCtx } from './eval.js';
import { costColors, manaValue, parseManaCost } from './mana/cost.js';
import type { Characteristics, ContinuousEffect, GameObject, GameState, Layer } from './state.js';

const BASIC_LAND_TYPES: Record<string, Color> = {
  Plains: 'W',
  Island: 'U',
  Swamp: 'B',
  Mountain: 'R',
  Forest: 'G',
};

export function definitionOf(d: GameState, o: GameObject): CardDefinition {
  const key = o.copyOf ?? o.definitionId;
  const def = d.definitions[key];
  if (!def) throw new Error(`Unknown definition ${key}`);
  return def;
}

function cloneChars(c: Characteristics): Characteristics {
  return {
    ...c,
    colors: c.colors.slice(),
    supertypes: c.supertypes.slice(),
    types: c.types.slice(),
    subtypes: c.subtypes.slice(),
    abilities: c.abilities.slice(),
    keywords: new Set(c.keywords),
    protections: c.protections.slice(),
    flags: { ...c.flags, cantBeBlockedBy: c.flags.cantBeBlockedBy.slice() },
  };
}

interface Template {
  cost: import('./mana/cost.js').ManaCost;
  colors: Color[];
  abilities: AbilityDef[];
  hasStatic: boolean;
  keywords: Set<Keyword | 'protection' | 'ward'>;
  protections: Characteristics['protections'];
  wardCosts: number;
}

/** Per-definition precomputation (parsed cost, colours, intrinsic abilities), shared by every game. */
const templates = new WeakMap<CardDefinition, Template>();

function templateOf(def: CardDefinition): Template {
  let t = templates.get(def);
  if (t) return t;
  const cost = parseManaCost(def.manaCost);
  const abilities: AbilityDef[] = def.abilities ? def.abilities.slice() : [];
  // Basic land types carry intrinsic mana abilities (CR 305.6).
  for (const sub of def.subtypes ?? []) {
    const color = BASIC_LAND_TYPES[sub];
    if (color && def.types.includes('land'))
      abilities.push({ kind: 'mana', cost: { tap: true }, produces: `{${color}}` });
  }
  const scratch: Characteristics = { abilities } as Characteristics;
  refreshKeywords(scratch);
  t = {
    cost,
    colors: def.colors ? def.colors.slice() : costColors(cost),
    abilities,
    hasStatic: abilities.some((a) => a.kind === 'static'),
    keywords: scratch.keywords,
    protections: scratch.protections,
    wardCosts: scratch.wardCosts,
  };
  templates.set(def, t);
  return t;
}

/** Printed (copiable) characteristics of an object, before any effects. */
export function baseCharacteristics(d: GameState, o: GameObject): Characteristics {
  const def = definitionOf(d, o);
  const t = templateOf(def);
  return {
    name: def.name,
    manaCost: t.cost,
    manaValue: o.zone === 'stack' && o.x > 0 ? manaValue(t.cost, o.x) : manaValue(t.cost, 0),
    colors: t.colors.slice(),
    supertypes: def.supertypes ? def.supertypes.slice() : [],
    types: def.types.slice(),
    subtypes: def.subtypes ? def.subtypes.slice() : [],
    power: typeof def.power === 'number' ? def.power : 0,
    toughness: typeof def.toughness === 'number' ? def.toughness : 0,
    loyalty: def.loyalty ?? null,
    abilities: t.abilities.slice(),
    keywords: new Set(t.keywords),
    protections: t.protections.slice(),
    wardCosts: t.wardCosts,
    flags: emptyFlags(),
    controller: o.defaultController,
  };
}

/** Whether any battlefield object could generate a layer effect (fast path check). */
function anyStaticAbilities(d: GameState): boolean {
  for (const p of ['A', 'B'] as const) {
    for (const id of d.zones[p].battlefield) {
      if (templateOf(definitionOf(d, getObj(d, id))).hasStatic) return true;
    }
  }
  return false;
}

function emptyFlags(): Characteristics['flags'] {
  return {
    cantAttack: false,
    cantBlock: false,
    cantBeBlocked: false,
    cantBeBlockedBy: [],
    doesntUntap: false,
    mustAttack: false,
    noAbilities: false,
  };
}

function refreshKeywords(c: Characteristics): void {
  c.keywords = new Set();
  c.protections = [];
  c.wardCosts = 0;
  for (const a of c.abilities) {
    if (a.kind !== 'keyword') continue;
    c.keywords.add(a.keyword);
    if (a.keyword === 'protection') c.protections.push(a.from);
    if (a.keyword === 'ward') c.wardCosts++;
  }
}

/** Characteristics of an object in any zone, applying the layer system for battlefield objects. */
export function characteristics(d: GameState, id: ObjectId): Characteristics {
  const draft = d as Draft;
  const o = getObj(d, id);
  if (o.zone === 'battlefield') {
    if (!draft.battlefieldChars) draft.battlefieldChars = computeBattlefield(draft);
    const c = draft.battlefieldChars.get(id);
    if (c) return c;
  }
  if (draft.charCache?.has(id)) return draft.charCache.get(id)!;
  const c = baseCharacteristics(d, o);
  applyCdaPT(d, c, o, null);
  if (o.zone === 'stack') {
    // Effects that modify spells on the stack are not modelled in v1.
  }
  if (!draft.charCache) draft.charCache = new Map();
  draft.charCache.set(id, c);
  return c;
}

function applyCdaPT(
  d: GameState,
  c: Characteristics,
  o: GameObject,
  chars: ((id: ObjectId) => Characteristics) | null,
): void {
  const def = definitionOf(d, o);
  const ctx: EvalCtx = { ...simpleCtx(d, o.controller, o.id), chars: chars ?? undefined };
  if (def.power !== undefined && typeof def.power !== 'number')
    c.power = evalQuantity(d, def.power as Quantity, ctx);
  if (def.toughness !== undefined && typeof def.toughness !== 'number')
    c.toughness = evalQuantity(d, def.toughness as Quantity, ctx);
}

interface PendingEffect {
  key: string;
  source: ObjectId;
  sourceInstance: number;
  controller: PlayerId;
  timestamp: number;
  parts: StaticEffectDef[];
  condition: Condition | null;
  /** Locked affected set (one-shot created effects), or null for live selection. */
  locked: ObjectId[] | null;
  /** Once the effect has started applying its affected set is fixed (CR 613.6). */
  started: ObjectId[] | null;
  fromStatic: boolean;
  abilityIndex: number;
}

const LAYERS: Layer[] = ['1', '2', '3', '4', '5', '6', '7a', '7b', '7c', '7d', 'rules'];

export function layerOf(e: StaticEffectDef): Layer {
  switch (e.type) {
    case 'control':
      return '2';
    case 'addType':
    case 'setTypes':
    case 'removeType':
      return '4';
    case 'setColor':
    case 'addColor':
      return '5';
    case 'addAbility':
    case 'loseAbility':
      return '6';
    case 'setPT':
      return e.cda ? '7a' : '7b';
    case 'pt':
      return '7c';
    case 'switchPT':
      return '7d';
    default:
      return 'rules';
  }
}

function isPlayerLevel(e: StaticEffectDef): boolean {
  return (
    e.type === 'maxHandSize' ||
    e.type === 'extraLandDrop' ||
    e.type === 'playerCantGainLife' ||
    e.type === 'costReduction' ||
    e.type === 'costIncrease' ||
    e.type === 'cantCast' ||
    e.type === 'cantActivate'
  );
}

/** Static abilities of every battlefield object as pending effects, using abilities as computed so far. */
function gatherStatic(d: GameState, chars: Map<ObjectId, Characteristics>): PendingEffect[] {
  const out: PendingEffect[] = [];
  for (const [id, c] of chars) {
    const o = getObj(d, id);
    c.abilities.forEach((a, i) => {
      if (a.kind !== 'static' || isPlayerLevel(a.effect)) return;
      const parts = [a.effect, ...(a.also ?? [])];
      out.push({
        key: `s:${id}:${i}`,
        source: id,
        sourceInstance: o.instance,
        controller: o.controller,
        timestamp: o.timestamp,
        parts,
        condition: a.condition ?? null,
        locked: null,
        started: null,
        fromStatic: true,
        abilityIndex: i,
      });
    });
  }
  return out;
}

function gatherStored(d: GameState): PendingEffect[] {
  const out: PendingEffect[] = [];
  for (const e of d.effects) {
    if (isPlayerLevel(e.effect)) continue;
    out.push({
      key: `e:${e.id}`,
      source: e.source.id,
      sourceInstance: e.source.instance,
      controller: e.controller,
      timestamp: e.timestamp,
      parts: [e.effect],
      condition: null,
      locked: e.affected
        ? e.affected
            .filter(
              (r) =>
                hasObj(d, r.id) &&
                getObj(d, r.id).instance === r.instance &&
                getObj(d, r.id).zone === 'battlefield',
            )
            .map((r) => r.id)
        : null,
      started: null,
      fromStatic: false,
      abilityIndex: -1,
    });
  }
  return out;
}

function affectedSet(
  d: GameState,
  pe: PendingEffect,
  part: StaticEffectDef,
  chars: Map<ObjectId, Characteristics>,
): ObjectId[] {
  if (pe.locked) return pe.locked;
  if (pe.started) return pe.started;
  const affects: Affects | 'you' | undefined = 'affects' in part ? part.affects : undefined;
  if (!affects || affects === 'you') return [];
  if (affects === 'self') return chars.has(pe.source) ? [pe.source] : [];
  if (affects === 'attached') {
    if (!hasObj(d, pe.source)) return [];
    const to = getObj(d, pe.source).attachedTo;
    return to !== null && chars.has(to) ? [to] : [];
  }
  const ctx: EvalCtx = {
    ...simpleCtx(d, pe.controller, pe.source),
    chars: (id) => chars.get(id) ?? characteristics(d, id),
  };
  const out: ObjectId[] = [];
  for (const id of chars.keys()) if (matchesObject(d, affects, id, ctx)) out.push(id);
  return out;
}

/** Whether a static-ability effect still exists: its source is on the battlefield with the ability, and its condition holds. */
function effectExists(
  d: GameState,
  pe: PendingEffect,
  chars: Map<ObjectId, Characteristics>,
): boolean {
  if (pe.started) return true;
  if (pe.fromStatic) {
    const c = chars.get(pe.source);
    if (!c) return false;
    const ability = c.abilities[pe.abilityIndex];
    if (ability?.kind !== 'static') return false;
    if (c.flags.noAbilities) return false;
  } else if (!hasObj(d, pe.source)) {
    // Effects from resolved spells persist even if the source is gone.
  }
  if (pe.condition) {
    const ctx: EvalCtx = {
      ...simpleCtx(d, pe.controller, pe.source),
      chars: (id) => chars.get(id) ?? characteristics(d, id),
    };
    if (!evalCondition(d, pe.condition, ctx)) return false;
  }
  return true;
}

function applyPart(
  d: GameState,
  pe: PendingEffect,
  part: StaticEffectDef,
  targets: ObjectId[],
  chars: Map<ObjectId, Characteristics>,
): void {
  const ctx: EvalCtx = {
    ...simpleCtx(d, pe.controller, pe.source),
    chars: (id) => chars.get(id) ?? characteristics(d, id),
  };
  for (const id of targets) {
    const c = chars.get(id);
    if (!c) continue;
    switch (part.type) {
      case 'control':
        c.controller = pe.controller;
        break;
      case 'addType':
        for (const t of part.types ?? []) if (!c.types.includes(t)) c.types.push(t);
        for (const s of part.subtypes ?? []) if (!c.subtypes.includes(s)) c.subtypes.push(s);
        addBasicLandAbilities(c, part.subtypes ?? []);
        break;
      case 'setTypes': {
        c.types = part.types.slice();
        const newSubs = part.subtypes ?? [];
        // CR 305.7: setting a basic land type removes other land types and rules-text abilities.
        if (newSubs.some((s) => BASIC_LAND_TYPES[s]) && part.types.includes('land')) {
          c.subtypes = newSubs.slice();
          c.abilities = [];
          c.flags.noAbilities = true;
          addBasicLandAbilities(c, newSubs);
          refreshKeywords(c);
        } else {
          c.subtypes = newSubs.slice();
        }
        break;
      }
      case 'removeType':
        if (part.types) c.types = c.types.filter((t) => !part.types!.includes(t));
        if (part.subtypes) c.subtypes = c.subtypes.filter((s) => !part.subtypes!.includes(s));
        break;
      case 'setColor':
        c.colors = part.colors.slice();
        break;
      case 'addColor':
        for (const col of part.colors) if (!c.colors.includes(col)) c.colors.push(col);
        break;
      case 'addAbility':
        c.abilities.push(part.ability);
        refreshKeywords(c);
        break;
      case 'loseAbility':
        if (part.keyword === 'all') {
          c.abilities = [];
          c.flags.noAbilities = true;
        } else {
          c.abilities = c.abilities.filter(
            (a) => !(a.kind === 'keyword' && a.keyword === part.keyword),
          );
        }
        refreshKeywords(c);
        break;
      case 'setPT':
        c.power = evalQuantity(d, part.power, {
          ...ctx,
          source: { id, instance: getObj(d, id).instance },
        });
        c.toughness = evalQuantity(d, part.toughness, {
          ...ctx,
          source: { id, instance: getObj(d, id).instance },
        });
        break;
      case 'pt':
        c.power += evalQuantity(d, part.power, ctx);
        c.toughness += evalQuantity(d, part.toughness, ctx);
        break;
      case 'switchPT': {
        const p = c.power;
        c.power = c.toughness;
        c.toughness = p;
        break;
      }
      case 'cantAttack':
        c.flags.cantAttack = true;
        break;
      case 'cantBlock':
        c.flags.cantBlock = true;
        break;
      case 'cantBeBlocked':
        c.flags.cantBeBlocked = true;
        break;
      case 'cantBeBlockedBy':
        c.flags.cantBeBlockedBy.push(part.by);
        break;
      case 'doesntUntap':
        c.flags.doesntUntap = true;
        break;
      case 'mustAttack':
        c.flags.mustAttack = true;
        break;
      case 'noMaxLoyaltyActivations':
        break;
      default:
        break;
    }
  }
}

function addBasicLandAbilities(c: Characteristics, subtypes: string[]): void {
  for (const s of subtypes) {
    const color = BASIC_LAND_TYPES[s];
    if (color && c.types.includes('land'))
      c.abilities.push({ kind: 'mana', cost: { tap: true }, produces: `{${color}}` });
  }
}

function cloneMap(m: Map<ObjectId, Characteristics>): Map<ObjectId, Characteristics> {
  const out = new Map<ObjectId, Characteristics>();
  for (const [k, v] of m) out.set(k, cloneChars(v));
  return out;
}

function sameSet(a: ObjectId[], b: ObjectId[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

/**
 * CR 613.8: A depends on B if applying B changes what A applies to, what it does, or whether it exists.
 * We detect the first and last by simulating B on a copy.
 */
function dependsOn(
  d: GameState,
  a: PendingEffect,
  aPart: StaticEffectDef,
  b: PendingEffect,
  bPart: StaticEffectDef,
  chars: Map<ObjectId, Characteristics>,
): boolean {
  if (a.locked || a.started) return false;
  const before = affectedSet(d, a, aPart, chars);
  const existedBefore = effectExists(d, a, chars);
  const sim = cloneMap(chars);
  if (effectExists(d, b, sim)) applyPart(d, b, bPart, affectedSet(d, b, bPart, sim), sim);
  const after = affectedSet(d, a, aPart, sim);
  const existsAfter = effectExists(d, a, sim);
  return !sameSet(before, after) || existedBefore !== existsAfter;
}

/** Computes characteristics of every battlefield object, applying layers 1–7 with timestamps and dependencies. */
export function computeBattlefield(d: Draft): Map<ObjectId, Characteristics> {
  const chars = new Map<ObjectId, Characteristics>();
  const ids = [...d.zones.A.battlefield, ...d.zones.B.battlefield];
  for (const id of ids) {
    const o = getObj(d, id);
    chars.set(id, baseCharacteristics(d, o));
  }
  const stored = gatherStored(d);
  const started = new Map<string, ObjectId[]>();
  // Effects that started applying keep applying in later layers even if their ability was removed (CR 613.6).
  const startedEffects = new Map<string, PendingEffect>();

  // Fast path: no static abilities and no stored effects means only CDAs and counters apply.
  if (stored.length === 0 && !anyStaticAbilities(d)) {
    for (const id of ids) {
      const c = chars.get(id)!;
      applyCdaPT(d, c, getObj(d, id), (x) => chars.get(x) ?? characteristics(d, x));
    }
    applyCounters(d, chars);
    return chars;
  }

  let staticEffects = gatherStatic(d, chars);
  let abilitiesDirty = false;
  for (const layer of LAYERS) {
    if (layer === '1') continue; // copy effects are applied by choosing the base definition
    if (layer === '7a') {
      for (const id of ids) {
        const c = chars.get(id)!;
        applyCdaPT(d, c, getObj(d, id), (x) => chars.get(x) ?? characteristics(d, x));
      }
    }
    if (abilitiesDirty) {
      staticEffects = gatherStatic(d, chars);
      abilitiesDirty = false;
    }
    const pending: PendingEffect[] = [...staticEffects, ...stored];
    for (const [key, pe] of startedEffects)
      if (!pending.some((x) => x.key === key)) pending.push(pe);
    for (const pe of pending) {
      const s = started.get(pe.key);
      if (s) pe.started = s;
    }
    const entries: { pe: PendingEffect; part: StaticEffectDef }[] = [];
    for (const pe of pending)
      for (const part of pe.parts) if (layerOf(part) === layer) entries.push({ pe, part });
    if (entries.length === 0) {
      if (layer === '7c') applyCounters(d, chars);
      continue;
    }
    entries.sort((x, y) => x.pe.timestamp - y.pe.timestamp || x.pe.key.localeCompare(y.pe.key));

    // Dependency ordering (CR 613.8): move an effect after any it depends on, unless the dependency is mutual.
    if (entries.length > 1) {
      const order = entries.slice();
      for (let iter = 0; iter < order.length * order.length; iter++) {
        let moved = false;
        for (let i = 0; i < order.length && !moved; i++) {
          for (let j = i + 1; j < order.length; j++) {
            const a = order[i]!;
            const b = order[j]!;
            if (a.pe === b.pe) continue;
            if (
              dependsOn(d, a.pe, a.part, b.pe, b.part, chars) &&
              !dependsOn(d, b.pe, b.part, a.pe, a.part, chars)
            ) {
              order.splice(i, 1);
              order.splice(j, 0, a);
              moved = true;
              break;
            }
          }
        }
        if (!moved) break;
      }
      entries.length = 0;
      entries.push(...order);
    }

    if (layer === '7c') applyCounters(d, chars);
    for (const { pe, part } of entries) {
      if (!effectExists(d, pe, chars)) continue;
      const targets = affectedSet(d, pe, part, chars);
      if (!pe.locked && !pe.started) {
        pe.started = targets;
        started.set(pe.key, targets);
        startedEffects.set(pe.key, pe);
      }
      applyPart(d, pe, part, targets, chars);
      if (layer === '4' || layer === '6') abilitiesDirty = true;
    }
  }
  return chars;
}

function applyCounters(d: GameState, chars: Map<ObjectId, Characteristics>): void {
  for (const [id, c] of chars) {
    const o = getObj(d, id);
    const plus = o.counters['+1/+1'] ?? 0;
    const minus = o.counters['-1/-1'] ?? 0;
    c.power += plus - minus;
    c.toughness += plus - minus;
  }
}

/** Player-level static effects (hand size, land drops, cost changes) from battlefield permanents and stored effects. */
export function playerLevelEffects(
  d: GameState,
): { effect: StaticEffectDef; controller: PlayerId; source: ObjectId }[] {
  const out: { effect: StaticEffectDef; controller: PlayerId; source: ObjectId }[] = [];
  for (const p of ['A', 'B'] as const) {
    for (const id of d.zones[p].battlefield) {
      const c = characteristics(d, id);
      for (const a of c.abilities) {
        if (a.kind !== 'static' || !isPlayerLevel(a.effect)) continue;
        if (a.condition && !evalCondition(d, a.condition, simpleCtx(d, c.controller, id))) continue;
        out.push({ effect: a.effect, controller: c.controller, source: id });
      }
    }
  }
  for (const e of d.effects)
    if (isPlayerLevel(e.effect))
      out.push({ effect: e.effect, controller: e.controller, source: e.source.id });
  return out;
}

export function playerSelMatches(
  sel: 'you' | 'opponent' | 'any' | undefined,
  controller: PlayerId,
  player: PlayerId,
): boolean {
  if (sel === undefined || sel === 'you') return player === controller;
  if (sel === 'opponent') return player !== controller;
  return true;
}

export function maxHandSize(d: GameState, player: PlayerId): number {
  let size = 7;
  for (const { effect, controller } of playerLevelEffects(d)) {
    if (effect.type === 'maxHandSize' && playerSelMatches(effect.player, controller, player)) {
      if (effect.size === 'unlimited') return Number.POSITIVE_INFINITY;
      size = effect.size;
    }
  }
  return size;
}

export function landDropsAllowed(d: GameState, player: PlayerId): number {
  let n = 1;
  for (const { effect, controller } of playerLevelEffects(d)) {
    if (effect.type === 'extraLandDrop' && playerSelMatches(effect.player, controller, player))
      n += effect.count;
  }
  return n;
}

export function hasKeyword(c: Characteristics, k: Keyword): boolean {
  return c.keywords.has(k);
}

export function isType(c: Characteristics, t: CardType): boolean {
  return c.types.includes(t);
}

export function isCreature(c: Characteristics): boolean {
  return c.types.includes('creature');
}

/** Abilities of an object with keyword expansions and granted abilities, or the LKI copy when it has left. */
export function abilitiesOf(d: GameState, id: ObjectId): AbilityDef[] {
  return characteristics(d, id).abilities;
}

export function effectsAffecting(d: GameState, id: ObjectId): ContinuousEffect[] {
  return d.effects.filter((e) => e.affected?.some((r) => r.id === id) ?? false);
}
