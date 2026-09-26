import type { CardProjection, Resolution, ScriptResolver } from '@mtg/cards';
import { type CardDefinition, createRng, type Rng } from '@mtg/engine';
import {
  colours as allColours,
  asOracleId,
  type BanList,
  banLimit,
  type Colour,
  type DeckSlot,
  noBans,
  type OracleId,
  type RunSettings,
  validateSeedDeckColours,
} from '@mtg/shared';
import type { Deck } from './deck.js';

/**
 * The seed deck (docs/05 "Seed deck generation", decision D17; roadmap 5.3): a
 * seventy-five rolled at random from the whole card pool, constrained only enough that it
 * can play — one to three colours, about twenty-four lands, at most four of a name, every
 * spell castable in the colours chosen, and not too many expensive ones. Everything else
 * is dice, and the evolution loop's job is to make something of it.
 *
 * - **Colours**: the run's own if it names them, otherwise one, two or three, weighted
 *   30/50/20, drawn from the five.
 * - **Lands**: `seedDeckLands` give or take `seedDeckLandsJitter`. Up to 40% of them are
 *   nonbasic lands whose colour identity fits the deck; the rest are basics split evenly
 *   across the colours, any remainder going to colours picked at random. A snow-covered
 *   basic is neither: it is not a nonbasic land, and not what the deck's basics are.
 * - **Spells**: names drawn uniformly from the nonland cards the deck may hold, each drawn
 *   name taking one to four copies — weighted toward four for cheap cards — until the main
 *   deck has sixty. No more than eight of them may cost five or more. The sideboard's
 *   fifteen are drawn the same way from the names the main deck did not take.
 * - **Every card drawn goes through the `ScriptResolver`**; one it cannot support is
 *   re-rolled, which the resolver logs as a request and the result lists.
 *
 * A card the deck may hold is one that is not digital-only, is legal (or restricted) in
 * the run's base format, is not banned by the run, and whose colour identity is within
 * the deck's colours. The copies allowed are four (CR 100.2a), one if the base format or
 * the run restricts it, and any number of a basic land. A card whose own text lets a deck
 * hold any number of it is held to four like any other.
 *
 * The same pool, settings, ban list and seed make the same deck, whatever order the pool
 * arrives in: the pool is put in oracle-id order first, and each stage draws from its own
 * fork of the seed, so a change to how lands are drawn does not reshuffle the spells.
 */

export interface SeedDeckOptions {
  /** Every card that could be drawn: Scryfall's, or a fixture's. */
  readonly pool: readonly CardProjection[];
  readonly resolver: Pick<ScriptResolver, 'resolve'>;
  readonly seed: string;
  readonly settings: Pick<
    RunSettings,
    'seedDeckColours' | 'seedDeckLands' | 'seedDeckLandsJitter' | 'legalityFilter'
  >;
  /** The run's ban list, which a seed deck respects like any other (docs/05). */
  readonly banList?: BanList;
  /** Tags the resolver's unsupported-request log with the run it came from. */
  readonly runId?: string;
}

/** A card drawn and put back because the engine cannot play it. */
export interface Reroll {
  readonly oracleId: OracleId;
  readonly name: string;
  readonly status: Resolution['status'];
  readonly section: Section;
}

export interface SeedDeck {
  readonly deck: Deck;
  /** In WUBRG order. */
  readonly colours: readonly Colour[];
  readonly lands: number;
  readonly nonbasicLands: number;
  /** Every card in the seventy-five, for handing to a game. */
  readonly definitions: ReadonlyMap<OracleId, CardDefinition>;
  /** In the order they were drawn. */
  readonly rerolled: readonly Reroll[];
}

type Section = 'lands' | 'main' | 'side';

export class SeedDeckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedDeckError';
  }
}

