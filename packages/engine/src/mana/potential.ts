import type { PlayerId } from '@mtg/shared';
import type { GameState } from '../state/game-state.js';
import type { ManaAbility } from './ability.js';
import type { PotentialMana } from './payment.js';

/**
 * Mana the player could still make by tapping what they control. A source that makes
 * several mana at once contributes several entries; one that offers a choice of colours
 * contributes a single entry listing them, which is exactly how the solver reads it.
 *
 * A permanent with several abilities that each tap it — "{T}: Add {C}" and "{T}: Add {G}"
 * — is tapped by one of them only (CR 602.5a: a cost with {T} cannot be paid by a tapped
 * permanent), so it counts once, as one ability offering every mode of them all.
 */
export const potentialManaFor = (
  state: GameState,
  player: PlayerId,
  abilities: readonly ManaAbility[],
): readonly PotentialMana[] => {
  const potential: PotentialMana[] = [];

  for (const ability of oneTapEach(abilities)) {
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
        const production = productionAt(mode, slot);
        if (!production) continue;
        types.add(production.type);
        snow = snow || (production.snow ?? false);
      }
      if (types.size > 0) potential.push({ types: [...types], snow });
    }
  }

  return potential;
};

/**
 * Which production fills slot `slot` of a mode, counting `amount` as that many slots.
 *
 * Walked rather than materialised. This used to flatten the whole mode into an array for
 * every slot of every ability on every call, and `legalActions` runs on every priority
 * grant — about six hundred times a game, twice over. That allocation was half the cost
 * of the function and a third of the cost of a whole game.
 */
const productionAt = (
  mode: ManaAbility['modes'][number],
  slot: number,
): ManaAbility['modes'][number][number] | undefined => {
  let seen = 0;
  for (const production of mode) {
    seen += production.amount;
    if (slot < seen) return production;
  }
  return undefined;
};

/**
 * Abilities that tap the same permanent, merged into one offering all their modes. A
 * permanent's abilities come together, as `manaAbilitiesOf` lists them, so only the last
 * tap ability seen can share a source; nothing is copied unless two do.
 */
const oneTapEach = (abilities: readonly ManaAbility[]): readonly ManaAbility[] => {
  let merged: ManaAbility[] | null = null;
  let lastTap = -1;
  for (const [index, ability] of abilities.entries()) {
    const prior = lastTap < 0 ? undefined : (merged ?? abilities)[lastTap];
    if (ability.requiresTap && prior !== undefined && prior.source === ability.source) {
      merged ??= abilities.slice(0, index);
      merged[lastTap] = { ...prior, modes: [...prior.modes, ...ability.modes] };
      continue;
    }
    if (merged !== null) merged.push(ability);
    if (ability.requiresTap) lastTap = merged === null ? index : merged.length - 1;
  }
  return merged ?? abilities;
};
