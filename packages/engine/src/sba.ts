import type { GameEndReason, ObjectId, PlayerId } from '@mtg/shared';
import { opponentOf } from '@mtg/shared';
import { characteristics } from './characteristics.js';
import { type Draft, emit, getObj, hasObj, invalidate, obj } from './draft.js';
import { applyControlChanges, destroy } from './effects.js';
import { matchesObject, simpleCtx } from './eval.js';
import { moveObject } from './zones.js';

export function endGame(d: Draft, winner: PlayerId | null, reason: GameEndReason): void {
  if (d.result) return;
  d.result = { winner, reason };
  d.pendingDecision = null;
  d.frames = [];
  emit(d, { type: 'gameEnd', winner, reason });
}

function checkPlayerLosses(d: Draft): boolean {
  const reasons: Partial<Record<PlayerId, GameEndReason>> = {};
  for (const p of ['A', 'B'] as const) {
    const ps = d.players[p];
    if (ps.lost) reasons[p] = 'effect';
    else if (ps.life <= 0) reasons[p] = 'life';
    else if (ps.attemptedDrawFromEmpty) reasons[p] = 'drawFromEmptyLibrary';
    else if (ps.poison >= 10) reasons[p] = 'poison';
  }
  const a = reasons.A;
  const b = reasons.B;
  if (a && b) endGame(d, null, a);
  else if (a) endGame(d, 'B', a);
  else if (b) endGame(d, 'A', b);
  return a !== undefined || b !== undefined;
}

