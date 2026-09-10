import type { ObjectId, PlayerId, ZoneName } from '@mtg/shared';
import { characteristics } from './characteristics.js';
import type { CardDefinition, TokenDef } from './definition.js';
import { type Draft, emit, getObj, hasObj, invalidate, nextTimestamp, obj } from './draft.js';
import { simpleCtx } from './eval.js';
import { diesReplacement, etbModifiers, extraCounters, extraTokens } from './replacements.js';
import type { Characteristics, GameObject } from './state.js';
import { fireTrigger } from './triggers.js';

export function createObject(
  d: Draft,
  definitionId: string,
  owner: PlayerId,
  zoneName: Exclude<ZoneName, 'stack'>,
  isToken = false,
): ObjectId {
  const id = d.nextObjectId++;
  const o: GameObject = {
    id,
    instance: 0,
    definitionId,
    owner,
    controller: owner,
    defaultController: owner,
    zone: zoneName,
    timestamp: nextTimestamp(d),
    tapped: false,
    counters: {},
    damage: 0,
    deathtouched: false,
    attachedTo: null,
    attachments: [],
    isToken,
    copyOf: null,
    sick: true,
    enteredThisTurn: true,
    regenerationShields: 0,
    loyaltyActivationsThisTurn: 0,
    abilityActivationsThisTurn: {},
    lki: null,
    chosen: {},
    x: 0,
    wasCast: false,
    preventionShield: 0,
  };
  d.objects[id] = o;
  d.dirty.add(id);
  d.zones[owner][zoneName].push(id);
  invalidate(d);
  emit(d, { type: 'objectCreated', object: id, definition: definitionId, owner, token: isToken });
  return id;
}

export interface MoveOptions {
  /** Place at the top of the library (default bottom for library moves is false → top). */
  libraryPosition?: 'top' | 'bottom';
  tapped?: boolean;
  controller?: PlayerId;
  /** Suppress "dies" replacement (e.g. sacrifice as cost still counts as dying; exile does not). */
  counters?: Record<string, number>;
  /** Attach to this object as it enters (auras). */
  attachTo?: ObjectId;
  /** Enters attacking (tokens created attacking). */
  attacking?: boolean;
}

function removeFromZone(d: Draft, o: GameObject): void {
  if (o.zone === 'stack') {
    d.stack = d.stack.filter((s) => !(s.kind === 'spell' && s.source.id === o.id));
    return;
  }
  const arr = d.zones[o.owner][o.zone];
  const idx = arr.indexOf(o.id);
  if (idx >= 0) arr.splice(idx, 1);
}

/**
 * Moves an object between zones (CR 400.7), applying replacement effects, capturing last known information,
 * resetting object state, and collecting leaves/enters triggers.
 */
export function moveObject(d: Draft, id: ObjectId, to: ZoneName, opts: MoveOptions = {}): boolean {
  return moveObjects(d, [id], to, opts) > 0;
}

/**
 * Moves several objects simultaneously (e.g. Wrath of God): every leaves-the-battlefield trigger sees all of
 * them with their last known information (CR 603.10a). Returns the number of objects moved.
 */