export const MAIN_DECK = 60;
export const SIDEBOARD = 15;
/** CR 100.2a. */
export const MAX_COPIES = 4;
/** One colour, two or three, weighted 30/50/20 (docs/05). */
const COLOUR_COUNT_WEIGHTS = [30, 50, 20] as const;
/** The share of the lands that may be nonbasic. */
const NONBASIC_SHARE = 0.4;
/** docs/05's curve constraint: no more than eight cards costing five or more. */
export const MOST_EXPENSIVE = 8;
export const EXPENSIVE_FROM = 5;

/**
 * Weights for one, two, three and four copies. Cheap cards lean toward four, the way a
 * real deck plays its one-drops as a set; expensive ones are as likely to be one-ofs.
 */
const copyWeights = (manaValue: number): readonly number[] =>
  manaValue <= 2 ? [1, 1, 2, 4] : manaValue <= 4 ? [1, 1, 1, 2] : [1, 1, 1, 1];

/** The front face's type line: an MDFC with a land on its back is not a land to draw. */
const frontType = (card: CardProjection): string => card.typeLine.split(' // ')[0] ?? '';
const supertypesAndTypes = (card: CardProjection): string[] =>
  (frontType(card).split('—')[0] ?? '').trim().split(/\s+/);
export const isLandCard = (card: CardProjection): boolean =>
  supertypesAndTypes(card).includes('Land');
/** A basic land, snow-covered or not (CR 205.4c): any number may be played (CR 100.2a). */
export const isBasicLand = (card: CardProjection): boolean => {
  const words = supertypesAndTypes(card);
  return words.includes('Basic') && words.includes('Land');
};
/**
 * The basics a seed deck is given: a snow-covered basic is a basic too, but carries a
 * property of its own that some cards care about, so it is not what "a Forest" means here.
 */
export const isPlainBasic = (card: CardProjection): boolean =>
  isBasicLand(card) && !supertypesAndTypes(card).includes('Snow');

