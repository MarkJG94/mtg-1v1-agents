import type { Rng } from '@mtg/engine/view';
import {
  type AgentCounts,
  colours as allColours,
  applyDeckChange,
  type BanList,
  type BanStatus,
  banLimit,
  banViolations,
  type CandidateEvidence,
  type CardKind,
  type CardStats,
  type Colour,
  cardStats,
  type Deck75,
  type DeckChange,
  type DeckChangeEvidence,
  type DeckSlot,
  type DeckZone,
  type Diagnosis,
  deckStats,
  emptyCardCounts,
  type OracleId,
  type SlotEvidence,
  type TrialEvidence,
} from '@mtg/shared';
import type { SideboardCard } from './sideboard.js';

/**
 * The deck agent (docs/05 "Choosing the change"; roadmap 5.4): once a cycle, the loser's
 * deck changes by one slot, and this decides which and what for.
 *
 * `StatisticalDeckAgent` works in four steps, as docs/05 lays them out.
 *
 * 1. **Diagnose.** Mana first: a deck that is screwed too often trades its worst spell for
 *    a land, one that floods trades a land for a spell, and one that holds spells for want
 *    of a colour trades a land for one that makes it — or, if the pool has none, cuts the
 *    worst card that needs that colour. Otherwise the worst slot goes: each main-deck card
 *    scored by its shrunk Δ, less a charge for the games it sat dead in hand and the share
 *    of draws it was never cast. A sideboard card is scored by its record when boarded in;
 *    one never boarded in scores `idleSideScore`, neutral, so it goes once no main-deck
 *    card is below average. A sideboard card whose record beats the worst main-deck
 *    card's by `swapMargin` changes places with it instead.
 * 2. **Search the pool.** `CardPoolQuery` returns what may legally be played in the deck's
 *    colours — within a mana value of the card cut, unless the change is fixing the mana —
 *    and the agent drops what the 75 cannot hold more copies of. Each is ranked by a
 *    **static quality model** read off its printed facts (body per mana, keywords) plus its
 *    record in this deck from earlier cycles, with Gumbel noise at `temperature` so a
 *    lower-ranked card is sometimes tried. The top `shortlistSize` are scripted on demand;
 *    those the engine cannot play are dropped, and the rest are scored again with what
 *    their scripts say — what they answer, how many cards they draw, and how much of the
 *    opponent's observed deck they answer — and the best `trialTopK` kept.
 * 3. **Trial**, if there is a trial runner and `trialTopK` is not zero: each finalist's deck
 *    plays the opponent's, and the best win rate wins, ties going to the higher score.
 * 4. **Emit** the change, with a reason in words and the evidence behind it.
 *
 * Everything here is data: the agent never sees a card definition or a game (ADR 0009),
 * only what `@mtg/sim` tells it about each card, the counts the aggregator kept, and the
 * two ports. The pool's scripting is asynchronous so that roadmap 5.7 can put the
 * scripting worker behind it.
 */

/** What the agent knows about a card the engine can play. */
export interface DeckCard extends SideboardCard {
  readonly name: string;
  /** A basic land (CR 205.4c): any number may be played, and a slot of them is cut in fours. */
  readonly basic: boolean;
  readonly manaValue: number;
  /** Cards its abilities draw for its controller, read off its script. */
  readonly cardsDrawn: number;
}

/** What the pool knows about a card before it is scripted: its printed facts. */
export interface PoolCard {
  readonly oracleId: OracleId;
  readonly name: string;
  readonly manaValue: number;
  readonly colourIdentity: readonly Colour[];
  readonly land: boolean;
  readonly basic: boolean;
  /** Printed power and toughness, or `null` when it has none or it is not a number. */
  readonly power: number | null;
  readonly toughness: number | null;
  readonly keywords: readonly string[];
  /** Copies the base format allows in a 75: four, one if restricted, any number of a basic. */
  readonly copies: number;
}

export interface PoolCriteria {
  readonly land: boolean;
  /** A card's colour identity must be within these. */
  readonly colours: readonly Colour[];
  /** Inclusive; absent means any mana value. */
  readonly manaValue?: { readonly min: number; readonly max: number };
  readonly exclude: ReadonlySet<OracleId>;
  readonly banList: BanList;
}

/**
 * The card pool (docs/05 `CardPoolQuery`): Scryfall, filtered to what the run's base
 * format allows, and a way to script a card on demand.
 */
export interface CardPoolQuery {
  search(criteria: PoolCriteria): readonly PoolCard[];
  /** What the engine can play of the card, or `null` if it cannot play it. */
  script(oracleId: OracleId): Promise<DeckCard | null>;
}