export function moveObjects(
  d: Draft,
  ids: ObjectId[],
  to: ZoneName,
  opts: MoveOptions = {},
): number {
  const moved: { id: ObjectId; from: ZoneName; dest: ZoneName }[] = [];
  const lkiMap = new Map<ObjectId, Characteristics>();
  const lkis = new Map<ObjectId, Characteristics>();
  for (const id of ids) {
    if (!hasObj(d, id)) continue;
    lkis.set(id, characteristics(d, id));
  }
  for (const id of ids) {
    if (!hasObj(d, id)) continue;
    const before = getObj(d, id);
    const from = before.zone;
    const lkiChars = lkis.get(id)!;
    let dest: ZoneName = to;
    let libraryPosition = opts.libraryPosition ?? 'top';

    if (from === 'battlefield' && to === 'graveyard') {
      const ctx = {
        ...simpleCtx(d, lkiChars.controller, id),
        chars: (x: ObjectId) => lkis.get(x) ?? characteristics(d, x),
      };
      const instead = diesReplacement(d, id, ctx);
      if (instead === 'exile') dest = 'exile';
      else if (instead === 'hand') dest = 'hand';
      else if (instead === 'libraryTop') {
        dest = 'library';
        libraryPosition = 'top';
      } else if (instead === 'libraryBottom') {
        dest = 'library';
        libraryPosition = 'bottom';
      }
    }

    // Tokens that leave the battlefield still go to the new zone briefly (dies triggers see them) and are
    // removed by state-based actions (CR 704.5d).
    const o = obj(d, id);
    removeFromZone(d, o);

    if (from === 'battlefield') {
      o.lki = lkiChars;
      lkiMap.set(id, lkiChars);
      // Attachments fall off (CR 704.5m handles auras; equipment simply becomes unattached).
      for (const att of o.attachments) {
        if (hasObj(d, att)) {
          obj(d, att).attachedTo = null;
          emit(d, { type: 'unattach', object: att });
        }
      }
      o.attachments = [];
      if (o.attachedTo !== null && hasObj(d, o.attachedTo)) {
        const host = obj(d, o.attachedTo);
        host.attachments = host.attachments.filter((x) => x !== id);
        emit(d, { type: 'unattach', object: id });
      }
      o.attachedTo = null;
      if (d.combat) removeFromCombat(d, id);
    }

    o.zone = dest;
    o.instance++;
    o.tapped = false;
    o.counters = {};
    o.damage = 0;
    o.deathtouched = false;
    o.regenerationShields = 0;
    o.loyaltyActivationsThisTurn = 0;
    o.abilityActivationsThisTurn = {};
    o.preventionShield = 0;
    o.timestamp = nextTimestamp(d);
    o.controller = dest === 'battlefield' ? (opts.controller ?? o.controller) : o.owner;
    o.defaultController = o.controller;
    if (dest !== 'battlefield' && dest !== 'stack') {
      o.copyOf = null;
      o.x = 0;
      o.chosen = {};
    }
    if (dest === 'stack') o.controller = opts.controller ?? o.owner;

    if (dest === 'library') {
      if (libraryPosition === 'top') d.zones[o.owner].library.unshift(id);
      else d.zones[o.owner].library.push(id);
    } else if (dest === 'battlefield') {
      d.zones[o.controller].battlefield.push(id);
    } else if (dest !== 'stack') {
      d.zones[o.owner][dest].push(id);
    }

    if (dest === 'battlefield') {
      const mods = etbModifiers(d, id, { tapped: opts.tapped ?? false });
      o.tapped = mods.tapped;
      o.sick = true;
      o.enteredThisTurn = true;
      const counters = { ...mods.counters };
      for (const [k, v] of Object.entries(opts.counters ?? {}))
        counters[k] = (counters[k] ?? 0) + v;
      for (const [k, v] of Object.entries(counters)) if (v > 0) o.counters[k] = v;
      const def = d.definitions[o.copyOf ?? o.definitionId];
      if (def?.loyalty !== undefined && def.types.includes('planeswalker') && !o.counters.loyalty) {
        o.counters.loyalty = def.loyalty;
      }
      if (opts.attachTo !== undefined && hasObj(d, opts.attachTo)) attach(d, id, opts.attachTo);
    }

    invalidate(d);
    emit(d, { type: 'moveZone', object: id, from, to: dest, owner: o.owner });
    for (const [k, v] of Object.entries(o.counters))
      if (v > 0) emit(d, { type: 'counterChange', object: id, counter: k, delta: v, total: v });
    moved.push({ id, from, dest });
  }

  for (const { id, from, dest } of moved) {
    if (from === 'battlefield') {
      fireTrigger(d, { on: 'ltb', object: id }, lkiMap);
      if (dest === 'graveyard') fireTrigger(d, { on: 'dies', object: id }, lkiMap);
    }
    if (dest === 'battlefield') {
      fireTrigger(d, { on: 'etb', object: id });
      if (characteristics(d, id).types.includes('land'))
        fireTrigger(d, { on: 'landfall', player: getObj(d, id).controller, object: id });
    }
  }
  if (moved.length > 0) d.sbaPending = true;
  return moved.length;
}

export function removeFromCombat(d: Draft, id: ObjectId): void {
  if (!d.combat) return;
  for (const a of d.combat.attackers) {
    if (a.attacker === id) a.removedFromCombat = true;
    if (a.blockers.includes(id)) {
      a.blockers = a.blockers.filter((b) => b !== id);
      a.blockerOrder = a.blockerOrder.filter((b) => b !== id);
    }
  }
  delete d.combat.blockers[id];
}

