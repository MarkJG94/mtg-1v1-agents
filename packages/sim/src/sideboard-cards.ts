import type { SideboardCard } from '@mtg/agents';
import { cardTags } from '@mtg/cards';
import { type CardDefinition, costColours, isColouredMana } from '@mtg/engine';
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