export interface TrialResult {
  readonly matches: number;
  /** Against the opponent's current deck; a drawn match counts half. */
  readonly winRate: number;
}

/** Plays a candidate deck against the opponent's current one (docs/05 step 3). */
export type TrialRunner = (deck: Deck75, candidate: OracleId) => Promise<TrialResult>;

/** What this deck has seen of the opponent's (docs/04 "Opponent modelling"). */
export interface OpponentKnowledge {
  /** Cards the opponent showed, counted over the games seen. */
  readonly seen: readonly DeckSlot[];
  /** What each of those cards is. */
  readonly cards: ReadonlyMap<OracleId, SideboardCard>;
}

export interface DeckAgentInput {
  readonly deck: Deck75;
  /** Every card in the 75. */
  readonly cards: ReadonlyMap<OracleId, DeckCard>;
  /** The deck's statistics: earlier cycles rolled up, with this one. */
  readonly counts: AgentCounts;
  readonly opponent: OpponentKnowledge;
  readonly banList: BanList;
  readonly pool: CardPoolQuery;
  readonly rng: Rng;
  readonly trial?: TrialRunner;
  /** The deck's match win rate this cycle, for the reason. */
  readonly cycleWinRate?: number;
}

export interface DeckAgent {
  chooseChange(input: DeckAgentInput): Promise<DeckChange>;
}

export interface DeckAgentSettings {
  /** docs/05 `shortlistSize`: candidates scripted per search. */
  readonly shortlistSize: number;
  /** docs/05 `trialTopK`: finalists given a trial; 0 disables trials. */
  readonly trialTopK: number;
  /** Games a deck-level rate needs before the diagnosis believes it. */
  readonly minGames: number;
  readonly screwRate: number;
  readonly floodRate: number;
  readonly colourScrewRate: number;
  /** Games of prior toward the deck's win rate in Δ (docs/05: n0 = 20). */
  readonly shrinkage: number;
  /** Charged per unit of dead-in-hand rate, on Δ's scale. */
  readonly deadInHandWeight: number;
  /** Charged per unit of the share of draws never cast. */
  readonly uncastWeight: number;
  /**
   * A sideboard card that was never boarded in. Neutral by default: it goes once every
   * main-deck card is at least average, and a main-deck card goes first on a tie, since
   * the main deck plays every game and the sideboard one in three at most.
   */
  readonly idleSideScore: number;
  /** How much better a sideboard card's record must be to swap into the main deck. */
  readonly swapMargin: number;
  /** A replacement's mana value is within this of the card it replaces. */
  readonly manaValueBand: number;
  /** docs/05's "small probability" of a colour the deck's lands could support. */
  readonly offColourChance: number;
  /** Scale of the Gumbel noise on the static ranking. */
  readonly temperature: number;
  /** At most this many basic lands go at once; a slot of basics is half a mana base. */
  readonly basicSlot: number;
}

export const defaultDeckAgentSettings: DeckAgentSettings = {
  shortlistSize: 50,
  trialTopK: 3,
  minGames: 20,
  screwRate: 0.25,
  floodRate: 0.25,
  colourScrewRate: 0.2,
  shrinkage: 20,
  deadInHandWeight: 0.1,
  uncastWeight: 0.05,
  idleSideScore: 0,
  swapMargin: 0.03,
  manaValueBand: 1,
  offColourChance: 0.1,
  temperature: 0.15,
  basicSlot: 4,
};

export class DeckAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeckAgentError';
  }
}

// --- The static quality model ---

/**
 * Evergreen keywords by what they are worth on a creature, in the units of a body that is
 * exactly on rate (1.0). Rules terms, not card names; a keyword not listed is worth a
 * little, since a keyword is almost always an upside.
 */
const keywordValue: Readonly<Record<string, number>> = {
  flying: 0.3,
  'first strike': 0.2,
  'double strike': 0.5,
  deathtouch: 0.3,
  lifelink: 0.2,
  trample: 0.15,
  vigilance: 0.1,
  haste: 0.2,
  hexproof: 0.25,
  indestructible: 0.35,
  menace: 0.2,
  reach: 0.1,
  flash: 0.15,
  ward: 0.15,
  defender: -0.4,
};
const OTHER_KEYWORD = 0.05;
/** What a noncreature spell is worth before its script says what it does. */
const SPELL_BASE = 0.8;

/**
 * docs/05's static quality model, the part read off printed facts: a creature's power and
 * toughness per mana (a 2/2 for two is 1.0), its keywords, and for anything else a flat
 * base its script adds to. Rarity plays no part.
 */