export function attach(d: Draft, id: ObjectId, to: ObjectId): void {
  const o = obj(d, id);
  if (o.attachedTo !== null && hasObj(d, o.attachedTo)) {
    const old = obj(d, o.attachedTo);
    old.attachments = old.attachments.filter((x) => x !== id);
  }
  o.attachedTo = to;
  o.timestamp = nextTimestamp(d);
  const host = obj(d, to);
  if (!host.attachments.includes(id)) host.attachments.push(id);
  invalidate(d);
  emit(d, { type: 'attach', object: id, to });
}

export function tap(d: Draft, id: ObjectId): boolean {
  const o = getObj(d, id);
  if (o.tapped || o.zone !== 'battlefield') return false;
  obj(d, id).tapped = true;
  emit(d, { type: 'tap', object: id });
  fireTrigger(d, { on: 'tapped', object: id });
  return true;
}

export function untap(d: Draft, id: ObjectId): boolean {
  const o = getObj(d, id);
  if (!o.tapped || o.zone !== 'battlefield') return false;
  obj(d, id).tapped = false;
  emit(d, { type: 'untap', object: id });
  return true;
}

export function addCounters(d: Draft, id: ObjectId, counter: string, amount: number): void {
  if (amount <= 0 || !hasObj(d, id)) return;
  const o = obj(d, id);
  if (o.zone !== 'battlefield') return;
  const total = amount + extraCounters(d, id);
  o.counters[counter] = (o.counters[counter] ?? 0) + total;
  invalidate(d);
  emit(d, {
    type: 'counterChange',
    object: id,
    counter,
    delta: total,
    total: o.counters[counter]!,
  });
  for (let i = 0; i < total; i++) fireTrigger(d, { on: 'counterPlaced', object: id, counter });
  d.sbaPending = true;
}

export function removeCounters(d: Draft, id: ObjectId, counter: string, amount: number): number {
  if (amount <= 0 || !hasObj(d, id)) return 0;
  const o = obj(d, id);
  const have = o.counters[counter] ?? 0;
  const removed = Math.min(have, amount);
  if (removed === 0) return 0;
  o.counters[counter] = have - removed;
  if (o.counters[counter] === 0) delete o.counters[counter];
  invalidate(d);
  emit(d, {
    type: 'counterChange',
    object: id,
    counter,
    delta: -removed,
    total: o.counters[counter] ?? 0,
  });
  d.sbaPending = true;
  return removed;
}

export function tokenDefinitionId(token: TokenDef): string {
  const key = JSON.stringify({
    n: token.name,
    t: token.types,
    s: token.subtypes ?? [],
    st: token.supertypes ?? [],
    c: token.colors ?? [],
    p: token.power ?? null,
    tg: token.toughness ?? null,
    a: token.abilities ?? [],
  });
  let h = 2166136261 >>> 0;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `token:${token.name}:${h.toString(16)}`;
}

export function createToken(
  d: Draft,
  token: TokenDef,
  controller: PlayerId,
  opts: { tapped?: boolean; attacking?: boolean } = {},
): ObjectId[] {
  const defId = tokenDefinitionId(token);
  if (!d.definitions[defId]) {
    const def: CardDefinition = {
      id: defId,
      name: token.name,
      types: token.types,
      subtypes: token.subtypes ?? [],
      supertypes: token.supertypes ?? [],
      colors: token.colors ?? [],
      abilities: token.abilities ?? [],
      token: true,
    };
    if (token.power !== undefined) def.power = token.power;
    if (token.toughness !== undefined) def.toughness = token.toughness;
    d.definitions = { ...d.definitions, [defId]: def };
  }
  const count = 1 + extraTokens(d, controller);
  const ids: ObjectId[] = [];
  for (let i = 0; i < count; i++) {
    const id = createObject(d, defId, controller, 'exile', true);
    // Created directly onto the battlefield: createObject placed it in exile as a staging zone.
    const o = obj(d, id);
    const idx = d.zones[controller].exile.indexOf(id);
    if (idx >= 0) d.zones[controller].exile.splice(idx, 1);
    o.zone = 'exile';
    const moveOpts: { tapped?: boolean; controller: PlayerId } = { controller };
    if (opts.tapped) moveOpts.tapped = true;
    moveObject(d, id, 'battlefield', moveOpts);
    if (opts.attacking && d.combat) {
      const defender =
        d.activePlayer === controller ? (controller === 'A' ? 'B' : 'A') : controller;
      d.combat.attackers.push({
        attacker: id,
        defender,
        blockers: [],
        blockerOrder: [],
        blocked: false,
        removedFromCombat: false,
      });
    }
    ids.push(id);
  }
  return ids;
}
