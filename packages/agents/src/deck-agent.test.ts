import type { Rng } from '@mtg/engine/view';
import {
  type AgentCounts,
  addCounts,
  applyDeckChange,
  asOracleId,
  type BanList,
  banViolations,
  type CardCounts,
  type CardKind,
  type Colour,
  type Deck75,
  type DeckCounts,
  emptyAgentCounts,
  emptyCardCounts,
  emptyDeckCounts,
  type OracleId,
} from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import {
  type CardPoolQuery,
  DeckAgentError,
  type DeckAgentInput,
  type DeckCard,
  diagnose,
  type PoolCard,
  type PoolCriteria,
  StatisticalDeckAgent,
  shareAnswered,
  staticQuality,
  type TrialRunner,
} from './deck-agent.js';

/**
 * The deck agent (docs/05 "Choosing the change"; roadmap 5.4), over a red-green deck and
 * a pool made up for the purpose, so each step — diagnosis, search, ranking, trial,
 * reason — can be pushed to its edge.
 */

const id = asOracleId;

/** mulberry32: a real, seeded generator, since the agents package cannot import the engine's. */
const seeded = (seed: number): Rng => {
  let a = seed >>> 0;
  const nextUint32 = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  const nextFloat = () => nextUint32() / 2 ** 32;
  const rng: Rng = {
    nextUint32,
    nextFloat,
    nextInt: (max) => Math.floor(nextFloat() * max),
    nextIntBetween: (min, max) => min + Math.floor(nextFloat() * (max - min + 1)),
    nextBoolean: (p = 0.5) => nextFloat() < p,
    pick: (items) => {
      const item = items[Math.floor(nextFloat() * items.length)];
      if (item === undefined) throw new Error('empty');
      return item;
    },
    pickWeightedIndex: () => 0,
    shuffled: (items) => [...items],
    fork: () => rng,
    save: () => [0, 0, 0, 0] as const,
  };
  return rng;
};

// --- Cards ---

interface Made {
  name: string;
  colours?: Colour[];
  mv?: number;
  land?: boolean;
  basic?: boolean;
  produces?: Colour[];
  is?: CardKind[];
  vs?: CardKind[];
  drawn?: number;
  power?: number | null;
  toughness?: number | null;
  keywords?: string[];
  copies?: number;
}

const deckCard = (made: Made): DeckCard => ({
  name: made.name,
  basic: made.basic ?? false,
  manaValue: made.mv ?? 0,
  cardsDrawn: made.drawn ?? 0,
  land: made.land ?? false,
  costColours: made.land === true ? [] : (made.colours ?? []),
  produces: made.produces ?? [],
  tags: {
    is: made.is ?? (made.land === true ? ['land'] : ['creature', 'spell']),
    vs: made.vs ?? [],
  },
});

const poolCard = (made: Made): PoolCard => ({
  oracleId: id(made.name),
  name: made.name,
  manaValue: made.mv ?? 0,
  colourIdentity: made.land === true ? (made.produces ?? []) : (made.colours ?? []),
  land: made.land ?? false,
  basic: made.basic ?? false,
  power: made.power === undefined ? 2 : made.power,
  toughness: made.toughness === undefined ? 2 : made.toughness,
  keywords: made.keywords ?? [],
  copies: made.copies ?? (made.basic === true ? Number.POSITIVE_INFINITY : 4),
});

const deckCards: Made[] = [
  { name: 'mountain', land: true, basic: true, produces: ['R'] },
  { name: 'forest', land: true, basic: true, produces: ['G'] },
  { name: 'bear', colours: ['G'], mv: 2 },
  { name: 'elf', colours: ['G'], mv: 1 },
  { name: 'giant', colours: ['G'], mv: 4 },
  { name: 'wurm', colours: ['G'], mv: 6 },
  { name: 'bolt', colours: ['R'], mv: 1, is: ['instant', 'burn'], vs: ['creature'] },
  { name: 'shock', colours: ['R'], mv: 1, is: ['instant', 'burn'], vs: ['creature'] },
  { name: 'ogre', colours: ['R'], mv: 3 },
  { name: 'dragon', colours: ['R'], mv: 5 },
  { name: 'raider', colours: ['R'], mv: 2 },
  { name: 'naturalize', colours: ['G'], mv: 2, is: ['instant'], vs: ['artifact', 'enchantment'] },
  { name: 'shatter', colours: ['R'], mv: 2, is: ['instant'], vs: ['artifact'] },
  { name: 'pyroclasm', colours: ['R'], mv: 2, is: ['sorcery'], vs: ['creature'] },
  { name: 'spider', colours: ['G'], mv: 4 },
];

const slot = (name: string, count: number) => ({ oracleId: id(name), count });
const deck: Deck75 = {
  main: [
    slot('mountain', 12),
    slot('forest', 12),
    slot('bear', 4),
    slot('elf', 4),
    slot('giant', 4),
    slot('wurm', 4),
    slot('bolt', 4),
    slot('shock', 4),
    slot('ogre', 4),
    slot('dragon', 4),
    slot('raider', 4),
  ],
  side: [slot('naturalize', 4), slot('shatter', 4), slot('pyroclasm', 4), slot('spider', 3)],
};