export const staticQuality = (card: PoolCard): number => {
  const keywords = card.keywords.reduce(
    (sum, keyword) => sum + (keywordValue[keyword.toLowerCase()] ?? OTHER_KEYWORD),
    0,
  );
  if (card.power !== null && card.toughness !== null) {
    return (card.power + card.toughness) / (2 * Math.max(1, card.manaValue)) + keywords;
  }
  return SPELL_BASE + keywords;
};

/** Weights of what a card's script adds to its score. */
const PER_ANSWER = 0.1;
const PER_CARD_DRAWN = 0.25;
const MATCHUP_WEIGHT = 0.5;
/** Its own Δ in this deck, from earlier cycles, on the model's scale. */
const RECORD_WEIGHT = 5;
const PER_COLOUR_MADE = 0.5;

// --- The agent ---

export interface Slot {
  readonly oracleId: OracleId;
  readonly zone: DeckZone;
  readonly count: number;
  readonly card: DeckCard;
  readonly stats: CardStats | null;
  readonly score: number;
}

/** What the diagnosis decided: which slot goes, and what kind of card replaces it. */
export interface DeckPlan {
  readonly diagnosis: Diagnosis;
  readonly removed: Slot;
  /** How many copies go: all of a slot, but no more than `basicSlot` basic lands. */
  readonly count: number;
  readonly search: SearchSpec | null;
  readonly swapIn: Slot | null;
  readonly starved: Colour | null;
  /** For legalisation: what the list says of the card cut. */
  readonly ban: BanStatus | null;
  /** Tried if the search finds nothing the engine can play. */
  readonly otherwise: DeckPlan | null;
}

interface SearchSpec {
  readonly land: boolean;
  readonly colours: readonly Colour[];
  readonly manaValue?: { readonly min: number; readonly max: number };
  /** A scripted candidate must pass this to be kept. */
  readonly accept?: (card: DeckCard) => boolean;
  /** A wider search to try if this one finds nothing playable. */
  readonly fallback?: SearchSpec;
}

type Plan = DeckPlan;

interface Shortlist {
  readonly kept: Candidate[];
  readonly evidence: () => CandidateEvidence[];
}

interface Candidate {
  readonly pool: PoolCard;
  readonly staticScore: number;
  readonly rank: number;
  card: DeckCard | null;
  scripted: boolean;
  score: number | null;
  trial: TrialEvidence | null;
}

export class StatisticalDeckAgent implements DeckAgent {
  readonly settings: DeckAgentSettings;

  constructor(settings: Partial<DeckAgentSettings> = {}) {
    this.settings = { ...defaultDeckAgentSettings, ...settings };
  }

  async chooseChange(input: DeckAgentInput): Promise<DeckChange> {
    const plan = diagnose(input, this.settings);
    const deck = deckStats(input.counts.deck);
    const deckEvidence: DeckChangeEvidence['deck'] = {
      games: deck.games,
      winRate: deck.winRate,
      screwRate: deck.screwRate,
      floodRate: deck.floodRate,
      colourScrewRate: deck.colourScrewRate,
    };

    if (plan.swapIn !== null) {
      const change = {
        shape: 'swap' as const,
        remove: { oracleId: plan.removed.oracleId, zone: 'main' as const, count: plan.count },
        add: { oracleId: plan.swapIn.oracleId, zone: 'main' as const, count: plan.count },
      };
      return {
        ...change,
        reason: swapReason(plan.removed, plan.swapIn),
        evidence: {
          diagnosis: plan.diagnosis,
          deck: deckEvidence,
          removed: slotEvidence(plan.removed),
          starvedColour: null,
          candidates: [],
        },
      };
    }

    return this.replace(input, plan, deckEvidence, deck, true);
  }

  /**
   * docs/05 "Legalisation": every change the ban list forces on this deck, in order — for
   * each card it holds too many of, the excess copies out, sideboard copies first, and
   * each hole filled by the replacement search: the same colours, within a mana value of
   * the card cut, as many copies of one card as the hole has. No trial is played; a
   * legalisation happens between two games of a match, and has to be quick. It does not
   * count as the cycle's change.
   */
  async legalise(input: DeckAgentInput): Promise<DeckChange[]> {
    const deck = deckStats(input.counts.deck);
    const deckEvidence: DeckChangeEvidence['deck'] = {
      games: deck.games,
      winRate: deck.winRate,
      screwRate: deck.screwRate,
      floodRate: deck.floodRate,
      colourScrewRate: deck.colourScrewRate,
    };
    const changes: DeckChange[] = [];
    let current = input;
    for (const violation of banViolations(input.deck, input.banList)) {
      let excess = violation.held - violation.allowed;
      for (const zone of ['side', 'main'] as const) {
        const held =
          current.deck[zone].find((slot) => slot.oracleId === violation.oracleId)?.count ?? 0;
        const count = Math.min(held, excess);
        if (count === 0) continue;
        excess -= count;
        const plan = banPlan(
          current,
          this.settings,
          violation.oracleId,
          zone,
          count,
          violation.status,
        );
        const change = await this.replace(current, plan, deckEvidence, deck, false);
        changes.push(change);
        current = { ...current, deck: applyDeckChange(current.deck, change) };
      }
    }
    return changes;
  }

