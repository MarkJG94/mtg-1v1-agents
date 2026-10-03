import type { ObjectId, PlayerId } from '@mtg/shared';
import type { EventEmitter } from '../events/emitter.js';
import type { GameState } from '../state/game-state.js';
import { isGameOver } from '../state/game-state.js';
import { updateObject, updatePlayer } from '../state/update.js';
import { addMana, type ManaType } from './pool.js';

/**
 * Mana abilities (CR 605).
 *
 * A mana ability doesn't use the stack and can't be responded to (CR 605.3b): it resolves
 * the instant it is activated, which is why this adds to the pool directly rather than
 * going anywhere near the stack machinery arriving in 1.4.
 *
 * Where these abilities come from is a separate question. A land's "{T}: Add {G}" is part
 * of its card script, so the real ones appear when card definitions land in roadmap 2.1;
 * until then a caller builds them directly, which is what the tests do.
 */

export interface ManaProduction {
  readonly type: ManaType;
  readonly amount: number;
  /** Produced by a snow permanent, so the mana can pay {S}. */
  readonly snow?: boolean;
  /** A "spend this mana only on ..." rider (CR 106.6). */
  readonly restriction?: string;
}

export interface ManaAbility {
  readonly source: ObjectId;
  /** Nearly all mana abilities cost {T}; Dark Ritual-style ones do not. */
  readonly requiresTap: boolean;
  /**
   * The alternatives this ability offers, each a bundle of mana produced together. A
   * basic Forest has one (`[{G}]`); a dual land has two; Sol Ring's has one of two mana.
   */
  readonly modes: readonly (readonly ManaProduction[])[];
}

export class IllegalManaAbilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalManaAbilityError';
  }
}

export const canActivateManaAbility = (
  state: GameState,
  player: PlayerId,
  ability: ManaAbility,
): boolean => {
  if (isGameOver(state)) return false;
  const source = state.objects.get(ability.source);
  if (!source) return false;
  if (source.zone !== 'battlefield' || source.controller !== player) return false;
  return !(ability.requiresTap && source.tapped);
};

/**
 * Activate a mana ability, adding its mana to the player's pool immediately.
 * `mode` picks between the alternatives a dual land offers.
 */
export const activateManaAbility = (
  state: GameState,
  emitter: EventEmitter,
  player: PlayerId,
  ability: ManaAbility,
  mode = 0,
): GameState => {
  if (!canActivateManaAbility(state, player, ability)) {
    throw new IllegalManaAbilityError(
      `${player} cannot activate the mana ability of object ${ability.source}`,
    );
  }

  const produced = ability.modes[mode];
  if (!produced) {
    throw new IllegalManaAbilityError(
      `mana ability of object ${ability.source} has no mode ${mode}`,
    );
  }

  let next = state;
  if (ability.requiresTap) {
    next = updateObject(next, ability.source, { tapped: true });
    emitter.emit(next, { type: 'tap', object: ability.source });
  }

  let pool = next.players[player].manaPool;
  for (const production of produced) {
    pool = addMana(pool, production.type, production.amount, {
      snow: production.snow ?? false,
      ...(production.restriction === undefined ? {} : { restriction: production.restriction }),
    });
  }
  next = updatePlayer(next, player, { manaPool: pool });

  emitter.emit(next, {
    type: 'activate',
    player,
    source: ability.source,
    abilityIndex: mode,
    targets: [],
  });
  return next;
};

/** A basic land's ability: tap for one mana of its colour. */
export const basicLandAbility = (source: ObjectId, type: ManaType, snow = false): ManaAbility => ({
  source,
  requiresTap: true,
  modes: [[{ type, amount: 1, snow }]],
});
