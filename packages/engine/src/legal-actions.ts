import { type Colour, isMainPhase, type ObjectId, type PlayerId, playerZone } from '@mtg/shared';
import type { ManaAbility } from './mana/ability.js';
import type { ManaCost } from './mana/cost.js';
import { canPayFromSources, type PotentialMana } from './mana/payment.js';
import { isStackEmpty, splitSecondActive } from './stack.js';
import type { GameState } from './state/game-state.js';
import { isGameOver } from './state/game-state.js';
import { getObject, objectsIn } from './state/update.js';
import { landsRemainingThisTurn } from './turn/land.js';

/**
 * `legalActions` — the single source of truth for what a player may do right now
 * (docs/02). Nothing else decides legality, so the AI never has to and a fuzzer can pick
 * uniformly from the result. The invariant docs/09 asks for is that it never offers an
 * action the engine would then reject.
 *
 * What a card *is* — whether it is a land, what it costs, whether it is sorcery-speed —
 * comes from its card script, so this reads it through `CardInfoSource`. Roadmap 2.1
 * implements that over real definitions; until then a caller supplies one, which is what
 * the tests do.
 */

export interface CardInfo {
  readonly isLand: boolean;
  readonly manaCost: ManaCost;
  /** Sorceries, creatures and other non-instants: only in your own main phase. */
  readonly sorcerySpeed: boolean;
  /** The spell's colours, which decide what protection stops it. */
  readonly colours: readonly Colour[];
}

export interface CardInfoSource {
  /** `null` for a card the engine has no script for, which is therefore unplayable. */
  infoFor(state: GameState, id: ObjectId): CardInfo | null;
  /** Mana abilities of permanents this player controls; used for cost payability. */
  manaAbilitiesFor?(state: GameState, player: PlayerId): readonly ManaAbility[];
}

export type LegalAction =
  | { readonly kind: 'pass' }
  | { readonly kind: 'playLand'; readonly object: ObjectId }
  | { readonly kind: 'cast'; readonly object: ObjectId; readonly cost: ManaCost };

/**
 * Mana the player could still make by tapping what they control. A source that makes
 * several mana at once contributes several entries; one that offers a choice of colours
 * contributes a single entry listing them, which is exactly how the solver reads it.
 */
export const potentialManaFor = (
  state: GameState,
  player: PlayerId,
  abilities: readonly ManaAbility[],
): readonly PotentialMana[] => {
  const potential: PotentialMana[] = [];

  for (const ability of abilities) {
    const source = state.objects.get(ability.source);
    if (source?.zone !== 'battlefield' || source.controller !== player) continue;
    if (ability.requiresTap && source.tapped) continue;

    // Modes almost always make the same number of mana (a dual land offers a choice of
    // colour, not of count), and then each slot can offer the union of what the modes
    // could put there — which is exact. When the counts differ, take the smallest, so
    // this under-reports rather than over-reports: `legalActions` must never offer a
    // spell the engine would then refuse to let the player pay for (docs/09).
    const counts = ability.modes.map((mode) => mode.reduce((n, p) => n + p.amount, 0));
    const width = counts.length === 0 ? 0 : Math.min(...counts);

    for (let slot = 0; slot < width; slot += 1) {
      const types = new Set<PotentialMana['types'][number]>();
      let snow = false;
      for (const mode of ability.modes) {
        const flattened = mode.flatMap((production) =>
          Array.from({ length: production.amount }, () => production),
        );
        const production = flattened[slot];
        if (!production) continue;
        types.add(production.type);
        snow = snow || (production.snow ?? false);
      }
      if (types.size > 0) potential.push({ types: [...types], snow });
    }
  }

  return potential;
};

/** Whether a land may be played right now (CR 305.1). */
const canPlayLandNow = (state: GameState, player: PlayerId): boolean =>
  state.activePlayer === player &&
  isMainPhase(state.step) &&
  isStackEmpty(state) &&
  landsRemainingThisTurn(state, player) > 0;

/** Whether a spell of this speed may be cast right now (CR 307.1, 601.3a). */
const canCastNow = (state: GameState, player: PlayerId, sorcerySpeed: boolean): boolean =>
  !sorcerySpeed ||
  (state.activePlayer === player && isMainPhase(state.step) && isStackEmpty(state));

export const legalActions = (
  state: GameState,
  player: PlayerId,
  cards: CardInfoSource,
): readonly LegalAction[] => {
  // Only the player with priority acts, and a finished game has no actions at all.
  if (isGameOver(state) || state.priority !== player) return [];

  // Passing is always available to whoever holds priority (CR 117.4).
  const actions: LegalAction[] = [{ kind: 'pass' }];

  // While a split-second spell waits, nothing else can be cast or activated (CR 702.61a).
  if (splitSecondActive(state)) return actions;

  const abilities = cards.manaAbilitiesFor?.(state, player) ?? [];
  const potential = potentialManaFor(state, player, abilities);
  const pool = state.players[player].manaPool;

  for (const id of objectsIn(state, playerZone(player, 'hand'))) {
    const info = cards.infoFor(state, id);
    if (!info) continue;

    if (info.isLand) {
      // Playing a land is a special action, not a spell: no cost, no stack (CR 115.2a).
      if (canPlayLandNow(state, player)) actions.push({ kind: 'playLand', object: id });
      continue;
    }

    if (!canCastNow(state, player, info.sorcerySpeed)) continue;
    if (!canPayFromSources(pool, potential, info.manaCost, { life: state.players[player].life })) {
      continue;
    }
    actions.push({ kind: 'cast', object: id, cost: info.manaCost });
  }

  return actions;
};

/** Whether the object is one the player could cast right now. */
export const canCast = (
  state: GameState,
  player: PlayerId,
  id: ObjectId,
  cards: CardInfoSource,
): boolean =>
  legalActions(state, player, cards).some(
    (action) => action.kind === 'cast' && action.object === id,
  );

/** Permanents a player controls, the usual starting point for a candidate target set. */
export const permanentsControlledBy = (state: GameState, player: PlayerId): readonly ObjectId[] =>
  objectsIn(state, 'battlefield').filter((id) => getObject(state, id).controller === player);