export const generateSeedDeck = (options: SeedDeckOptions): SeedDeck => {
  const { settings } = options;
  const banList = options.banList ?? noBans;
  const rng = createRng(options.seed);
  const colourRng = rng.fork('colours');
  const landRng = rng.fork('lands');
  const mainRng = rng.fork('main');
  const sideRng = rng.fork('side');

  const chosen = chooseColours(settings.seedDeckColours, colourRng);
  const pool = canonical(options.pool);
  const fits = (card: CardProjection) =>
    !card.digital &&
    card.colorIdentity.every((colour) => (chosen as readonly string[]).includes(colour)) &&
    limitOf(card, settings.legalityFilter, banList) > 0;
  const eligible = pool.filter(fits);
  const byId = new Map(eligible.map((card) => [asOracleId(card.oracleId), card]));

  const counts = new Map<OracleId, number>();
  const definitions = new Map<OracleId, CardDefinition>();
  const rerolled: Reroll[] = [];
  const rejected = new Set<OracleId>();

  const resolve = (card: CardProjection, section: Section): CardDefinition | null => {
    const oracleId = asOracleId(card.oracleId);
    const known = definitions.get(oracleId);
    if (known !== undefined) return known;
    const resolved = options.resolver.resolve(card, {
      ...(options.runId === undefined ? {} : { runId: options.runId }),
      context: `seed deck (${section})`,
    });
    if (resolved.definition === null) {
      rejected.add(oracleId);
      rerolled.push({ oracleId, name: card.name, status: resolved.status, section });
      return null;
    }
    definitions.set(oracleId, resolved.definition);
    return resolved.definition;
  };

  const limit = (card: CardProjection) =>
    limitOf(card, settings.legalityFilter, banList) - (counts.get(asOracleId(card.oracleId)) ?? 0);

  /**
   * Names drawn uniformly without replacement, each taking its copies, until `room` is
   * filled or the candidates run out. Returns how many cards it placed.
   */
  const draw = (
    candidates: readonly CardProjection[],
    room: number,
    section: Section,
    random: Rng,
    into: Map<OracleId, number>,
    cap: (card: CardProjection) => number = () => Number.POSITIVE_INFINITY,
  ): number => {
    const remaining = candidates.filter((card) => !rejected.has(asOracleId(card.oracleId)));
    let placed = 0;
    while (placed < room && remaining.length > 0) {
      const [card] = remaining.splice(random.nextInt(remaining.length), 1);
      if (card === undefined) break;
      const most = Math.min(limit(card), room - placed, cap(card));
      if (most <= 0 || resolve(card, section) === null) continue;
      const count = Math.min(most, random.pickWeightedIndex(copyWeights(card.manaValue)) + 1);
      add(card, count, into);
      placed += count;
    }
    return placed;
  };

  /**
   * More copies of names already drawn, when there are no new names left to draw: into
   * `slots`, of any name in `from`, as far as the 75's limits allow.
   */
  const topUp = (
    slots: Map<OracleId, number>,
    from: readonly OracleId[],
    room: number,
    random: Rng,
    cap: (card: CardProjection) => number = () => Number.POSITIVE_INFINITY,
  ): number => {
    let placed = 0;
    for (const oracleId of random.shuffled(from)) {
      if (placed >= room) break;
      const card = byId.get(oracleId);
      if (card === undefined) continue;
      const more = Math.min(limit(card), room - placed, cap(card));
      if (more <= 0) continue;
      add(card, more, slots);
      placed += more;
    }
    return placed;
  };

  const add = (card: CardProjection, count: number, into: Map<OracleId, number>) => {
    const oracleId = asOracleId(card.oracleId);
    into.set(oracleId, (into.get(oracleId) ?? 0) + count);
    counts.set(oracleId, (counts.get(oracleId) ?? 0) + count);
  };

  // --- Lands ---
  const landSlots = new Map<OracleId, number>();
  const target = settings.seedDeckLands;
  const jitter = settings.seedDeckLandsJitter;
  const lands = landRng.nextIntBetween(
    Math.max(0, target - jitter),
    Math.min(MAIN_DECK, target + jitter),
  );
  const nonbasicTarget = landRng.nextIntBetween(0, Math.floor(lands * NONBASIC_SHARE));
  const nonbasicLands = draw(
    eligible.filter((card) => isLandCard(card) && !isBasicLand(card)),
    nonbasicTarget,
    'lands',
    landRng,
    landSlots,
  );
  const basics = lands - nonbasicLands;
  const each = Math.floor(basics / chosen.length);
  const extra = new Set(landRng.shuffled(chosen).slice(0, basics % chosen.length));
  for (const colour of chosen) {
    const count = each + (extra.has(colour) ? 1 : 0);
    if (count === 0) continue;
    const basic = basicFor(colour, eligible);
    if (basic === undefined || resolve(basic, 'lands') === null) {
      throw new SeedDeckError(`no playable basic land for ${colour} in the pool`);
    }
    if (limit(basic) < count) {
      throw new SeedDeckError(`${basic.name} is limited by the ban list or the base format`);
    }
    add(basic, count, landSlots);
  }

  // --- The main deck's spells ---
  const spells = eligible.filter((card) => !isLandCard(card));
  const mainSlots = new Map<OracleId, number>();
  // Read live, so each name drawn sees every expensive copy placed before it.
  const curve = (card: CardProjection) => {
    if (card.manaValue < EXPENSIVE_FROM) return Number.POSITIVE_INFINITY;
    let expensive = 0;
    for (const [oracleId, count] of mainSlots) {
      if ((byId.get(oracleId)?.manaValue ?? 0) >= EXPENSIVE_FROM) expensive += count;
    }
    return MOST_EXPENSIVE - expensive;
  };
  const room = MAIN_DECK - lands;
  let spellsPlaced = draw(spells, room, 'main', mainRng, mainSlots, curve);
  if (spellsPlaced < room)
    spellsPlaced += topUp(mainSlots, [...mainSlots.keys()], room - spellsPlaced, mainRng, curve);
  if (spellsPlaced < room) {
    throw new SeedDeckError(
      `the pool holds too few playable spells in ${chosen.join('')} for a main deck: ${spellsPlaced} of ${room}`,
    );
  }

  // --- The sideboard ---
  const sideSlots = new Map<OracleId, number>();
  let sidePlaced = draw(
    spells.filter((card) => !mainSlots.has(asOracleId(card.oracleId))),
    SIDEBOARD,
    'side',
    sideRng,
    sideSlots,
  );
  // A thin pool can leave the side short of new names; more copies of a main-deck card
  // are a real sideboard too, as long as the 75 still holds four at most.
  if (sidePlaced < SIDEBOARD) {
    const drawn = [...sideSlots.keys(), ...mainSlots.keys()];
    sidePlaced += topUp(sideSlots, drawn, SIDEBOARD - sidePlaced, sideRng);
  }
  if (sidePlaced < SIDEBOARD) {
    throw new SeedDeckError(
      `the pool holds too few playable spells in ${chosen.join('')} for a sideboard: ${sidePlaced} of ${SIDEBOARD}`,
    );
  }

  return {
    deck: {
      main: slotsOf(new Map([...landSlots, ...mainSlots])),
      side: slotsOf(sideSlots),
    },
    colours: chosen,
    lands,
    nonbasicLands,
    definitions,
    rerolled,
  };
};