  /** The search for a plan's replacement, its trial if asked for, and the change it makes. */
  private async replace(
    input: DeckAgentInput,
    plan: DeckPlan,
    deckEvidence: DeckChangeEvidence['deck'],
    deck: ReturnType<typeof deckStats>,
    trial: boolean,
  ): Promise<DeckChange> {
    let tried: DeckPlan | null = plan;
    let found: Shortlist | null = null;
    while (tried !== null && found === null) {
      found = tried.search === null ? null : await this.shortlist(input, tried, tried.search);
      if (found === null) tried = tried.otherwise;
    }
    if (tried === null || found === null) {
      throw new DeckAgentError(
        `nothing the engine can play replaces ${plan.removed.card.name} (${plan.diagnosis})`,
      );
    }
    const winner = trial
      ? await this.trial(input, tried, found.kept)
      : (found.kept[0] as Candidate);
    const zone = tried.removed.zone;
    return {
      shape: 'replace',
      remove: { oracleId: tried.removed.oracleId, zone, count: tried.count },
      add: { oracleId: winner.pool.oracleId, zone, count: tried.count },
      reason: replaceReason(tried, winner, deck, input.cycleWinRate),
      evidence: {
        diagnosis: tried.diagnosis,
        deck: deckEvidence,
        removed: slotEvidence(tried.removed),
        starvedColour: tried.starved,
        candidates: found.evidence(),
      },
    };
  }

  /**
   * The search: candidates ranked by the static model with noise, the top `shortlistSize`
   * scripted, and the best `trialTopK` of those the engine can play kept — relaxing the
   * search if it finds nothing playable.
   */
  private async shortlist(
    input: DeckAgentInput,
    plan: Plan,
    first: SearchSpec,
  ): Promise<Shortlist | null> {
    const { settings } = this;
    const in75 = copiesIn75(input.deck);
    let spec: SearchSpec | undefined = first;
    let candidates: Candidate[] = [];
    let kept: Candidate[] = [];

    while (spec !== undefined && kept.length === 0) {
      const found = input.pool
        .search({
          land: spec.land,
          colours: spec.colours,
          ...(spec.manaValue === undefined ? {} : { manaValue: spec.manaValue }),
          exclude: new Set([plan.removed.oracleId]),
          banList: input.banList,
        })
        .filter(
          (card) =>
            Math.min(card.copies, banLimit(input.banList, card.oracleId)) -
              (in75.get(card.oracleId) ?? 0) >=
            plan.count,
        );
      candidates = rankStatic(found, input, settings);
      for (const candidate of candidates.slice(0, settings.shortlistSize)) {
        candidate.scripted = true;
        candidate.card = await input.pool.script(candidate.pool.oracleId);
        if (candidate.card === null) continue;
        if (spec.accept !== undefined && !spec.accept(candidate.card)) continue;
        candidate.score = candidate.rank + scriptedQuality(candidate.card, input);
      }
      kept = candidates
        .filter((candidate) => candidate.score !== null)
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, Math.max(1, settings.trialTopK));
      spec = kept.length === 0 ? spec.fallback : undefined;
    }
    if (kept.length === 0) return null;
    const shown = candidates.slice(0, settings.shortlistSize);
    const evidence = (): CandidateEvidence[] =>
      shown.map((candidate) => ({
        oracleId: candidate.pool.oracleId,
        name: candidate.pool.name,
        staticScore: candidate.staticScore,
        supported: candidate.scripted ? candidate.card !== null : null,
        score: candidate.score,
        trial: candidate.trial,
      }));
    return { kept, evidence };
  }

  /** docs/05 step 3: the finalists' decks against the opponent's, best win rate first. */
  private async trial(input: DeckAgentInput, plan: Plan, kept: Candidate[]): Promise<Candidate> {
    const [best] = kept;
    if (best === undefined) throw new DeckAgentError('no finalist');
    if (input.trial === undefined || this.settings.trialTopK === 0) return best;
    for (const candidate of kept) {
      const deck = replaced(input.deck, plan, candidate.pool.oracleId);
      const result = await input.trial(deck, candidate.pool.oracleId);
      candidate.trial = { matches: result.matches, winRate: result.winRate };
    }
    return [...kept].sort(
      (a, b) =>
        (b.trial?.winRate ?? 0) - (a.trial?.winRate ?? 0) || (b.score ?? 0) - (a.score ?? 0),
    )[0] as Candidate;
  }
}

