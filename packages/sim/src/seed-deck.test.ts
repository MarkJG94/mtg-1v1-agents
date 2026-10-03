import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defaultWeights, greedyAgent } from '@mtg/agents';
import {
  autoScripter,
  type CardProjection,
  loadHandScripts,
  MemoryScriptStore,
  type RequestContext,
  type Resolution,
  ScriptResolver,
} from '@mtg/cards';
import { type CardDefinition, createRng } from '@mtg/engine';
import { asOracleId, type BanList, type Colour } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { cardCount, cardsIn } from './deck.js';
import { playMatch } from './match.js';
import {
  generateSeedDeck,
  isBasicLand,
  isLandCard,
  isPlainBasic,
  type SeedDeck,
  SeedDeckError,
  type SeedDeckOptions,
} from './seed-deck.js';

/**
 * The seed deck generator (docs/05 "Seed deck generation", decision D17; roadmap 5.3).
 *
 * Most of these run over a made-up pool with a resolver that is told which cards it can
 * play, so each rule can be pushed to its edge cheaply. The last group runs the real
 * resolver over the committed Scryfall fixtures and plays a match with what it makes.
 */

const card = (
  oracleId: string,
  over: Partial<CardProjection> & { identity?: string[] } = {},
): CardProjection => {
  const { identity, ...rest } = over;
  return {
    id: `print-${oracleId}`,
    oracleId,
    name: oracleId,
    manaCost: null,
    manaValue: 2,
    colors: identity ?? [],
    colorIdentity: identity ?? [],
    typeLine: 'Creature — Bear',
    oracleText: '',
    power: '2',
    toughness: '2',
    loyalty: null,
    keywords: [],
    layout: 'normal',
    legalities: { vintage: 'legal', modern: 'legal' },
    setCode: 'tst',
    rarity: 'common',
    reserved: false,
    digital: false,
    ...rest,
  };
};

const basicNames: Record<Colour, string> = {
  W: 'Plains',
  U: 'Island',
  B: 'Swamp',
  R: 'Mountain',
  G: 'Forest',
};
const basics = (Object.entries(basicNames) as [Colour, string][]).map(([colour, type]) =>
  card(`basic-${colour}`, { typeLine: `Basic Land — ${type}`, identity: [colour], manaValue: 0 }),
);

/** Twenty spells of each colour at mana values 1 to 7, some gold, some colourless, some lands. */
const spells = (['W', 'U', 'B', 'R', 'G'] as const).flatMap((colour) =>
  Array.from({ length: 20 }, (_, i) =>
    card(`${colour}-spell-${String(i).padStart(2, '0')}`, {
      identity: [colour],
      manaValue: (i % 7) + 1,
    }),
  ),
);
const gold = [
  card('gold-WU', { identity: ['W', 'U'] }),
  card('gold-BR', { identity: ['B', 'R'] }),
  card('gold-RG', { identity: ['R', 'G'] }),
];
const colourless = Array.from({ length: 6 }, (_, i) =>
  card(`artifact-${i}`, { typeLine: 'Artifact', manaValue: i }),
);
const nonbasics = [
  card('dual-WU', { typeLine: 'Land', identity: ['W', 'U'], manaValue: 0 }),
  card('dual-BR', { typeLine: 'Land', identity: ['B', 'R'], manaValue: 0 }),
  card('dual-RG', { typeLine: 'Land', identity: ['R', 'G'], manaValue: 0 }),
  card('colourless-land', { typeLine: 'Land', manaValue: 0 }),
];
const pool = [...basics, ...spells, ...gold, ...colourless, ...nonbasics];

