import type { ObjectId, PlayerId } from '@mtg/shared';
import { characteristics } from '../characteristics.js';
import type { Draft } from '../draft.js';
import { beginDraft } from '../draft.js';
import type { GameState } from '../state.js';

export class InvariantViolation extends Error {}

function fail(msg: string): never {
  throw new InvariantViolation(msg);
}

/**
 * Structural invariants that must hold whenever the engine pauses for a decision (docs/09-testing.md §4).
 * `deckSizes` enables card-conservation checks.
 */
export function checkInvariants(state: GameState, deckSizes?: Record<PlayerId, number>): void {
  const d: Draft = beginDraft(state);
  const seen = new Map<ObjectId, string>();
  for (const p of ['A', 'B'] as const) {
    const z = d.zones[p];
    for (const name of [
      'library',
      'hand',
      'battlefield',
      'graveyard',
      'exile',
      'command',
    ] as const) {
      for (const id of z[name]) {
        if (seen.has(id)) fail(`object ${id} in two zones: ${seen.get(id)} and ${p}.${name}`);
        seen.set(id, `${p}.${name}`);
        const o = d.objects[id];
        if (!o) fail(`zone ${p}.${name} references missing object ${id}`);
        if (o.zone !== name) fail(`object ${id} zone field ${o.zone} but found in ${p}.${name}`);
        if (name === 'battlefield' && o.controller !== p)
          fail(`object ${id} controlled by ${o.controller} but on ${p}'s battlefield`);
        if (name !== 'battlefield' && o.owner !== p)
          fail(`object ${id} owned by ${o.owner} but in ${p}.${name}`);
      }
    }
  }
  for (const item of d.stack) {
    if (item.kind !== 'spell') continue;
    const o = d.objects[item.source.id];
    if (!o) fail(`stack spell ${item.source.id} missing`);
    if (o.zone !== 'stack') fail(`stack spell ${item.source.id} has zone ${o.zone}`);
    if (seen.has(item.source.id))
      fail(`stack spell ${item.source.id} also in ${seen.get(item.source.id)}`);
    seen.set(item.source.id, 'stack');
  }
  for (const [idStr, o] of Object.entries(d.objects)) {
    const id = Number(idStr);
    if (o.zone === 'stack') {
      if (!seen.has(id)) seen.set(id, 'stack');
      continue;
    }
    if (!seen.has(id))
      fail(`object ${id} (${o.definitionId}) in zone ${o.zone} is not in any zone array`);
  }
  if (deckSizes) {
    for (const p of ['A', 'B'] as const) {
      const n = Object.values(d.objects).filter((o) => o.owner === p && !o.isToken).length;
      if (n !== deckSizes[p]) fail(`player ${p} has ${n} cards, expected ${deckSizes[p]}`);
    }
  }
  const dec = d.pendingDecision;
  if (dec && !d.result) {
    if (dec.kind === 'priority') {
      if (dec.actions.length === 0) fail('priority decision with no actions');
      if (d.priority !== dec.player) fail('priority decision for a player without priority');
      // At priority, SBAs have been performed.
      for (const p of ['A', 'B'] as const) {
        for (const id of d.zones[p].battlefield) {
          const c = characteristics(d, id);
          const o = d.objects[id]!;
          if (c.types.includes('creature') && c.toughness <= 0)
            fail(`creature ${id} with toughness ${c.toughness} on battlefield at priority`);
          if (
            c.types.includes('creature') &&
            o.damage >= c.toughness &&
            !c.keywords.has('indestructible')
          )
            fail(`creature ${id} with lethal damage on battlefield at priority`);
          if (c.types.includes('planeswalker') && (o.counters.loyalty ?? 0) <= 0)
            fail(`planeswalker ${id} with 0 loyalty at priority`);
        }
        const legendary = new Map<string, number>();
        for (const id of d.zones[p].battlefield) {
          const c = characteristics(d, id);
          if (c.supertypes.includes('legendary'))
            legendary.set(c.name, (legendary.get(c.name) ?? 0) + 1);
        }
        for (const [name, n] of legendary) if (n > 1) fail(`legend rule violated for ${name}`);
        if (d.players[p].life <= 0) fail(`player ${p} at ${d.players[p].life} life at priority`);
      }
      if (d.pendingTriggers.length > 0) fail('pending triggers at priority');
    }
    if (dec.kind === 'chooseObjects' && dec.options.length < dec.min)
      fail('chooseObjects with too few options');
    if (dec.kind === 'chooseTargets') {
      dec.specs.forEach((s, i) => {
        if (
          dec.candidates[i]!.length === 0 &&
          !(s.optional || s.count === 'any' || typeof s.count === 'object')
        )
          fail(`chooseTargets with no candidates for ${s.id}`);
      });
    }
  }
  for (const p of ['A', 'B'] as const) if (d.players[p].poison < 0) fail('negative poison');
}