// --- Diagnosis ---

/** Which slot goes and what kind of card replaces it. */
export const diagnose = (
  input: DeckAgentInput,
  settings: DeckAgentSettings = defaultDeckAgentSettings,
): DeckPlan => {
  const { counts, deck } = input;
  const d = counts.deck;
  const screw = d.screwChances > 0 ? d.screwed / d.screwChances : 0;
  const flood = d.floodChances > 0 ? d.flooded / d.floodChances : 0;
  const colourScrew = d.games > 0 ? d.colourScrewed / d.games : 0;
  const slotOf = slotScorer(input, settings);
  const byScore = (a: Slot, b: Slot) =>
    a.score - b.score ||
    (a.zone === b.zone ? 0 : a.zone === 'main' ? -1 : 1) ||
    (a.oracleId < b.oracleId ? -1 : 1);

  const main = deck.main.map((entry) => slotOf(entry, 'main'));
  const side = deck.side.map((entry) => slotOf(entry, 'side'));
  const spells = main.filter((slot) => !slot.card.land).sort(byScore);
  const lands = main.filter((slot) => slot.card.land).sort(byScore);

  const deckColours = coloursOf(spells.map((slot) => slot.card.costColours));
  const landColours = coloursOf(lands.map((slot) => slot.card.produces));
  const offColour = input.rng.nextBoolean(settings.offColourChance);
  const spellColours = offColour ? union(deckColours, landColours) : deckColours;
  const band = (manaValue: number) => ({
    min: Math.max(0, manaValue - settings.manaValueBand),
    max: manaValue + settings.manaValueBand,
  });
  const countOf = (slot: Slot) =>
    slot.card.basic ? Math.min(slot.count, settings.basicSlot) : slot.count;
  const spellSearch = (removed: Slot, colours = spellColours): SearchSpec => ({
    land: false,
    colours,
    manaValue: band(removed.card.manaValue),
    fallback: { land: false, colours },
  });
  const plan = (
    diagnosis: Diagnosis,
    removed: Slot,
    search: SearchSpec | null,
    extra: Partial<Pick<Plan, 'swapIn' | 'starved' | 'otherwise'>> = {},
  ): Plan => ({
    diagnosis,
    removed,
    count: countOf(removed),
    search,
    swapIn: extra.swapIn ?? null,
    starved: extra.starved ?? null,
    ban: null,
    otherwise: extra.otherwise ?? null,
  });

  const [worstSpell] = spells;
  const enough = (chances: number) => chances >= settings.minGames;

  if (
    worstSpell !== undefined &&
    enough(d.screwChances) &&
    screw >= settings.screwRate &&
    screw > flood
  ) {
    return plan('screw', worstSpell, { land: true, colours: deckColours });
  }

  if (enough(d.floodChances) && flood >= settings.floodRate && flood > screw) {
    const cuttable = lands.filter((slot) => keepsColours(slot, countOf(slot), lands, deckColours));
    const [land] = cuttable;
    if (land !== undefined) return plan('flood', land, { land: false, colours: spellColours });
  }

  if (enough(d.games) && colourScrew >= settings.colourScrewRate) {
    const starved = starvedColour(spells, lands);
    if (starved !== null) {
      // Fix the lands if the pool has a land for it; otherwise cut what needs the colour.
      const surplus = lands
        .filter((slot) => !slot.card.produces.includes(starved))
        .sort((a, b) => surplusOf(b, spells, lands) - surplusOf(a, spells, lands) || byScore(a, b));
      const needy = spells.filter((slot) => slot.card.costColours.includes(starved));
      const without = deckColours.filter((colour) => colour !== starved);
      const [landOut] = surplus;
      const [spellOut] = needy;
      const cutSpell =
        spellOut === undefined
          ? null
          : plan('colourScrew', spellOut, spellSearch(spellOut, without), { starved });
      if (landOut !== undefined) {
        return plan(
          'colourScrew',
          landOut,
          { land: true, colours: deckColours, accept: (card) => card.produces.includes(starved) },
          { starved, otherwise: cutSpell },
        );
      }
      if (cutSpell !== null) return cutSpell;
    }
  }

  const boardedIn = side
    .filter((slot) => slot.stats !== null && !slot.card.land)
    .sort((a, b) => b.score - a.score);
  const candidates = [...spells, ...side].sort(byScore);
  const [worst] = candidates;
  if (worst === undefined) throw new DeckAgentError('the deck has no spell to change');

  if (worst.zone === 'main') {
    const swapIn = boardedIn.find(
      (slot) =>
        slot.count === worst.count &&
        slot.score - worst.score > settings.swapMargin &&
        slot.card.costColours.every((colour) => landColours.includes(colour)),
    );
    if (swapIn !== undefined) return plan('swap', worst, null, { swapIn });
    return plan('weakest', worst, spellSearch(worst));
  }
  return plan(worst.stats === null ? 'idleSideboard' : 'weakest', worst, spellSearch(worst));
};