const cardsOf = (made: readonly Made[]) =>
  new Map(made.map((card) => [id(card.name), deckCard(card)]));

/** Candidates the pool can offer, red and green at every mana value, and the awkward ones. */
const poolMade: Made[] = [
  { name: 'mountain', land: true, basic: true, produces: ['R'] },
  { name: 'forest', land: true, basic: true, produces: ['G'] },
  { name: 'island', land: true, basic: true, produces: ['U'] },
  { name: 'taiga', land: true, produces: ['R', 'G'] },
  { name: 'ruins', land: true, produces: [] },
  { name: 'wolf', colours: ['G'], mv: 2, power: 3, toughness: 3 },
  { name: 'goblin', colours: ['R'], mv: 1 },
  { name: 'hill-giant', colours: ['R'], mv: 3 },
  { name: 'hound', colours: ['R'], mv: 4, power: 3, toughness: 2 },
  { name: 'drake', colours: ['U'], mv: 2, power: 4, toughness: 4 },
  { name: 'banned-beast', colours: ['G'], mv: 2, power: 9, toughness: 9 },
  { name: 'relic', colours: ['G'], mv: 2, power: 8, toughness: 8, copies: 1 },
  { name: 'unscriptable', colours: ['R'], mv: 2, power: 7, toughness: 7 },
  { name: 'colossus', colours: ['G'], mv: 7, power: 7, toughness: 7 },
  { name: 'bolt', colours: ['R'], mv: 1, power: 6, toughness: 6 },
  ...deckCards,
];

class FakePool implements CardPoolQuery {
  readonly searches: PoolCriteria[] = [];
  readonly scripted: OracleId[] = [];
  private readonly cards: PoolCard[];
  private readonly scripts: Map<OracleId, DeckCard>;

  constructor(
    made: readonly Made[] = poolMade,
    private readonly unsupported: ReadonlySet<string> = new Set(['unscriptable']),
  ) {
    const byName = new Map(made.map((card) => [card.name, card]));
    this.cards = [...byName.values()].map(poolCard);
    this.scripts = new Map([...byName.values()].map((card) => [id(card.name), deckCard(card)]));
  }

  search(criteria: PoolCriteria): readonly PoolCard[] {
    this.searches.push(criteria);
    return this.cards.filter(
      (card) =>
        card.land === criteria.land &&
        card.colourIdentity.every((colour) => criteria.colours.includes(colour)) &&
        (criteria.manaValue === undefined ||
          (card.manaValue >= criteria.manaValue.min && card.manaValue <= criteria.manaValue.max)) &&
        !criteria.exclude.has(card.oracleId) &&
        criteria.banList.get(card.oracleId) !== 'banned',
    );
  }

  async script(oracleId: OracleId): Promise<DeckCard | null> {
    this.scripted.push(oracleId);
    if (this.unsupported.has(oracleId)) return null;
    return this.scripts.get(oracleId) ?? null;
  }
}

// --- Counts ---

const tally = (games: number, wins: number) => ({ games, wins });

/** A card drawn in `drawn` of `games` games, winning `rate` when drawn and `notRate` when not. */
const record = (
  games: number,
  drawn: number,
  rate: number,
  notRate: number,
  more: Partial<CardCounts> = {},
): CardCounts => ({
  ...emptyCardCounts,
  games,
  drawn: tally(drawn, Math.round(drawn * rate)),
  notDrawn: tally(games - drawn, Math.round((games - drawn) * notRate)),
  cast: drawn,
  ...more,
});

const deckCounts = (over: Partial<DeckCounts> = {}): DeckCounts => ({
  ...emptyDeckCounts,
  games: 100,
  wins: 45,
  screwChances: 100,
  floodChances: 90,
  ...over,
});

/** Every main-deck spell at an even record, so the one a test changes is the one that stands out. */
const evenCards = (): Record<string, CardCounts> => {
  const cards: Record<string, CardCounts> = {};
  for (const slotted of deck.main) cards[slotted.oracleId] = record(100, 40, 0.45, 0.45);
  return cards;
};

const counts = (
  cards: Record<string, CardCounts> = evenCards(),
  over: Partial<DeckCounts> = {},
): AgentCounts => ({ ...emptyAgentCounts, deck: deckCounts(over), cards });

const input = (over: Partial<DeckAgentInput> = {}): DeckAgentInput => ({
  deck,
  cards: cardsOf(deckCards),
  counts: counts(),
  opponent: { seen: [], cards: new Map() },
  // A 9/9 for two would win every search it was allowed into.
  banList: new Map([[id('banned-beast'), 'banned']]),
  pool: new FakePool(),
  rng: seeded(1),
  cycleWinRate: 0.41,
  ...over,
});

const calm = { temperature: 0, offColourChance: 0 };
const agent = (settings = {}) => new StatisticalDeckAgent({ ...calm, trialTopK: 0, ...settings });

// --- Diagnosis ---

