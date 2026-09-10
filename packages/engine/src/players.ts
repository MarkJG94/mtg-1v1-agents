import type { ObjectId, PlayerId } from '@mtg/shared';
import { playerLevelEffects, playerSelMatches } from './characteristics.js';
import { type Draft, emit, obj } from './draft.js';
import { drawReplacement, lifeGainMultiplier } from './replacements.js';
import { shuffle as rngShuffle } from './rng.js';
import { fireTrigger } from './triggers.js';
import { moveObject } from './zones.js';

export function gainLife(d: Draft, player: PlayerId, amount: number): number {
  if (amount <= 0) return 0;
  for (const { effect, controller } of playerLevelEffects(d)) {
    if (effect.type === 'playerCantGainLife' && playerSelMatches(effect.player, controller, player))
      return 0;
  }
  const gained = amount * lifeGainMultiplier(d, player);
  const p = d.players[player];
  p.life += gained;
  p.lifeGainedThisTurn += gained;
  emit(d, { type: 'lifeChange', player, delta: gained, life: p.life });
  fireTrigger(d, { on: 'lifeGain', player, amount: gained });
  return gained;
}

export function loseLife(d: Draft, player: PlayerId, amount: number): number {
  if (amount <= 0) return 0;
  const p = d.players[player];
  p.life -= amount;
  p.lifeLostThisTurn += amount;
  emit(d, { type: 'lifeChange', player, delta: -amount, life: p.life });
  d.sbaPending = true;
  return amount;
}

export function setLife(d: Draft, player: PlayerId, amount: number): void {
  const p = d.players[player];
  if (amount > p.life) gainLife(d, player, amount - p.life);
  else if (amount < p.life) loseLife(d, player, p.life - amount);
}

export function addPoison(d: Draft, player: PlayerId, amount: number): void {
  if (amount <= 0) return;
  const p = d.players[player];
  p.poison += amount;
  emit(d, { type: 'poison', player, delta: amount, poison: p.poison });
  d.sbaPending = true;
}

/** Draws one card, applying draw replacements; drawing from an empty library flags the loss for SBAs (CR 704.5b). */
export function drawCard(d: Draft, player: PlayerId): ObjectId | null {
  const rep = drawReplacement(d, player);
  if (rep?.skip) return null;
  const lib = d.zones[player].library;
  if (lib.length === 0) {
    d.players[player].attemptedDrawFromEmpty = true;
    d.sbaPending = true;
    return null;
  }
  const id = lib[0]!;
  moveObject(d, id, 'hand');
  d.players[player].drawnThisTurn++;
  emit(d, { type: 'draw', player, object: id });
  fireTrigger(d, { on: 'draw', player, object: id });
  return id;
}

export function drawCards(d: Draft, player: PlayerId, n: number): ObjectId[] {
  const out: ObjectId[] = [];
  for (let i = 0; i < n; i++) {
    const id = drawCard(d, player);
    if (id !== null) out.push(id);
  }
  return out;
}

export function discardCard(d: Draft, player: PlayerId, id: ObjectId): void {
  moveObject(d, id, 'graveyard');
  emit(d, { type: 'discard', player, object: id });
  fireTrigger(d, { on: 'discard', player, object: id });
}

export function millCards(d: Draft, player: PlayerId, n: number): ObjectId[] {
  const out: ObjectId[] = [];
  for (let i = 0; i < n; i++) {
    const id = d.zones[player].library[0];
    if (id === undefined) break;
    moveObject(d, id, 'graveyard');
    out.push(id);
  }
  return out;
}

export function shuffleLibrary(d: Draft, player: PlayerId): void {
  const [shuffled, rng] = rngShuffle(d.rng, d.zones[player].library);
  d.zones[player].library = shuffled;
  d.rng = rng;
  emit(d, { type: 'shuffle', player });
}

export function emptyManaPool(d: Draft, player: PlayerId): void {
  const pool = d.players[player].pool;
  if (pool.W + pool.U + pool.B + pool.R + pool.G + pool.C === 0) return;
  d.players[player].pool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  emit(d, { type: 'manaEmptied', player });
}

export function markSick(d: Draft, id: ObjectId): void {
  obj(d, id).sick = true;
}
