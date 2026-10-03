import { type ObjectId, type PlayerId, playerZone } from '@mtg/shared';
import type { CardInfo, CardInfoSource } from '../legal-actions.js';
import type { ManaAbility } from '../mana/ability.js';
import type { GameState } from '../state/game-state.js';
import { objectsIn } from '../state/update.js';
import { type CardDefinition, hasType, isSorcerySpeed, spellAbilityOf } from './definition.js';
import { definitionFor } from './evaluate.js';

/**
 * What the engine knows about a card, answered from the game's own definition table.
 *
 * Before card definitions existed, `legalActions` read this through an interface a caller
 * supplied (roadmap 1.5). This is that interface implemented for real: a card the game has
 * a script for behaves; one it does not is simply unplayable, which is the same answer
 * docs/03 gives for an unsupported card.
 */

/**
 * What `legalActions` asks about a card, derived once per definition.
 *
 * Nothing here depends on the game: a card's types, its cost, its colours and the target
 * specs of its spell ability are all printed on it. `legalActions` asks this about every
 * card in hand on every priority grant — six hundred grants a game — and it used to read
 * the types, walk the abilities for the spell and build a fresh object each time, then
 * throw the object away. Held weakly and keyed on the definition, so the answer outlives
 * the call without outliving the card.
 *
 * The identity matters as much as the cost: `legalActions` keys its payability and
 * targeting caches on `manaCost` and `targets` by reference, so that four copies of one
 * card in hand ask each question once. Those come off the definition either way — this
 * makes the object around them stable too.
 */
const infos = new WeakMap<CardDefinition, CardInfo>();

const infoFrom = (definition: CardDefinition): CardInfo => {
  const known = infos.get(definition);
  if (known !== undefined) return known;

  const info: CardInfo = {
    isLand: hasType(definition, 'land'),
    manaCost: definition.manaCost,
    sorcerySpeed: isSorcerySpeed(definition),
    colours: definition.colours,
    targets: spellAbilityOf(definition)?.targets ?? [],
  };
  infos.set(definition, info);
  return info;
};

/** Every mana ability of the permanents a player controls (CR 605). */
export const manaAbilitiesOf = (state: GameState, player: PlayerId): readonly ManaAbility[] =>
  objectsIn(state, 'battlefield').flatMap((object) => {
    const permanent = state.objects.get(object);
    if (permanent === undefined || permanent.controller !== player) return [];
    const definition = state.definitions.get(permanent.definitionId);
    if (definition === undefined) return [];

    return definition.abilities.flatMap((ability) =>
      ability.kind === 'mana'
        ? [{ source: object, requiresTap: ability.requiresTap ?? true, modes: ability.modes }]
        : [],
    );
  });

/** The `CardInfoSource` `legalActions` wants, over the definitions in this game. */
export const cardsInPlay: CardInfoSource = {
  infoFor: (state, id) => {
    const definition = definitionFor(state, id);
    return definition === undefined ? null : infoFrom(definition);
  },
  manaAbilitiesFor: (state, player) => manaAbilitiesOf(state, player),
};

/** Cards in a player's hand that the game has a script for, in hand order. */
export const playableCards = (state: GameState, player: PlayerId): readonly ObjectId[] =>
  objectsIn(state, playerZone(player, 'hand')).filter(
    (object) => definitionFor(state, object) !== undefined,
  );