/** Each slot scored as the diagnosis reads it: shrunk Δ less its charges; lower is worse. */
const slotScorer = (input: DeckAgentInput, settings: DeckAgentSettings) => {
  const d = input.counts.deck;
  const deckWinRate = d.games > 0 ? d.wins / d.games : 0.5;
  return (entry: DeckSlot, zone: DeckZone): Slot => {
    const card = input.cards.get(entry.oracleId);
    if (card === undefined) throw new DeckAgentError(`nothing is known of ${entry.oracleId}`);
    const record = input.counts.cards[entry.oracleId];
    const played = record !== undefined && record.games > 0;
    if (zone === 'side' && !played) {
      return { ...entry, zone, card, stats: null, score: settings.idleSideScore };
    }
    const stats = cardStats(record ?? emptyCardCounts, deckWinRate, settings.shrinkage);
    const score =
      stats.delta -
      settings.deadInHandWeight * (stats.deadInHandRate ?? 0) -
      settings.uncastWeight * (1 - (stats.castRate ?? 1));
    return { ...entry, zone, card, stats, score };
  };
};

/**
 * The replacement for copies the ban list forces out (docs/05 "Legalisation"): a card of
 * the same kind — land for land, spell for spell. A spell is looked for in the removed
 * card's own colours and within a mana value of it first, then anywhere in the deck's
 * colours at that mana value, then at any; a land, among lands that make every colour it
 * made, then any in the deck's colours. The search already keeps banned cards out, and a restricted one out of any
 * hole bigger than one.
 */
const banPlan = (
  input: DeckAgentInput,
  settings: DeckAgentSettings,
  oracleId: OracleId,
  zone: DeckZone,
  count: number,
  ban: BanStatus,
): DeckPlan => {
  const entry = input.deck[zone].find((slot) => slot.oracleId === oracleId);
  if (entry === undefined) throw new DeckAgentError(`the ${zone} holds no ${oracleId}`);
  const removed = slotScorer(input, settings)(entry, zone);
  const { card } = removed;
  const deckColours = coloursOf(
    input.deck.main.flatMap((slot) => {
      const known = input.cards.get(slot.oracleId);
      return known === undefined || known.land ? [] : [known.costColours];
    }),
  );
  const own = card.land ? card.produces : card.costColours;
  const band = {
    min: Math.max(0, card.manaValue - settings.manaValueBand),
    max: card.manaValue + settings.manaValueBand,
  };
  const anyInColours: SearchSpec = { land: card.land, colours: deckColours };
  // A land is replaced by one that makes what it made, if the pool has one, so a ban does
  // not strand the spells that needed its colour.
  const sameMana: SearchSpec = {
    land: true,
    colours: deckColours,
    accept: (other) => own.every((colour) => other.produces.includes(colour)),
    fallback: anyInColours,
  };
  const inColours: SearchSpec = card.land
    ? sameMana
    : { land: false, colours: deckColours, manaValue: band, fallback: anyInColours };
  const search: SearchSpec =
    own.length > 0 && !card.land
      ? { land: false, colours: own, manaValue: band, fallback: inColours }
      : inColours;
  return {
    diagnosis: 'ban',
    removed,
    count,
    search,
    swapIn: null,
    starved: null,
    ban,
    // A hole nothing of its kind fills takes a land: basics are never short.
    otherwise: card.land
      ? null
      : {
          diagnosis: 'ban',
          removed,
          count,
          search: { land: true, colours: deckColours },
          swapIn: null,
          starved: null,
          ban,
          otherwise: null,
        },
  };
};

/** Whether cutting `count` of this land leaves every colour the spells need made. */
const keepsColours = (
  slot: Slot,
  count: number,
  lands: readonly Slot[],
  needed: readonly Colour[],
): boolean => {
  if (count < slot.count) return true;
  const made = coloursOf(
    lands.filter((other) => other !== slot).map((other) => other.card.produces),
  );
  return needed.every((colour) => made.includes(colour));
};

