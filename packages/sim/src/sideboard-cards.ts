import type { DeckCard, SideboardCard } from '@mtg/agents';
import { cardsDrawn, cardTags } from '@mtg/cards';
import { type CardDefinition, costColours, isColouredMana, manaValue } from '@mtg/engine';
import type { Colour, OracleId } from '@mtg/shared';

/**
 * What the sideboarding agent is told about a card (roadmap 4.6): its tags, read off the
 * script by `@mtg/cards`, whether it is a land, the colours it costs and the colours it
 * makes. This package is the one that sees both the card definitions and the agents, so
 * it is where the one becomes what the other reads — the agents package never sees a
 * definition (ADR 0009).
 */
export const sideboardCardFor = (definition: CardDefinition): SideboardCard => {
  const produces = new Set<Colour>();
  for (const ability of definition.abilities) {
    if (ability.kind !== 'mana') continue;
    for (const mode of ability.modes) {
      for (const made of mode) if (isColouredMana(made.type)) produces.add(made.type);
    }
  }
  return {
    tags: cardTags(definition),
    land: definition.types.includes('land'),
    costColours: [...costColours(definition.manaCost)],
    produces: [...produces],
  };
};

/** The same, for every card in a pool. */
export const sideboardCardsFor = (
  definitions: Iterable<CardDefinition>,
): ReadonlyMap<OracleId, SideboardCard> =>
  new Map(
    [...definitions].map((definition) => [definition.oracleId, sideboardCardFor(definition)]),
  );

/**
 * What the deck agent is told about a card it could play (roadmap 5.4): what the
 * sideboarding agent is told, and its name, mana value, whether it is a basic land, and
 * how many cards it draws — all read off the definition, for the same reason as above.
 */
export const deckCardFor = (definition: CardDefinition): DeckCard => ({
  ...sideboardCardFor(definition),
  name: definition.name,
  basic: definition.types.includes('land') && (definition.supertypes ?? []).includes('basic'),
  manaValue: manaValue(definition.manaCost),
  cardsDrawn: cardsDrawn(definition),
});

/** The same, for every card in a pool. */
export const deckCardsFor = (
  definitions: Iterable<CardDefinition>,
): ReadonlyMap<OracleId, DeckCard> =>
  new Map([...definitions].map((definition) => [definition.oracleId, deckCardFor(definition)]));