/** A resolver that can play everything except what it is told it cannot. */
const stubResolver = (unsupported: ReadonlySet<string> = new Set()) => {
  const asked: string[] = [];
  const contexts: string[] = [];
  return {
    asked,
    contexts,
    resolve: (projection: CardProjection, request?: RequestContext): Resolution => {
      asked.push(projection.oracleId);
      contexts.push(`${projection.oracleId} ${request?.context ?? ''}`);
      return unsupported.has(projection.oracleId)
        ? { status: 'unsupported', definition: null, source: 'auto', reasons: [] }
        : {
            status: 'supported',
            definition: { oracleId: projection.oracleId } as unknown as CardDefinition,
            source: 'hand',
            reasons: [],
          };
    },
  };
};

const settings: SeedDeckOptions['settings'] = {
  seedDeckColours: [],
  seedDeckLands: 24,
  seedDeckLandsJitter: 2,
  legalityFilter: 'vintage',
};

const generate = (over: Partial<SeedDeckOptions> = {}): SeedDeck =>
  generateSeedDeck({ pool, resolver: stubResolver(), seed: 'seed', settings, ...over });

const byId = new Map(pool.map((c) => [c.oracleId, c]));
const projectionOf = (oracleId: string): CardProjection => {
  const found = byId.get(oracleId);
  if (found === undefined) throw new Error(`no card ${oracleId}`);
  return found;
};

/** Every card in the 75 with its count, main and side together. */
const all = (seed: SeedDeck) => [...cardsIn(seed.deck)];

describe('the shape of a seed deck', () => {
  const seeds = Array.from({ length: 40 }, (_, i) => `shape-${i}`);
  const decks = seeds.map((seed) => generate({ seed }));

  it('is sixty in the main and fifteen in the side (docs/05)', () => {
    for (const seed of decks) {
      expect(cardCount(seed.deck.main)).toBe(60);
      expect(cardCount(seed.deck.side)).toBe(15);
    }
  });

  it('holds no more than four of a name across the 75, basics aside (CR 100.2a)', () => {
    for (const seed of decks) {
      for (const [oracleId, count] of all(seed)) {
        if (!isPlainBasic(projectionOf(oracleId))) expect(count).toBeLessThanOrEqual(4);
      }
    }
  });

  it('holds only cards whose colour identity is within its colours', () => {
    for (const seed of decks) {
      for (const [oracleId] of all(seed)) {
        for (const colour of projectionOf(oracleId).colorIdentity) {
          expect(seed.colours).toContain(colour);
        }
      }
    }
  });

  it('plays seedDeckLands lands, give or take the jitter, and the lands are all in the main', () => {
    for (const seed of decks) {
      const lands = seed.deck.main
        .filter((slot) => isLandCard(projectionOf(slot.oracleId)))
        .reduce((sum, slot) => sum + slot.count, 0);
      expect(lands).toBe(seed.lands);
      expect(seed.lands).toBeGreaterThanOrEqual(22);
      expect(seed.lands).toBeLessThanOrEqual(26);
      expect(seed.deck.side.some((slot) => isLandCard(projectionOf(slot.oracleId)))).toBe(false);
    }
    // And the jitter is used: not every deck plays the same number.
    expect(new Set(decks.map((seed) => seed.lands)).size).toBeGreaterThan(2);
  });

  it('makes no more than 40% of its lands nonbasic, and some decks do play them', () => {
    for (const seed of decks) {
      const nonbasic = seed.deck.main
        .filter((slot) => {
          const projection = projectionOf(slot.oracleId);
          return isLandCard(projection) && !isPlainBasic(projection);
        })
        .reduce((sum, slot) => sum + slot.count, 0);
      expect(nonbasic).toBe(seed.nonbasicLands);
      expect(nonbasic).toBeLessThanOrEqual(Math.floor(seed.lands * 0.4));
    }
    expect(decks.some((seed) => seed.nonbasicLands > 0)).toBe(true);
  });

  it('reaches, and never passes, 40% nonbasic when the pool has lands to spare', () => {
    const wastes = Array.from({ length: 30 }, (_, i) =>
      card(`waste-${i}`, { typeLine: 'Land', manaValue: 0 }),
    );
    const shares = Array.from({ length: 40 }, (_, i) => {
      const seed = generate({ seed: `share-${i}`, pool: [...pool, ...wastes] });
      expect(seed.nonbasicLands).toBeLessThanOrEqual(Math.floor(seed.lands * 0.4));
      return seed.nonbasicLands / seed.lands;
    });
    expect(Math.max(...shares)).toBeGreaterThan(0.35);
  });

  it('splits its basics evenly across its colours', () => {
    for (const seed of decks) {
      const perColour = seed.colours.map(
        (colour) => seed.deck.main.find((slot) => slot.oracleId === `basic-${colour}`)?.count ?? 0,
      );
      expect(Math.max(...perColour) - Math.min(...perColour)).toBeLessThanOrEqual(1);
      expect(perColour.reduce((a, b) => a + b, 0)).toBe(seed.lands - seed.nonbasicLands);
    }
  });

  it('plays no more than eight cards costing five or more in the main (docs/05)', () => {
    const expensive = decks.map((seed) =>
      seed.deck.main
        .filter((slot) => projectionOf(slot.oracleId).manaValue >= 5)
        .reduce((sum, slot) => sum + slot.count, 0),
    );
    for (const count of expensive) expect(count).toBeLessThanOrEqual(8);
    // Three in seven of this pool's spells cost five or more, so the cap is what holds it.
    expect(expensive).toContain(8);
  });

  it('sideboards names the main deck did not take, while the pool has them', () => {
    for (const seed of decks) {
      const main = new Set(seed.deck.main.map((slot) => slot.oracleId));
      for (const slot of seed.deck.side) expect(main.has(slot.oracleId)).toBe(false);
    }
  });

  it('hands back a definition for every card in the 75, and nothing else', () => {
    for (const seed of decks) {
      expect([...seed.definitions.keys()].sort()).toEqual(
        all(seed)
          .map(([id]) => id)
          .sort(),
      );
    }
  });
});