describe('diagnosis', () => {
  it('cuts the main-deck card with the worst shrunk Δ, all copies, for a card in the same zone', async () => {
    const cards = evenCards();
    cards[id('ogre')] = record(100, 40, 0.3, 0.55);
    const change = await agent().chooseChange(input({ counts: counts(cards) }));
    expect(change.shape).toBe('replace');
    expect(change.evidence.diagnosis).toBe('weakest');
    expect(change.remove).toEqual({ oracleId: id('ogre'), zone: 'main', count: 4 });
    expect(change.add.zone).toBe('main');
    expect(change.add.count).toBe(4);
    expect(change.evidence.removed.delta).toBeLessThan(0);
  });

  it('charges a card for sitting dead in hand and for going uncast', () => {
    const dead = evenCards();
    dead[id('giant')] = record(100, 40, 0.45, 0.45, { deadInHand: 40 });
    expect(diagnose(input({ counts: counts(dead) })).removed.oracleId).toBe(id('giant'));

    const uncast = evenCards();
    uncast[id('dragon')] = record(100, 40, 0.45, 0.45, { cast: 4 });
    expect(diagnose(input({ counts: counts(uncast) })).removed.oracleId).toBe(id('dragon'));
  });

  it('trades a spell for a land when the deck is screwed too often, over enough games', async () => {
    const screwed = counts(evenCards(), { screwed: 40, flooded: 5 });
    const change = await agent().chooseChange(input({ counts: screwed }));
    expect(change.evidence.diagnosis).toBe('screw');
    expect(change.remove.zone).toBe('main');
    expect(deck.main.some((s) => s.oracleId === change.remove.oracleId)).toBe(true);
    expect(cardsOf(poolMade).get(change.add.oracleId)?.land).toBe(true);
    expect(change.reason).toMatch(/^Mana screw in 40% of games: cut 4 /);

    // Nineteen games of it is not enough to believe.
    const few = counts(evenCards(), { screwed: 10, screwChances: 19 });
    expect(diagnose(input({ counts: few })).diagnosis).toBe('weakest');
    // Nor is a rate under the threshold.
    const low = counts(evenCards(), { screwed: 24, screwChances: 100 });
    expect(diagnose(input({ counts: low })).diagnosis).toBe('weakest');
  });

  it('trades four basics for a spell of any mana value when the deck floods', async () => {
    const flooded = counts(evenCards(), { flooded: 36, screwed: 5 });
    const change = await agent().chooseChange(input({ counts: flooded }));
    expect(change.evidence.diagnosis).toBe('flood');
    expect(['mountain', 'forest']).toContain(change.remove.oracleId);
    expect(change.remove.count).toBe(4);
    expect(cardsOf(poolMade).get(change.add.oracleId)?.land).toBe(false);
    const search = (change.evidence.candidates.length > 0 ? change : null) === null;
    expect(search).toBe(false);
  });

  it('does not believe a flood rate under the threshold', () => {
    const under = counts(evenCards(), { flooded: 20, floodChances: 90 });
    expect(diagnose(input({ counts: under })).diagnosis).toBe('weakest');
  });

  it('when screw and flood are both high, fixes whichever is higher', () => {
    const both = counts(evenCards(), { screwed: 30, flooded: 40 });
    expect(diagnose(input({ counts: both })).diagnosis).toBe('flood');
  });

  it('never cuts the only land that makes a colour the spells need', () => {
    // A blue splash: two glaciers are the only blue source for four blue raiders.
    const splash: Deck75 = {
      main: [
        ...deck.main.filter((s) => s.oracleId !== id('mountain')),
        slot('mountain', 10),
        slot('glacier', 2),
      ],
      side: deck.side,
    };
    const made = deckCards
      .filter((card) => card.name !== 'raider')
      .concat([
        { name: 'glacier', land: true, produces: ['U'] },
        { name: 'raider', colours: ['U'], mv: 2 },
      ]);
    const cards = evenCards();
    cards[id('glacier')] = record(100, 30, 0.2, 0.5);
    const plan = diagnose(
      input({ deck: splash, cards: cardsOf(made), counts: counts(cards, { flooded: 40 }) }),
    );
    expect(plan.diagnosis).toBe('flood');
    expect(plan.removed.oracleId).not.toBe(id('glacier'));
  });

  it('fixes a colour screw with a land that makes the starved colour, cutting a surplus land', async () => {
    // Twenty-eight green spells and twelve forests against eight red spells and twelve mountains.
    const heavy: Deck75 = {
      main: [
        slot('mountain', 12),
        slot('forest', 12),
        slot('bear', 4),
        slot('elf', 4),
        slot('giant', 4),
        slot('wurm', 4),
        slot('bolt', 4),
        slot('spider', 4),
        slot('naturalize', 4),
        slot('wolf', 4),
        slot('shock', 4),
      ],
      side: [slot('shatter', 4), slot('pyroclasm', 4), slot('ogre', 4), slot('dragon', 3)],
    };
    const cards = cardsOf(poolMade);
    const change = await agent().chooseChange(
      input({ deck: heavy, cards, counts: counts({}, { colourScrewed: 30 }) }),
    );
    expect(change.evidence.diagnosis).toBe('colourScrew');
    expect(change.evidence.starvedColour).toBe('G');
    expect(change.remove).toEqual({ oracleId: id('mountain'), zone: 'main', count: 4 });
    expect(change.add.oracleId).toBe(id('taiga'));
    expect(change.reason).toMatch(/^Short of green mana \(colour screw in 30% of games\)/);
  });

  it('cuts the land whose colour is most over-supplied, not any that lacks the starved one', () => {
    // Green is starved; blue is short too, so its two glaciers must not be what goes.
    const three: Deck75 = {
      main: [
        slot('mountain', 12),
        slot('forest', 10),
        slot('glacier', 2),
        slot('bear', 4),
        slot('elf', 4),
        slot('giant', 4),
        slot('wurm', 4),
        slot('spider', 4),
        slot('naturalize', 4),
        slot('wolf', 4),
        slot('bolt', 4),
        slot('drake', 4),
      ],
      side: deck.side,
    };
    const made: Made[] = [
      ...poolMade,
      { name: 'glacier', land: true, produces: ['U'] },
      { name: 'drake', colours: ['U'], mv: 2 },
    ];
    const plan = diagnose(
      input({ deck: three, cards: cardsOf(made), counts: counts({}, { colourScrewed: 30 }) }),
    );
    expect(plan.starved).toBe('G');
    expect(plan.removed.oracleId).toBe(id('mountain'));
  });

  it('cuts a card that needs the starved colour when the pool has no land for it', async () => {
    const noDuals = new FakePool(poolMade.filter((card) => card.name !== 'taiga'));
    // Blue is starved: two blue spells and no island at all.
    const blue: Deck75 = {
      main: [...deck.main.filter((s) => s.oracleId !== id('raider')), slot('drake', 4)],
      side: deck.side,
    };
    const made = [...deckCards, { name: 'drake', colours: ['U'] as Colour[], mv: 2 }];
    const change = await agent().chooseChange(
      input({
        deck: blue,
        cards: cardsOf(made),
        // A blue two-drop better than anything else, which a blue-starved deck must not take.
        pool: new FakePool(
          [
            ...poolMade.filter((card) => card.name !== 'island'),
            { name: 'sprite', colours: ['U'], mv: 2, power: 6, toughness: 6 },
          ],
          new Set(['unscriptable']),
        ),
        counts: counts({}, { colourScrewed: 30 }),
      }),
    );
    expect(change.evidence.diagnosis).toBe('colourScrew');
    expect(change.evidence.starvedColour).toBe('U');
    expect(change.remove.oracleId).toBe(id('drake'));
    expect(cardsOf(poolMade).get(change.add.oracleId)?.costColours).not.toContain('U');
    expect(noDuals).toBeDefined();
  });

  it('cuts a sideboard card nobody ever boarded in once the main deck has nothing worse', async () => {
    const good: Record<string, CardCounts> = {};
    for (const s of deck.main) good[s.oracleId] = record(100, 40, 0.55, 0.45);
    // Everything in the side was boarded in at some point, bar the spider.
    for (const name of ['naturalize', 'shatter', 'pyroclasm'])
      good[id(name)] = record(10, 5, 0.6, 0.4);
    const change = await agent().chooseChange(input({ counts: counts(good) }));
    expect(change.evidence.diagnosis).toBe('idleSideboard');
    expect(change.remove).toEqual({ oracleId: id('spider'), zone: 'side', count: 3 });
    expect(change.add.zone).toBe('side');
    expect(change.reason).toMatch(/^spider was never boarded in: cut it from the sideboard for /);
  });

  it('swaps in a sideboard card whose boarded-in record beats the worst main-deck card', async () => {
    const cards = evenCards();
    cards[id('ogre')] = record(100, 40, 0.3, 0.55);
    cards[id('pyroclasm')] = record(40, 30, 0.8, 0.3);
    const change = await agent().chooseChange(input({ counts: counts(cards) }));
    expect(change.shape).toBe('swap');
    expect(change.evidence.diagnosis).toBe('swap');
    expect(change.remove).toEqual({ oracleId: id('ogre'), zone: 'main', count: 4 });
    expect(change.add).toEqual({ oracleId: id('pyroclasm'), zone: 'main', count: 4 });
    expect(change.reason).toMatch(
      /^Moved pyroclasm \(Δ \+\d+%\) from the sideboard into the main deck for ogre \(Δ −\d+%/,
    );
    const after = applyDeckChange(deck, change);
    expect(after.side).toContainEqual({ oracleId: id('ogre'), count: 4 });
  });

  it('does not swap in a card whose colour the lands do not make', () => {
    const cards = evenCards();
    cards[id('ogre')] = record(100, 40, 0.3, 0.55);
    cards[id('wisp')] = record(40, 30, 0.8, 0.3);
    const blueSide: Deck75 = {
      main: deck.main,
      side: [...deck.side.filter((s) => s.oracleId !== id('pyroclasm')), slot('wisp', 4)],
    };
    const made = [...deckCards, { name: 'wisp', colours: ['U'] as Colour[], mv: 2 }];
    const plan = diagnose(input({ deck: blueSide, cards: cardsOf(made), counts: counts(cards) }));
    expect(plan.diagnosis).toBe('weakest');
  });

  it('does not swap when the counts differ or the margin is not beaten', () => {
    const cards = evenCards();
    cards[id('ogre')] = record(100, 40, 0.3, 0.55);
    cards[id('spider')] = record(40, 30, 0.8, 0.3); // three copies against four
    expect(diagnose(input({ counts: counts(cards) })).diagnosis).toBe('weakest');

    const close = evenCards();
    close[id('ogre')] = record(100, 40, 0.44, 0.45);
    close[id('pyroclasm')] = record(40, 20, 0.46, 0.45);
    expect(diagnose(input({ counts: counts(close) })).diagnosis).toBe('weakest');
  });
});

// --- The search ---

describe('searching the pool', () => {
  const weakOgre = () => {
    const cards = evenCards();
    cards[id('ogre')] = record(100, 40, 0.3, 0.55);
    return counts(cards);
  };

  it('asks for the deck’s colours, within a mana value of the card cut, excluding it', async () => {
    const pool = new FakePool();
    await agent().chooseChange(input({ counts: weakOgre(), pool }));
    const [first] = pool.searches;
    expect(first?.land).toBe(false);
    expect(first?.colours).toEqual(['R', 'G']);
    expect(first?.manaValue).toEqual({ min: 2, max: 4 });
    expect(first?.exclude.has(id('ogre'))).toBe(true);
  });

  it('never adds a banned card, one the 75 cannot hold four more of, or a restricted one', async () => {
    const banList: BanList = new Map([[id('banned-beast'), 'banned']]);
    for (let seed = 0; seed < 30; seed += 1) {
      const change = await agent({ temperature: 2 }).chooseChange(
        input({ counts: weakOgre(), banList, rng: seeded(seed) }),
      );
      expect(change.add.oracleId).not.toBe(id('banned-beast'));
      // Bolt is already four in the main deck; relic is restricted in the base format.
      expect(change.add.oracleId).not.toBe(id('bolt'));
      expect(change.add.oracleId).not.toBe(id('relic'));
    }
  });

  it('holds a card the run restricts to one copy, which a four-card slot cannot take', async () => {
    const banList: BanList = new Map([[id('wolf'), 'restricted']]);
    for (let seed = 0; seed < 20; seed += 1) {
      const change = await agent({ temperature: 2 }).chooseChange(
        input({ counts: weakOgre(), banList, rng: seeded(seed) }),
      );
      expect(change.add.oracleId).not.toBe(id('wolf'));
    }
  });

  it('skips what the engine cannot play, and says so in the evidence', async () => {
    const pool = new FakePool();
    const change = await agent().chooseChange(input({ counts: weakOgre(), pool }));
    expect(change.add.oracleId).not.toBe(id('unscriptable'));
    const unscriptable = change.evidence.candidates.find((c) => c.oracleId === id('unscriptable'));
    expect(unscriptable?.supported).toBe(false);
    expect(unscriptable?.score).toBeNull();
  });

  it('scripts no more than shortlistSize candidates', async () => {
    const pool = new FakePool();
    const change = await agent({ shortlistSize: 2 }).chooseChange(
      input({ counts: weakOgre(), pool }),
    );
    expect(pool.scripted.length).toBeLessThanOrEqual(2);
    expect(change.evidence.candidates.length).toBeLessThanOrEqual(2);
  });

  it('widens the mana-value band when nothing in it can be played', async () => {
    // The only red or green spells left are a one-drop and a seven-drop.
    const thin = new FakePool(
      [...poolMade.filter((c) => c.land === true), { name: 'colossus', colours: ['G'], mv: 7 }],
      new Set(),
    );
    const change = await agent().chooseChange(input({ counts: weakOgre(), pool: thin }));
    expect(change.add.oracleId).toBe(id('colossus'));
    expect(thin.searches.map((s) => s.manaValue)).toEqual([{ min: 2, max: 4 }, undefined]);
  });

  it('gives up plainly when nothing at all can be played', async () => {
    const empty = new FakePool(poolMade.filter((c) => c.land === true));
    await expect(agent().chooseChange(input({ counts: weakOgre(), pool: empty }))).rejects.toThrow(
      DeckAgentError,
    );
  });

  it('sometimes looks at a colour the lands make but no spell asks for', async () => {
    // The deck plays two islands and no blue spell.
    const withIslands: Deck75 = {
      main: [
        ...deck.main.map((s) => (s.oracleId === id('mountain') ? slot('mountain', 10) : s)),
        slot('island', 2),
      ],
      side: deck.side,
    };
    const made = [
      ...deckCards,
      { name: 'island', land: true, basic: true, produces: ['U'] as Colour[] },
    ];
    const colours = async (chance: number) => {
      const pool = new FakePool();
      await new StatisticalDeckAgent({
        temperature: 0,
        offColourChance: chance,
        trialTopK: 0,
      }).chooseChange(input({ deck: withIslands, cards: cardsOf(made), counts: weakOgre(), pool }));
      return pool.searches[0]?.colours;
    };
    expect(await colours(0)).toEqual(['R', 'G']);
    expect(await colours(1)).toEqual(['U', 'R', 'G']);
  });
});

// --- Ranking ---

describe('the static quality model', () => {
  it('prices a body per mana, and adds its keywords', () => {
    const bear = poolCard({ name: 'b', mv: 2, power: 2, toughness: 2 });
    const wolf = poolCard({ name: 'w', mv: 2, power: 3, toughness: 3 });
    const flier = poolCard({ name: 'f', mv: 2, keywords: ['Flying'] });
    const wall = poolCard({ name: 'd', mv: 2, keywords: ['Defender'] });
    expect(staticQuality(bear)).toBeCloseTo(1);
    expect(staticQuality(wolf)).toBeGreaterThan(staticQuality(bear));
    expect(staticQuality(flier)).toBeGreaterThan(staticQuality(bear));
    expect(staticQuality(wall)).toBeLessThan(staticQuality(bear));
    // A zero-drop is not divided by zero.
    expect(
      Number.isFinite(staticQuality(poolCard({ name: 'z', mv: 0, power: 0, toughness: 2 }))),
    ).toBe(true);
  });

  it('takes the best candidate when there is no noise, and sometimes another when there is', async () => {
    const cards = evenCards();
    cards[id('ogre')] = record(100, 40, 0.3, 0.55);
    const picks = new Set<string>();
    for (let seed = 0; seed < 40; seed += 1) {
      const quiet = await agent().chooseChange(input({ counts: counts(cards), rng: seeded(seed) }));
      expect(quiet.add.oracleId).toBe(id('wolf'));
      const noisy = await agent({ temperature: 3 }).chooseChange(
        input({ counts: counts(cards), rng: seeded(seed) }),
      );
      picks.add(noisy.add.oracleId);
    }
    expect(picks.size).toBeGreaterThan(1);
  });

  it('prefers a card with a good record in this deck from earlier cycles', async () => {
    const cards = evenCards();
    cards[id('ogre')] = record(100, 40, 0.3, 0.55);
    // Hill giant is weaker on paper than the wolf, but won when drawn the last time it was here.
    cards[id('hill-giant')] = record(60, 30, 0.8, 0.4);
    const change = await agent().chooseChange(input({ counts: counts(cards) }));
    expect(change.add.oracleId).toBe(id('hill-giant'));
  });

  it('adds what a script answers of the opponent’s deck, and the cards it draws', async () => {
    const opponent = {
      seen: [slot('their-bear', 12), slot('their-bolt', 4)],
      cards: new Map([
        [id('their-bear'), deckCard({ name: 'their-bear', is: ['creature'] })],
        [id('their-bolt'), deckCard({ name: 'their-bolt', is: ['instant', 'burn'] })],
      ]),
    };
    expect(shareAnswered(['creature'], opponent)).toBeCloseTo(0.75);
    // Their lands are not what a removal spell is for, and do not dilute the share.
    const withLands = {
      seen: [...opponent.seen, slot('their-forest', 20)],
      cards: new Map([
        ...opponent.cards,
        [id('their-forest'), deckCard({ name: 'their-forest', land: true })],
      ]),
    };
    expect(shareAnswered(['creature'], withLands)).toBeCloseTo(0.75);
    expect(shareAnswered(['artifact'], opponent)).toBe(0);
    expect(shareAnswered(['creature'], { seen: [], cards: new Map() })).toBe(0);

    const pool: Made[] = [
      ...poolMade.filter((c) => c.land === true),
      { name: 'plain', colours: ['R'], mv: 3, power: null, toughness: null },
      { name: 'removal', colours: ['R'], mv: 3, power: null, toughness: null, vs: ['creature'] },
      { name: 'draw-one', colours: ['R'], mv: 3, power: null, toughness: null, drawn: 1 },
    ];
    const cards = evenCards();
    cards[id('ogre')] = record(100, 40, 0.3, 0.55);
    const pick = async (withOpponent: boolean) =>
      (
        await agent().chooseChange(
          input({
            counts: counts(cards),
            pool: new FakePool(pool, new Set()),
            opponent: withOpponent ? opponent : { seen: [], cards: new Map() },
          }),
        )
      ).add.oracleId;
    // Answering something beats answering nothing.
    const answers = await agent().chooseChange(
      input({
        counts: counts(cards),
        pool: new FakePool(
          pool.filter((c) => c.name !== 'draw-one'),
          new Set(),
        ),
      }),
    );
    expect(answers.add.oracleId).toBe(id('removal'));
    // Alone, drawing a card (0.25) beats answering one kind (0.1); against a deck of
    // creatures the removal adds 0.375 for the matchup, and wins.
    expect(await pick(false)).toBe(id('draw-one'));
    expect(await pick(true)).toBe(id('removal'));
  });
});

describe('choosing a land', () => {
  it('judges a land by the colours its script says it makes, not its colour identity', async () => {
    // Both colourless by identity; only the prism's script makes red and green.
    const lands = new FakePool(
      [
        { name: 'a-ruins', land: true, produces: [] },
        { name: 'prism', land: true, produces: [] },
      ],
      new Set(),
    );
    // What the prism really makes, which the pool only learns by scripting it.
    const script = lands.script.bind(lands);
    lands.script = async (oracleId) => {
      const card = await script(oracleId);
      return card !== null && oracleId === id('prism') ? { ...card, produces: ['R', 'G'] } : card;
    };
    const change = await agent().chooseChange(
      input({ pool: lands, counts: counts(evenCards(), { screwed: 40 }) }),
    );
    expect(change.add.oracleId).toBe(id('prism'));
  });
});

// --- Trials ---

describe('trials (docs/05 step 3)', () => {
  const weakOgre = () => {
    const cards = evenCards();
    cards[id('ogre')] = record(100, 40, 0.3, 0.55);
    return counts(cards);
  };

  it('plays each finalist’s deck and keeps the one that won most, not the one ranked first', async () => {
    const seen: { deck: Deck75; candidate: OracleId }[] = [];
    const trial: TrialRunner = async (trialDeck, candidate) => {
      seen.push({ deck: trialDeck, candidate });
      return { matches: 20, winRate: candidate === id('hill-giant') ? 0.62 : 0.4 };
    };
    const change = await agent({ trialTopK: 3 }).chooseChange(input({ counts: weakOgre(), trial }));
    expect(seen).toHaveLength(3);
    expect(change.add.oracleId).toBe(id('hill-giant'));
    expect(change.reason).toMatch(
      /for 4 hill-giant \(trial 62% over 20 matches vs 41% this cycle\)$/,
    );
    // Each trial deck is the deck with the ogres replaced by that candidate.
    for (const { deck: trialDeck, candidate } of seen) {
      const main = new Map(trialDeck.main.map((s) => [s.oracleId, s.count]));
      expect(main.has(id('ogre'))).toBe(false);
      expect(main.get(candidate)).toBe(4);
      expect([...main.values()].reduce((a, b) => a + b, 0)).toBe(60);
    }
    const trials = change.evidence.candidates.filter((c) => c.trial !== null);
    expect(trials).toHaveLength(3);
  });

  it('breaks a tie on win rate by the score', async () => {
    const trial: TrialRunner = async () => ({ matches: 20, winRate: 0.5 });
    const change = await agent({ trialTopK: 3 }).chooseChange(input({ counts: weakOgre(), trial }));
    expect(change.add.oracleId).toBe(id('wolf'));
  });

  it('plays no trial when trialTopK is zero', async () => {
    let calls = 0;
    const trial: TrialRunner = async () => {
      calls += 1;
      return { matches: 20, winRate: 1 };
    };
    const change = await agent({ trialTopK: 0 }).chooseChange(input({ counts: weakOgre(), trial }));
    expect(calls).toBe(0);
    expect(change.reason).not.toMatch(/trial/);
  });
});

// --- The change ---

describe('the change it emits', () => {
  it('reads like docs/05’s example, and applies to the deck keeping 60/15', async () => {
    const cards = evenCards();
    // Drawn: 15 of 40 won, shrunk to 0.400; not drawn: 30 of 60, shrunk to 0.4875.
    cards[id('ogre')] = record(100, 40, 0.375, 0.5, { deadInHand: 31 });
    const change = await agent().chooseChange(input({ counts: counts(cards) }));
    expect(change.reason).toBe('Cut 4 ogre (Δ −9%, dead in hand 31%) for 4 wolf');
    const after = applyDeckChange(deck, change);
    const total = (slots: Deck75['main']) => slots.reduce((sum, s) => sum + s.count, 0);
    expect([total(after.main), total(after.side)]).toEqual([60, 15]);
  });

  it('is the same change from the same seed', async () => {
    const cards = evenCards();
    cards[id('ogre')] = record(100, 40, 0.3, 0.55);
    const once = await agent({ temperature: 1 }).chooseChange(
      input({ counts: counts(cards), rng: seeded(7) }),
    );
    const again = await agent({ temperature: 1 }).chooseChange(
      input({ counts: counts(cards), rng: seeded(7) }),
    );
    expect(again).toEqual(once);
  });

  it('refuses a deck holding a card it knows nothing of', () => {
    expect(() => diagnose(input({ cards: new Map() }))).toThrow(/nothing is known/);
  });

  it('adds up counts it is given the way the aggregator does', () => {
    // A sanity check on the fixture: two cycles' counts add.
    expect(addCounts(counts(), counts()).deck.games).toBe(200);
  });
});

// --- Legalisation (roadmap 5.5) ---

describe('legalisation (docs/05 "Bans and restrictions")', () => {
  const legalise = (over: Partial<DeckAgentInput> = {}) => agent().legalise(input(over));
  const banned = (name: string, status: 'banned' | 'restricted' = 'banned'): BanList =>
    new Map([
      [id('banned-beast'), 'banned'],
      [id(name), status],
    ]);

  it('changes nothing, and searches nothing, when the deck is legal', async () => {
    const pool = new FakePool();
    expect(await legalise({ pool })).toEqual([]);
    expect(pool.searches).toEqual([]);
  });

  it('replaces every copy of a banned card with as many of one card, keeping 60/15', async () => {
    const changes = await legalise({ banList: banned('ogre') });
    expect(changes).toHaveLength(1);
    const [change] = changes;
    expect(change?.remove).toEqual({ oracleId: id('ogre'), zone: 'main', count: 4 });
    expect(change?.add.count).toBe(4);
    expect(change?.evidence.diagnosis).toBe('ban');
    expect(change?.reason).toMatch(/^Banned: cut 4 ogre .*for 4 /);
    const legal = changes.reduce((d, c) => applyDeckChange(d, c), deck);
    expect(banViolations(legal, banned('ogre'))).toEqual([]);
    expect(legal.main.reduce((sum, s) => sum + s.count, 0)).toBe(60);
  });

  it('looks in the removed card’s own colours and mana value first', async () => {
    // The wolf is the better card on paper, but it is green and the ogre was red.
    const [change] = await legalise({ banList: banned('ogre') });
    expect(change?.add.oracleId).toBe(id('hill-giant'));
  });

  it('leaves one copy of a restricted card and replaces the rest', async () => {
    const changes = await legalise({ banList: banned('bear', 'restricted') });
    expect(changes).toHaveLength(1);
    expect(changes[0]?.remove).toEqual({ oracleId: id('bear'), zone: 'main', count: 3 });
    expect(changes[0]?.reason).toMatch(/^Restricted to one copy: cut 3 bear/);
    // A hole of three cannot take a card restricted in the base format.
    expect(changes[0]?.add.oracleId).not.toBe(id('relic'));
    const legal = changes.reduce((d, c) => applyDeckChange(d, c), deck);
    expect(legal.main).toContainEqual({ oracleId: id('bear'), count: 1 });
  });

  it('fills a hole of one with a single copy, which may be of a restricted card', async () => {
    const twoBears: Deck75 = {
      main: [
        ...deck.main.filter((s) => s.oracleId !== id('bear') && s.oracleId !== id('mountain')),
        slot('bear', 2),
        slot('mountain', 14),
      ],
      side: deck.side,
    };
    const [change] = await legalise({ deck: twoBears, banList: banned('bear', 'restricted') });
    expect(change?.remove.count).toBe(1);
    expect(change?.add).toEqual({ oracleId: id('relic'), zone: 'main', count: 1 });
  });

  it('takes sideboard copies first, and legalises main and side as separate holes', async () => {
    const split: Deck75 = {
      main: deck.main,
      side: [...deck.side.filter((s) => s.oracleId !== id('pyroclasm')), slot('ogre', 4)],
    };
    // Eight ogres restricted to one: the four in the side go first, then three of the main.
    const changes = await legalise({ deck: split, banList: banned('ogre', 'restricted') });
    expect(changes.map((c) => [c.remove.zone, c.remove.count])).toEqual([
      ['side', 4],
      ['main', 3],
    ]);
    expect(changes[0]?.reason).toMatch(/from the sideboard/);
    const legal = changes.reduce((d, c) => applyDeckChange(d, c), split);
    expect(banViolations(legal, banned('ogre', 'restricted'))).toEqual([]);
    // The second hole is searched knowing what the first took: nothing past four copies.
    const held = new Map<OracleId, number>();
    for (const s of [...legal.main, ...legal.side])
      held.set(s.oracleId, (held.get(s.oracleId) ?? 0) + s.count);
    for (const [oracleId, count] of held) {
      if (!cardsOf(poolMade).get(oracleId)?.basic) expect(count).toBeLessThanOrEqual(4);
    }
    expect(legal.side.reduce((sum, s) => sum + s.count, 0)).toBe(15);
  });

  it('never replaces one banned card with another, nor with a copy the 75 cannot hold', async () => {
    const list: BanList = new Map([
      [id('banned-beast'), 'banned'],
      [id('ogre'), 'banned'],
      [id('hill-giant'), 'banned'],
    ]);
    const [change] = await legalise({ banList: list });
    expect(change?.add.oracleId).not.toBe(id('hill-giant'));
    expect(change?.add.oracleId).not.toBe(id('banned-beast'));
    const legal = applyDeckChange(deck, change as never);
    expect(banViolations(legal, list)).toEqual([]);
  });

  it('plays no trial: legalisation happens between two games and must be quick', async () => {
    let calls = 0;
    const trial: TrialRunner = async () => {
      calls += 1;
      return { matches: 1, winRate: 1 };
    };
    await agent({ trialTopK: 3 }).legalise(input({ banList: banned('ogre'), trial }));
    expect(calls).toBe(0);
  });

  it('fills the hole with a land when nothing of the card’s kind can be played', async () => {
    const lands = new FakePool(poolMade.filter((c) => c.land === true));
    const [change] = await legalise({ banList: banned('ogre'), pool: lands });
    expect(cardsOf(poolMade).get(change?.add.oracleId as OracleId)?.land).toBe(true);
    expect(change?.add.count).toBe(4);
  });

  it('legalises a banned land with a land that makes what it made', async () => {
    const withSnow = new FakePool([
      ...poolMade,
      { name: 'snow-forest', land: true, basic: true, produces: ['G'] },
    ]);
    const [change] = await legalise({ banList: banned('forest'), pool: withSnow });
    expect(change?.remove).toEqual({ oracleId: id('forest'), zone: 'main', count: 12 });
    // Twelve mountains would strand every green spell; the taiga cannot be held twelve times.
    expect(change?.add).toEqual({ oracleId: id('snow-forest'), zone: 'main', count: 12 });
  });
});