/** The colour the lands are shortest of: most spell copies needing it per land making it. */
const starvedColour = (spells: readonly Slot[], lands: readonly Slot[]): Colour | null => {
  let worst: Colour | null = null;
  let worstRatio = 0;
  for (const colour of allColours) {
    const demand = spells
      .filter((slot) => slot.card.costColours.includes(colour))
      .reduce((sum, slot) => sum + slot.count, 0);
    if (demand === 0) continue;
    const supply = lands
      .filter((slot) => slot.card.produces.includes(colour))
      .reduce((sum, slot) => sum + slot.count, 0);
    const ratio = demand / Math.max(supply, 0.5);
    if (ratio > worstRatio) {
      worst = colour;
      worstRatio = ratio;
    }
  }
  return worst;
};

/** How much a land's colours are over-supplied: lands making them per spell needing them. */
const surplusOf = (land: Slot, spells: readonly Slot[], lands: readonly Slot[]): number => {
  let surplus = 0;
  for (const colour of land.card.produces) {
    const demand = spells
      .filter((slot) => slot.card.costColours.includes(colour))
      .reduce((sum, slot) => sum + slot.count, 0);
    const supply = lands
      .filter((slot) => slot.card.produces.includes(colour))
      .reduce((sum, slot) => sum + slot.count, 0);
    surplus = Math.max(surplus, supply / Math.max(demand, 0.5));
  }
  return surplus;
};

// --- Ranking ---

/** Static score plus the card's record here, plus noise; best first. */
const rankStatic = (
  found: readonly PoolCard[],
  input: DeckAgentInput,
  settings: DeckAgentSettings,
): Candidate[] => {
  const deckWinRate =
    input.counts.deck.games > 0 ? input.counts.deck.wins / input.counts.deck.games : 0.5;
  return found
    .map((pool) => {
      const staticScore = pool.land ? landStatic(pool, input) : staticQuality(pool);
      const record = input.counts.cards[pool.oracleId];
      const prior =
        record !== undefined && record.drawn.games > 0
          ? RECORD_WEIGHT * cardStats(record, deckWinRate, settings.shrinkage).delta
          : 0;
      const u = Math.min(Math.max(input.rng.nextFloat(), 1e-12), 1 - 1e-12);
      const noise = settings.temperature * -Math.log(-Math.log(u));
      return {
        pool,
        staticScore,
        rank: staticScore + prior + noise,
        card: null,
        scripted: false,
        score: null,
        trial: null,
      };
    })
    .sort((a, b) => b.rank - a.rank || (a.pool.oracleId < b.pool.oracleId ? -1 : 1));
};

/** Before its script says what it makes, a land is judged by its colour identity. */
const landStatic = (card: PoolCard, input: DeckAgentInput): number => {
  const needed = coloursOf(
    [...input.cards.values()].filter((card) => !card.land).map((card) => card.costColours),
  );
  return card.colourIdentity.filter((colour) => needed.includes(colour)).length * PER_COLOUR_MADE;
};

/** What a card's script adds: answers, cards drawn, the matchup, and for a land its colours. */
const scriptedQuality = (card: DeckCard, input: DeckAgentInput): number => {
  if (card.land) {
    const needed = coloursOf(
      [...input.cards.values()].filter((other) => !other.land).map((other) => other.costColours),
    );
    return card.produces.filter((colour) => needed.includes(colour)).length * PER_COLOUR_MADE;
  }
  return (
    card.tags.vs.length * PER_ANSWER +
    card.cardsDrawn * PER_CARD_DRAWN +
    MATCHUP_WEIGHT * shareAnswered(card.tags.vs, input.opponent)
  );
};

/** Of the opponent's seen nonland cards, the share this card's answers reach. */
export const shareAnswered = (vs: readonly CardKind[], opponent: OpponentKnowledge): number => {
  let total = 0;
  let answered = 0;
  for (const slot of opponent.seen) {
    const card = opponent.cards.get(slot.oracleId);
    if (card === undefined || card.land) continue;
    total += slot.count;
    if (card.tags.is.some((kind) => vs.includes(kind))) answered += slot.count;
  }
  return total === 0 ? 0 : answered / total;
};

// --- Plumbing ---

const coloursOf = (lists: readonly (readonly Colour[])[]): Colour[] => {
  const found = new Set(lists.flat());
  return allColours.filter((colour) => found.has(colour));
};

const union = (a: readonly Colour[], b: readonly Colour[]): Colour[] => coloursOf([a, b]);