describe('the dice', () => {
  it('is a pure function of pool, settings and seed, whatever order the pool arrives in', () => {
    const first = generate({ seed: 'same' });
    const shuffled = createRng('order').shuffled(pool);
    const again = generate({ seed: 'same', pool: shuffled });
    expect(again.deck).toEqual(first.deck);
    expect(again.colours).toEqual(first.colours);
    expect(generate({ seed: 'other' }).deck).not.toEqual(first.deck);
  });

  it('rolls one, two or three colours, about 30/50/20 (docs/05)', () => {
    const counts = [0, 0, 0, 0];
    const n = 400;
    for (let i = 0; i < n; i += 1) {
      const seed = generate({ seed: `colours-${i}` });
      counts[seed.colours.length] = (counts[seed.colours.length] ?? 0) + 1;
    }
    expect(counts[0]).toBe(0);
    // Three standard errors either side of 0.3, 0.5 and 0.2 at n = 400.
    expect((counts[1] ?? 0) / n).toBeGreaterThan(0.23);
    expect((counts[1] ?? 0) / n).toBeLessThan(0.37);
    expect((counts[2] ?? 0) / n).toBeGreaterThan(0.42);
    expect((counts[2] ?? 0) / n).toBeLessThan(0.58);
    expect((counts[3] ?? 0) / n).toBeGreaterThan(0.14);
    expect((counts[3] ?? 0) / n).toBeLessThan(0.26);
  });

  it('draws every colour, and a deck’s colours are distinct and in WUBRG order', () => {
    const seen = new Set<Colour>();
    for (let i = 0; i < 60; i += 1) {
      const { colours } = generate({ seed: `order-${i}` });
      for (const colour of colours) seen.add(colour);
      expect(new Set(colours).size).toBe(colours.length);
      expect([...colours].sort((a, b) => 'WUBRG'.indexOf(a) - 'WUBRG'.indexOf(b))).toEqual(colours);
    }
    expect(seen.size).toBe(5);
  });

  it('gives cheap cards more copies than expensive ones', () => {
    const copies = { cheap: [] as number[], dear: [] as number[] };
    for (let i = 0; i < 60; i += 1) {
      const seed = generate({ seed: `copies-${i}` });
      for (const slot of seed.deck.main) {
        const projection = projectionOf(slot.oracleId);
        if (isLandCard(projection)) continue;
        if (projection.manaValue <= 2) copies.cheap.push(slot.count);
        if (projection.manaValue >= 5) copies.dear.push(slot.count);
      }
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    // Weights 1:1:2:4 give a mean of 3.125 copies; 1:1:1:1 gives 2.5, less any the curve cut.
    expect(mean(copies.cheap)).toBeGreaterThan(2.9);
    expect(mean(copies.dear)).toBeLessThan(2.6);
  });
});

describe('the run’s settings', () => {
  it('keeps the colours the run names', () => {
    for (let i = 0; i < 10; i += 1) {
      expect(
        generate({ seed: `named-${i}`, settings: { ...settings, seedDeckColours: ['G', 'B'] } })
          .colours,
      ).toEqual(['B', 'G']);
    }
  });

  it('refuses a colour list that names a colour twice, or more than three', () => {
    expect(() => generate({ settings: { ...settings, seedDeckColours: ['R', 'R'] } })).toThrow(
      SeedDeckError,
    );
    expect(() =>
      generate({ settings: { ...settings, seedDeckColours: ['W', 'U', 'B', 'R'] } }),
    ).toThrow(SeedDeckError);
  });

  it('plays exactly seedDeckLands with no jitter', () => {
    for (let i = 0; i < 10; i += 1) {
      const seed = generate({
        seed: `exact-${i}`,
        settings: { ...settings, seedDeckLands: 17, seedDeckLandsJitter: 0 },
      });
      expect(seed.lands).toBe(17);
    }
  });

  it('draws from the base format the run names, and never a digital-only card', () => {
    const modernOnly = card('modern-only', {
      identity: ['R'],
      legalities: { vintage: 'not_legal', modern: 'legal' },
    });
    const digital = card('digital', { identity: ['R'], digital: true });
    const redPool = [
      ...pool.filter((c) => c.colorIdentity.every((colour) => colour === 'R')),
      modernOnly,
      digital,
    ];
    const red = { ...settings, seedDeckColours: ['R'] as Colour[] };
    for (let i = 0; i < 20; i += 1) {
      const vintage = generate({ seed: `format-${i}`, pool: redPool, settings: red });
      expect(cardsIn(vintage.deck).has(asOracleId('modern-only'))).toBe(false);
      expect(cardsIn(vintage.deck).has(asOracleId('digital'))).toBe(false);
    }
    const inModern = Array.from({ length: 20 }, (_, i) =>
      generate({
        seed: `format-${i}`,
        pool: redPool,
        settings: { ...red, legalityFilter: 'modern' },
      }),
    );
    expect(inModern.some((seed) => cardsIn(seed.deck).has(asOracleId('modern-only')))).toBe(true);
  });

  it('plays a card restricted in the base format once at most', () => {
    const restricted = card('restricted', {
      identity: ['R'],
      manaValue: 1,
      legalities: { vintage: 'restricted' },
    });
    const small = [
      ...pool.filter((c) => c.colorIdentity.every((colour) => colour === 'R')),
      restricted,
    ];
    let seenIt = false;
    for (let i = 0; i < 40; i += 1) {
      const seed = generate({
        seed: `restricted-${i}`,
        pool: small,
        settings: { ...settings, seedDeckColours: ['R'] },
      });
      const count = cardsIn(seed.deck).get(asOracleId('restricted')) ?? 0;
      expect(count).toBeLessThanOrEqual(1);
      if (count === 1) seenIt = true;
    }
    expect(seenIt).toBe(true);
  });
});

describe('the ban list (docs/05 "Bans and restrictions")', () => {
  const red = { ...settings, seedDeckColours: ['R'] as Colour[] };
  const redPool = pool.filter((c) => c.colorIdentity.every((colour) => colour === 'R'));
  const cheapRed = redPool.filter((c) => !isLandCard(c) && c.manaValue <= 2).map((c) => c.oracleId);

  it('never plays a banned card', () => {
    const banList: BanList = new Map(cheapRed.map((id) => [asOracleId(id), 'banned']));
    for (let i = 0; i < 20; i += 1) {
      const seed = generate({ seed: `banned-${i}`, pool: redPool, settings: red, banList });
      for (const id of cheapRed) expect(cardsIn(seed.deck).has(asOracleId(id))).toBe(false);
    }
  });

  it('plays a restricted card once at most across the 75', () => {
    const banList: BanList = new Map(cheapRed.map((id) => [asOracleId(id), 'restricted']));
    let restrictedPlayed = 0;
    for (let i = 0; i < 20; i += 1) {
      const seed = generate({ seed: `restricted-${i}`, pool: redPool, settings: red, banList });
      for (const id of cheapRed) {
        const count = cardsIn(seed.deck).get(asOracleId(id)) ?? 0;
        expect(count).toBeLessThanOrEqual(1);
        restrictedPlayed += count;
      }
    }
    expect(restrictedPlayed).toBeGreaterThan(0);
  });

  it('refuses to build when the basic land a colour needs is restricted', () => {
    const banList: BanList = new Map([[asOracleId('basic-R'), 'restricted']]);
    expect(() => generate({ pool: redPool, settings: red, banList })).toThrow(
      /limited by the ban list/,
    );
  });

  it('refuses to build when the basic land a colour needs is banned', () => {
    const banList: BanList = new Map([[asOracleId('basic-R'), 'banned']]);
    expect(() => generate({ pool: redPool, settings: red, banList })).toThrow(SeedDeckError);
  });
});

describe('re-rolling what the engine cannot play', () => {
  it('re-rolls every unsupported card it draws, and lists each one once, where it was drawn', () => {
    const unsupported = new Set(
      pool.filter((c) => !isPlainBasic(c) && c.oracleId.endsWith('0')).map((c) => c.oracleId),
    );
    unsupported.add('dual-RG');
    let rerolls = 0;
    const sections = new Set<string>();
    for (let i = 0; i < 30; i += 1) {
      const resolver = stubResolver(unsupported);
      const seed = generateSeedDeck({ pool, resolver, seed: `reroll-${i}`, settings });
      for (const [id] of all(seed)) expect(unsupported.has(id)).toBe(false);
      expect(cardCount(seed.deck.main)).toBe(60);
      for (const reroll of seed.rerolled) {
        expect(unsupported.has(reroll.oracleId)).toBe(true);
        // A land is re-rolled while the lands are drawn; a spell, while main or side is.
        if (isLandCard(projectionOf(reroll.oracleId))) expect(reroll.section).toBe('lands');
        else expect(['main', 'side']).toContain(reroll.section);
        // And the resolver was told where, which is what its unsupported log records.
        expect(resolver.contexts).toContain(`${reroll.oracleId} seed deck (${reroll.section})`);
      }
      expect(new Set(seed.rerolled.map((r) => r.oracleId)).size).toBe(seed.rerolled.length);
      // Every card it asked about is either in the deck or was re-rolled: nothing lost.
      const asked = new Set(resolver.asked);
      const accounted = new Set([
        ...all(seed).map(([id]) => id),
        ...seed.rerolled.map((r) => r.oracleId),
      ]);
      expect(asked).toEqual(accounted);
      rerolls += seed.rerolled.length;
      for (const reroll of seed.rerolled) sections.add(reroll.section);
    }
    expect(rerolls).toBeGreaterThan(0);
    expect(sections).toEqual(new Set(['lands', 'main', 'side']));
  });

  it('does not ask the resolver about a card it had no room to play', () => {
    // Every red spell costs five or more; once eight are in, the rest are skipped unasked.
    const dear = Array.from({ length: 30 }, (_, i) =>
      card(`dear-${i}`, { identity: ['R'], manaValue: 5 + (i % 3) }),
    );
    const cheap = Array.from({ length: 12 }, (_, i) =>
      card(`cheap-${i}`, { identity: ['R'], manaValue: 1 }),
    );
    const resolver = stubResolver();
    const seed = generateSeedDeck({
      pool: [basics[3] as CardProjection, ...dear, ...cheap],
      resolver,
      seed: 'skip',
      settings: { ...settings, seedDeckColours: ['R'], seedDeckLandsJitter: 0 },
    });
    const dearInMain = seed.deck.main
      .filter((slot) => slot.oracleId.startsWith('dear-'))
      .reduce((sum, slot) => sum + slot.count, 0);
    expect(dearInMain).toBe(8);
    const askedMain = resolver.asked.filter((id) => id.startsWith('dear-'));
    const inDeck = new Set(all(seed).map(([id]) => id));
    for (const id of askedMain) expect(inDeck.has(asOracleId(id))).toBe(true);
  });
});

describe('a pool too small to fill a deck', () => {
  const tiny = (names: number) => [
    basics[0] as CardProjection,
    ...Array.from({ length: names }, (_, i) =>
      card(`tiny-${i}`, { identity: ['W'], manaValue: 1 }),
    ),
  ];
  const white = { ...settings, seedDeckColours: ['W'] as Colour[], seedDeckLandsJitter: 0 };

  it('tops up the names it drew before giving up: 51 spells from thirteen names of four', () => {
    // Thirteen names hold 52 at four apiece; drawn at one to four copies they fall short.
    for (let i = 0; i < 10; i += 1) {
      const seed = generate({ seed: `tiny-${i}`, pool: tiny(13), settings: white });
      expect(cardCount(seed.deck.main)).toBe(60);
      expect(cardCount(seed.deck.side)).toBe(15);
    }
  });

  it('says so when even four of every name will not fill the main deck', () => {
    expect(() => generate({ pool: tiny(8), settings: white })).toThrow(/main deck: 32 of 36/);
  });

  it('says so when what is left will not fill the sideboard', () => {
    // Ten names hold 40: enough for the main deck's 36, not for fifteen more.
    expect(() => generate({ pool: tiny(10), settings: white })).toThrow(/sideboard: 4 of 15/);
  });

  it('sideboards more copies of a main-deck card when it has run out of names', () => {
    const seed = generate({ seed: 'tiny-side', pool: tiny(13), settings: white });
    const main = new Set(seed.deck.main.map((slot) => slot.oracleId));
    expect(seed.deck.side.some((slot) => main.has(slot.oracleId))).toBe(true);
    for (const [oracleId, count] of cardsIn(seed.deck)) {
      if (oracleId !== 'basic-W') expect(count).toBeLessThanOrEqual(4);
    }
  });

  it('says so when a colour has no basic land', () => {
    expect(() => generate({ pool: tiny(20).slice(1), settings: white })).toThrow(
      /no playable basic land for W/,
    );
  });
});

describe('what counts as a land', () => {
  it('reads the front face: a spell with a land on its back is a spell', () => {
    expect(isLandCard(card('mdfc', { typeLine: 'Sorcery // Land' }))).toBe(false);
    expect(isLandCard(card('land-back', { typeLine: 'Land // Creature — Elf' }))).toBe(true);
    expect(isLandCard(card('artifact-land', { typeLine: 'Artifact Land' }))).toBe(true);
    expect(isLandCard(card('landfall', { typeLine: 'Creature — Elemental Landfall' }))).toBe(false);
  });

  it('takes a plain basic for the basics, and never counts a snow basic as nonbasic', () => {
    expect(isPlainBasic(card('b', { typeLine: 'Basic Land — Forest' }))).toBe(true);
    expect(isPlainBasic(card('s', { typeLine: 'Basic Snow Land — Forest' }))).toBe(false);
    expect(isPlainBasic(card('n', { typeLine: 'Land — Forest Plains' }))).toBe(false);
    expect(isBasicLand(card('s', { typeLine: 'Basic Snow Land — Forest' }))).toBe(true);
    expect(isBasicLand(card('n', { typeLine: 'Land — Forest Plains' }))).toBe(false);

    const snowForest = card('0-snow-forest', {
      typeLine: 'Basic Snow Land — Forest',
      identity: ['G'],
      manaValue: 0,
    });
    const seed = generate({
      pool: [snowForest, ...pool],
      settings: { ...settings, seedDeckColours: ['G'] },
    });
    expect(cardsIn(seed.deck).has(asOracleId('basic-G'))).toBe(true);

    // Snow-Covered Wastes-alike: colourless, so it fits every deck, but it is a basic land
    // (CR 205.4c) and the nonbasic draw is not the place for it.
    const snowWastes = card('snow-wastes', {
      typeLine: 'Basic Snow Land',
      identity: [],
      manaValue: 0,
    });
    for (let i = 0; i < 30; i += 1) {
      const withSnow = generate({ seed: `snow-${i}`, pool: [snowWastes, ...pool] });
      expect(cardsIn(withSnow.deck).has(asOracleId('snow-wastes'))).toBe(false);
    }
  });
});

// --- The real thing ---

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
const fixture = (name: string) =>
  Object.values(
    JSON.parse(readFileSync(here(`../../cards/fixtures/${name}`), 'utf8')) as Record<
      string,
      CardProjection
    >,
  );

describe('over the committed Scryfall fixtures, with the real resolver', () => {
  const realPool = [...fixture('scryfall.json'), ...fixture('corpus.json')];
  const store = new MemoryScriptStore();
  const resolver = new ScriptResolver({
    hand: loadHandScripts(here('../../cards/scripts')),
    auto: autoScripter,
    store,
    skipSmokeTest: true,
  });
  const seeds = ['real-0', 'real-1', 'real-2', 'real-3'].map((seed) =>
    generateSeedDeck({ pool: realPool, resolver, seed, settings, runId: 'test-run' }),
  );

  it('makes a legal 75 out of cards the engine can play, re-rolling the rest', () => {
    for (const seed of seeds) {
      expect(cardCount(seed.deck.main)).toBe(60);
      expect(cardCount(seed.deck.side)).toBe(15);
      for (const [oracleId] of cardsIn(seed.deck)) {
        expect(
          resolver.resolve(realPool.find((c) => c.oracleId === oracleId) as CardProjection).status,
        ).toBe('supported');
      }
    }
    expect(seeds.some((seed) => seed.rerolled.length > 0)).toBe(true);
  });

  it('logs every re-roll as an unsupported request, tagged with the run', () => {
    const logged = store.unsupportedRequests().filter((request) => request.runId === 'test-run');
    const rerolled = new Set(seeds.flatMap((seed) => seed.rerolled.map((r) => r.oracleId)));
    for (const oracleId of rerolled) {
      expect(logged.some((request) => request.oracleId === oracleId)).toBe(true);
    }
    for (const request of logged)
      expect(request.context).toMatch(/^seed deck \((lands|main|side)\)$/);
  });

  it('plays: two seed decks go through a whole match', async () => {
    const [a, b] = seeds;
    if (a === undefined || b === undefined) throw new Error('two decks');
    const definitions = new Map([...a.definitions, ...b.definitions]);
    const match = await playMatch({
      players: {
        A: { deck: a.deck, agent: greedyAgent(defaultWeights) },
        B: { deck: b.deck, agent: greedyAgent(defaultWeights) },
      },
      definitions,
      seed: 'seed-deck-match',
      firstChooser: 'A',
      turnCap: 40,
    });
    expect(match.games.length).toBeGreaterThanOrEqual(2);
    for (const game of match.games) expect(game.result).not.toBeNull();
  });
});
