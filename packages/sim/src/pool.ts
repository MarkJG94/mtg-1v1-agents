import type { CardPoolQuery, DeckCard, PoolCard, PoolCriteria } from '@mtg/agents';
import type { CardProjection, ScriptResolver } from '@mtg/cards';
import type { CardDefinition } from '@mtg/engine';
import {
  asOracleId,
  banLimit,
  type Colour,
  isColour,
  type OracleId,
  type RunSettings,
} from '@mtg/shared';
import { isBasicLand, isLandCard } from './seed-deck.js';
import { deckCardFor } from './sideboard-cards.js';

/**
 * The card pool the deck agent searches (docs/05 `CardPoolQuery`; roadmap 5.4): Scryfall's
 * projections, filtered to what the run's base format allows, and scripted on demand by
 * the `ScriptResolver`.
 *
 * A card is in the pool if it is not digital-only and is legal or restricted in the base
 * format — the same rule the seed deck generator draws by. A search narrows that to the
 * criteria the agent gives: land or not, colour identity within the colours named, a
 * mana-value band, and not banned by the run. How many copies the 75 already holds is the
 * agent's business; each card says how many the format allows.
 *
 * Scripting is asynchronous in the interface so that roadmap 5.7 can put the scripting
 * worker behind it. Here the resolver runs in-process. Every card scripted keeps its
 * definition, which the games that follow — a trial, the next cycle — need to play it.
 */
export class ScryfallPool implements CardPoolQuery {
  private readonly cards: readonly PoolCard[];
  private readonly projections: ReadonlyMap<OracleId, CardProjection>;
  private readonly scripted = new Map<OracleId, CardDefinition | null>();

  constructor(
    pool: readonly CardProjection[],
    private readonly resolver: Pick<ScriptResolver, 'resolve'>,
    format: RunSettings['legalityFilter'],
    private readonly runId?: string,
  ) {
    const projections = new Map<OracleId, CardProjection>();
    const cards: PoolCard[] = [];
    for (const card of pool) {
      const oracleId = asOracleId(card.oracleId);
      if (projections.has(oracleId) || card.digital) continue;
      const legality = card.legalities[format];
      if (legality !== 'legal' && legality !== 'restricted') continue;
      projections.set(oracleId, card);
      cards.push(poolCardFor(card, legality === 'restricted'));
    }
    this.projections = projections;
    this.cards = cards.sort((a, b) => (a.oracleId < b.oracleId ? -1 : 1));
  }

  search(criteria: PoolCriteria): readonly PoolCard[] {
    const allowed = new Set<string>(criteria.colours);
    const band = criteria.manaValue;
    return this.cards.filter(
      (card) =>
        card.land === criteria.land &&
        card.colourIdentity.every((colour) => allowed.has(colour)) &&
        (band === undefined || (card.manaValue >= band.min && card.manaValue <= band.max)) &&
        !criteria.exclude.has(card.oracleId) &&
        banLimit(criteria.banList, card.oracleId) > 0,
    );
  }

  async script(oracleId: OracleId): Promise<DeckCard | null> {
    const definition = this.definitionOf(oracleId);
    return definition === null ? null : deckCardFor(definition);
  }

  /** A card's definition, scripting it if nobody has asked before; `null` if unplayable. */
  definitionOf(oracleId: OracleId): CardDefinition | null {
    const known = this.scripted.get(oracleId);
    if (known !== undefined) return known;
    const projection = this.projections.get(oracleId);
    if (projection === undefined) return null;
    const definition = this.resolver.resolve(projection, {
      ...(this.runId === undefined ? {} : { runId: this.runId }),
      context: 'deck change',
    }).definition;
    this.scripted.set(oracleId, definition);
    return definition;
  }

  /** Every card scripted so far that the engine can play. */
  definitions(): ReadonlyMap<OracleId, CardDefinition> {
    const found = new Map<OracleId, CardDefinition>();
    for (const [oracleId, definition] of this.scripted) {
      if (definition !== null) found.set(oracleId, definition);
    }
    return found;
  }
}

/** A projection's printed facts, as the agent's static quality model reads them. */
export const poolCardFor = (card: CardProjection, restricted = false): PoolCard => {
  const basic = isBasicLand(card);
  return {
    oracleId: asOracleId(card.oracleId),
    name: card.name,
    manaValue: card.manaValue,
    colourIdentity: card.colorIdentity.filter(isColour) as Colour[],
    land: isLandCard(card),
    basic,
    power: printedNumber(card.power),
    toughness: printedNumber(card.toughness),
    keywords: card.keywords,
    // CR 100.2a: four of a card other than a basic land; the format may restrict it to one.
    copies: restricted ? 1 : basic ? Number.POSITIVE_INFINITY : 4,
  };
};

/** "2" is two; "*" and "1+*" are not a number a model can price. */
const printedNumber = (value: string | null): number | null => {
  if (value === null || !/^-?\d+$/.test(value)) return null;
  return Number(value);
};