const copiesIn75 = (deck: Deck75): Map<OracleId, number> => {
  const counts = new Map<OracleId, number>();
  for (const slot of [...deck.main, ...deck.side]) {
    counts.set(slot.oracleId, (counts.get(slot.oracleId) ?? 0) + slot.count);
  }
  return counts;
};

/** The deck with the plan's slot replaced by `oracleId`, for a trial. */
const replaced = (deck: Deck75, plan: Plan, oracleId: OracleId): Deck75 => {
  const zone = plan.removed.zone;
  const slots = new Map(deck[zone].map((slot) => [slot.oracleId, slot.count]));
  const left = (slots.get(plan.removed.oracleId) ?? 0) - plan.count;
  if (left > 0) slots.set(plan.removed.oracleId, left);
  else slots.delete(plan.removed.oracleId);
  slots.set(oracleId, (slots.get(oracleId) ?? 0) + plan.count);
  const next = [...slots].map(([id, count]) => ({ oracleId: id, count }));
  return zone === 'main' ? { main: next, side: deck.side } : { main: deck.main, side: next };
};

const slotEvidence = (slot: Slot): SlotEvidence => ({
  oracleId: slot.oracleId,
  name: slot.card.name,
  zone: slot.zone,
  count: slot.count,
  delta: slot.stats?.delta ?? 0,
  deadInHandRate: slot.stats?.deadInHandRate ?? null,
  castRate: slot.stats?.castRate ?? null,
  gamesDrawn: slot.stats?.gamesDrawn ?? 0,
  score: slot.score,
});

// --- Reasons ---

const colourNames: Readonly<Record<Colour, string>> = {
  W: 'white',
  U: 'blue',
  B: 'black',
  R: 'red',
  G: 'green',
};

const percent = (rate: number): string => `${Math.round(rate * 100)}%`;
const signedPercent = (rate: number): string => {
  const points = Math.round(rate * 100);
  return points > 0 ? `+${points}%` : points < 0 ? `−${-points}%` : '±0%';
};

/** "Grizzly Bears (Δ −8%, dead in hand 31%)", as far as its record goes. */
const described = (slot: Slot): string => {
  if (slot.stats === null || slot.stats.gamesDrawn === 0) return slot.card.name;
  const parts = [`Δ ${signedPercent(slot.stats.delta)}`];
  if ((slot.stats.deadInHandRate ?? 0) > 0) {
    parts.push(`dead in hand ${percent(slot.stats.deadInHandRate ?? 0)}`);
  }
  return `${slot.card.name} (${parts.join(', ')})`;
};

const copies = (count: number, name: string): string => (count === 1 ? name : `${count} ${name}`);

const replaceReason = (
  plan: Plan,
  winner: Candidate,
  deck: ReturnType<typeof deckStats>,
  cycleWinRate: number | undefined,
): string => {
  const name = winner.card?.name ?? winner.pool.name;
  const over = (trial: TrialEvidence) =>
    `trial ${percent(trial.winRate)} over ${trial.matches} ${trial.matches === 1 ? 'match' : 'matches'}`;
  const trial =
    winner.trial === null
      ? ''
      : cycleWinRate === undefined
        ? ` (${over(winner.trial)})`
        : ` (${over(winner.trial)} vs ${percent(cycleWinRate)} this cycle)`;
  const out = copies(plan.count, described(plan.removed));
  const inn = `${copies(plan.count, name)}${trial}`;
  switch (plan.diagnosis) {
    case 'ban':
      return plan.ban === 'restricted'
        ? `Restricted to one copy: cut ${out}${zoneNote(plan)} for ${inn}`
        : `Banned: cut ${out}${zoneNote(plan)} for ${inn}`;
    case 'screw':
      return `Mana screw in ${percent(deck.screwRate ?? 0)} of games: cut ${out} for ${inn}`;
    case 'flood':
      return `Mana flood in ${percent(deck.floodRate ?? 0)} of games: cut ${out} for ${inn}`;
    case 'colourScrew':
      return `Short of ${plan.starved === null ? 'a colour' : colourNames[plan.starved]} mana (colour screw in ${percent(deck.colourScrewRate ?? 0)} of games): cut ${out} for ${inn}`;
    case 'idleSideboard':
      return `${plan.removed.card.name} was never boarded in: cut it from the sideboard for ${inn}`;
    default:
      return plan.removed.zone === 'side'
        ? `Cut ${out} from the sideboard for ${inn}`
        : `Cut ${out} for ${inn}`;
  }
};

const zoneNote = (plan: DeckPlan): string =>
  plan.removed.zone === 'side' ? ' from the sideboard' : '';

const swapReason = (out: Slot, into: Slot): string =>
  `Moved ${described(into)} from the sideboard into the main deck for ${described(out)}`;