const chooseColours = (named: readonly Colour[], rng: Rng): readonly Colour[] => {
  // Drawn even when the run names its colours, so the draws after it do not depend on it.
  const count = rng.pickWeightedIndex(COLOUR_COUNT_WEIGHTS) + 1;
  const drawn = rng.shuffled(allColours).slice(0, count);
  if (named.length === 0) return wubrg(drawn);
  const problems = validateSeedDeckColours({ seedDeckColours: [...named] });
  if (problems.length > 0) throw new SeedDeckError(problems.join('; '));
  return wubrg(named);
};

const wubrg = (chosen: readonly Colour[]): readonly Colour[] =>
  allColours.filter((colour) => chosen.includes(colour));

/** One card per oracle id, in oracle-id order, so the pool's order changes nothing. */
const canonical = (pool: readonly CardProjection[]): CardProjection[] => {
  const byId = new Map<string, CardProjection>();
  for (const card of pool) if (!byId.has(card.oracleId)) byId.set(card.oracleId, card);
  return [...byId.values()].sort((a, b) =>
    a.oracleId < b.oracleId ? -1 : a.oracleId > b.oracleId ? 1 : 0,
  );
};

/** Copies of a card a seventy-five may hold, before counting any already in it. */
const limitOf = (
  card: CardProjection,
  format: RunSettings['legalityFilter'],
  banList: BanList,
): number => {
  const legality = card.legalities[format];
  if (legality !== 'legal' && legality !== 'restricted') return 0;
  const base =
    legality === 'restricted' ? 1 : isBasicLand(card) ? Number.POSITIVE_INFINITY : MAX_COPIES;
  return Math.min(base, banLimit(banList, asOracleId(card.oracleId)));
};

/** The basic land that makes this colour: the one plain basic whose identity is it alone. */
const basicFor = (colour: Colour, pool: readonly CardProjection[]): CardProjection | undefined =>
  pool.find(
    (card) =>
      isPlainBasic(card) && card.colorIdentity.length === 1 && card.colorIdentity[0] === colour,
  );

const slotsOf = (slots: ReadonlyMap<OracleId, number>): DeckSlot[] =>
  [...slots]
    .map(([oracleId, count]) => ({ oracleId, count }))
    .sort((a, b) => (a.oracleId < b.oracleId ? -1 : a.oracleId > b.oracleId ? 1 : 0));