/** Performs one round of state-based actions (CR 704.5). Returns true if anything happened. */
export function checkStateBasedActions(d: Draft): boolean {
  if (d.result) return false;
  if (checkPlayerLosses(d)) return true;
  let acted = false;
  applyControlChanges(d);

  // 704.5d: tokens outside the battlefield cease to exist.
  for (const p of ['A', 'B'] as const) {
    const z = d.zones[p];
    for (const name of ['graveyard', 'exile', 'hand', 'library', 'command'] as const) {
      for (const id of z[name].slice()) {
        if (getObj(d, id).isToken) {
          z[name] = z[name].filter((x) => x !== id);
          delete d.objects[id];
          d.dirty.delete(id);
          invalidate(d);
          acted = true;
        }
      }
    }
  }

  // Continuous effects whose source has left the battlefield end.
  const before = d.effects.length;
  d.effects = d.effects.filter((e) => {
    if (e.duration.kind !== 'untilSourceLeaves') return true;
    const s = e.duration.source;
    return (
      hasObj(d, s.id) &&
      getObj(d, s.id).instance === s.instance &&
      getObj(d, s.id).zone === 'battlefield'
    );
  });
  if (d.effects.length !== before) {
    invalidate(d);
    acted = true;
  }

  const battlefield = [...d.zones.A.battlefield, ...d.zones.B.battlefield];
  const toGraveyard: ObjectId[] = [];
  const toDestroy: ObjectId[] = [];
  for (const id of battlefield) {
    const c = characteristics(d, id);
    const o = getObj(d, id);
    if (c.types.includes('creature')) {
      if (c.toughness <= 0) toGraveyard.push(id);
      else if (o.damage >= c.toughness || o.deathtouched) toDestroy.push(id);
    }
    if (c.types.includes('planeswalker') && (o.counters.loyalty ?? 0) <= 0) toGraveyard.push(id);
  }
  for (const id of toGraveyard) {
    emit(d, { type: 'sba', kind: 'zeroToughnessOrLoyalty', object: id });
    moveObject(d, id, 'graveyard');
    acted = true;
  }
  for (const id of toDestroy) {
    if (!hasObj(d, id) || getObj(d, id).zone !== 'battlefield') continue;
    emit(d, { type: 'sba', kind: 'lethalDamage', object: id });
    if (destroy(d, id)) acted = true;
    else {
      // Indestructible with lethal damage stays; nothing to do.
    }
  }

  // 704.5j: legend rule — keep the most recent, others go to the graveyard.
  for (const p of ['A', 'B'] as const) {
    const byName = new Map<string, ObjectId[]>();
    for (const id of d.zones[p].battlefield) {
      const c = characteristics(d, id);
      if (!c.supertypes.includes('legendary')) continue;
      byName.set(c.name, [...(byName.get(c.name) ?? []), id]);
    }
    for (const ids of byName.values()) {
      if (ids.length < 2) continue;
      const keep = ids.reduce(
        (best, id) => (getObj(d, id).timestamp > getObj(d, best).timestamp ? id : best),
        ids[0]!,
      );
      for (const id of ids) {
        if (id === keep) continue;
        emit(d, { type: 'sba', kind: 'legendRule', object: id });
        moveObject(d, id, 'graveyard');
        acted = true;
      }
    }
  }

  // 704.5m/n: auras and equipment attached illegally.
  for (const id of [...d.zones.A.battlefield, ...d.zones.B.battlefield]) {
    if (!hasObj(d, id) || getObj(d, id).zone !== 'battlefield') continue;
    const c = characteristics(d, id);
    const o = getObj(d, id);
    const isAura = c.types.includes('enchantment') && c.subtypes.includes('Aura');
    const isEquipment = c.types.includes('artifact') && c.subtypes.includes('Equipment');
    if (!isAura && !isEquipment) continue;
    const enchantFilter = auraFilter(d, id);
    if (isAura) {
      const legal =
        o.attachedTo !== null &&
        hasObj(d, o.attachedTo) &&
        getObj(d, o.attachedTo).zone === 'battlefield' &&
        attachmentLegal(d, id, o.attachedTo, enchantFilter, o.controller);
      if (!legal) {
        emit(d, { type: 'sba', kind: 'auraIllegal', object: id });
        moveObject(d, id, 'graveyard');
        acted = true;
      }
    } else if (o.attachedTo !== null) {
      const legal =
        hasObj(d, o.attachedTo) &&
        getObj(d, o.attachedTo).zone === 'battlefield' &&
        attachmentLegal(d, id, o.attachedTo, { type: 'creature' }, o.controller);
      if (!legal) {
        const host = hasObj(d, o.attachedTo) ? obj(d, o.attachedTo) : null;
        if (host) host.attachments = host.attachments.filter((x) => x !== id);
        obj(d, id).attachedTo = null;
        emit(d, { type: 'unattach', object: id });
        acted = true;
      }
    }
  }

  // 704.5q: +1/+1 and -1/-1 counters annihilate.
  for (const id of [...d.zones.A.battlefield, ...d.zones.B.battlefield]) {
    const o = getObj(d, id);
    const plus = o.counters['+1/+1'] ?? 0;
    const minus = o.counters['-1/-1'] ?? 0;
    if (plus > 0 && minus > 0) {
      const n = Math.min(plus, minus);
      const w = obj(d, id);
      w.counters['+1/+1'] = plus - n;
      w.counters['-1/-1'] = minus - n;
      if (w.counters['+1/+1'] === 0) delete w.counters['+1/+1'];
      if (w.counters['-1/-1'] === 0) delete w.counters['-1/-1'];
      invalidate(d);
      emit(d, { type: 'sba', kind: 'counterAnnihilation', object: id });
      acted = true;
    }
  }

  if (acted) d.sbaPending = true;
  else d.sbaPending = false;
  return acted;
}

function auraFilter(d: Draft, aura: ObjectId): import('./definition.js').Filter {
  const c = characteristics(d, aura);
  for (const a of c.abilities) {
    if (a.kind === 'spell' && a.targets && a.targets.length > 0) return a.targets[0]!.filter;
  }
  return { anyPermanent: true };
}

function attachmentLegal(
  d: Draft,
  attachment: ObjectId,
  host: ObjectId,
  filter: import('./definition.js').Filter,
  controller: PlayerId,
): boolean {
  if (attachment === host) return false;
  const hc = characteristics(d, host);
  const ac = characteristics(d, attachment);
  // Protection from the attachment's qualities (CR 702.16c).
  for (const p of hc.protections) {
    if ('everything' in p) return false;
    if ('color' in p && ac.colors.includes(p.color)) return false;
    if ('colored' in p && ac.colors.length > 0) return false;
    if ('type' in p && ac.types.includes(p.type)) return false;
  }
  const f = { ...filter };
  delete (f as { zone?: unknown }).zone;
  return matchesObject(d, f, host, simpleCtx(d, controller, attachment));
}

export function playerHasLost(d: Draft, p: PlayerId): boolean {
  return d.result !== null && d.result.winner === opponentOf(p);
}
