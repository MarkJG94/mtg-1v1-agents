import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StatisticalDeckAgent } from '@mtg/agents';
import {
  autoScripter,
  type CardProjection,
  loadHandScripts,
  MemoryScriptStore,
  type Resolution,
  ScriptResolver,
} from '@mtg/cards';
import { type CardDefinition, createRng } from '@mtg/engine';
import {
  applyDeckChange,
  asOracleId,
  type Deck75,
  type OracleId,
  opponentOf,
  type RunSettings,
} from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { agentsAt, runCycle } from './cycle.js';
import { cardCount, cardsIn } from './deck.js';
import { playMatch } from './match.js';
import { poolCardFor, ScryfallPool } from './pool.js';
import { generateSeedDeck } from './seed-deck.js';
import { deckCardsFor } from './sideboard-cards.js';
import { trials } from './trial.js';

/**
 * The deck agent's ports as `@mtg/sim` provides them (roadmap 5.4) — the Scryfall pool and
 * the trial runner — and the whole change end to end: two seed decks play a cycle, the
 * loser's deck is changed by the agent, and the changed deck plays.
 */

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
const fixture = (name: string) =>
  Object.values(
    JSON.parse(readFileSync(here(`../../cards/fixtures/${name}`), 'utf8')) as Record<
      string,
      CardProjection
    >,
  );
const realPool = [...fixture('scryfall.json'), ...fixture('corpus.json')];

const projection = (oracleId: string, over: Partial<CardProjection> = {}): CardProjection => ({
  id: `print-${oracleId}`,
  oracleId,
  name: oracleId,
  manaCost: '{1}{G}',
  manaValue: 2,
  colors: ['G'],
  colorIdentity: ['G'],
  typeLine: 'Creature — Bear',
  oracleText: '',
  power: '2',
  toughness: '2',
  loyalty: null,
  keywords: [],
  layout: 'normal',
  legalities: { vintage: 'legal', modern: 'not_legal' },
  setCode: 'tst',
  rarity: 'common',
  reserved: false,
  digital: false,
  ...over,
});

/** A resolver that plays every card as a vanilla definition, and counts what it was asked. */
const stubResolver = (unsupported: ReadonlySet<string> = new Set()) => {
  const asked: { oracleId: string; runId: string | undefined; context: string | undefined }[] = [];
  return {
    asked,
    resolve: (card: CardProjection, request?: { runId?: string; context?: string }): Resolution => {
      asked.push({ oracleId: card.oracleId, runId: request?.runId, context: request?.context });
      if (unsupported.has(card.oracleId)) {
        return { status: 'unsupported', definition: null, source: 'auto', reasons: [] };
      }
      const definition: CardDefinition = {
        oracleId: asOracleId(card.oracleId),
        name: card.name,
        manaCost: { generic: 1, variable: 0, symbols: [] },
        types: ['creature'],
        colours: ['G'],
        power: 2,
        toughness: 2,
        abilities: [],
      };
      return { status: 'supported', definition, source: 'hand', reasons: [] };
    },
  };
};

const criteria = {
  land: false,
  colours: ['G', 'R'] as const,
  exclude: new Set<OracleId>(),
  banList: new Map(),
};

describe('the Scryfall pool', () => {
  const cards = [
    projection('bear'),
    projection('bear'), // a second printing of the same card
    projection('goblin', { colorIdentity: ['R'], manaValue: 1 }),
    projection('drake', { colorIdentity: ['U'] }),
    projection('gold', { colorIdentity: ['R', 'G'], manaValue: 4 }),
    projection('digital', { digital: true }),
    projection('modern-only', { legalities: { vintage: 'not_legal', modern: 'legal' } }),
    projection('restricted', { legalities: { vintage: 'restricted' } }),
    projection('dual', { typeLine: 'Land', colorIdentity: ['R', 'G'], manaValue: 0 }),
    projection('forest', { typeLine: 'Basic Land — Forest', manaValue: 0 }),
    projection('star', { power: '*', toughness: '1+*' }),
  ];
  const pool = new ScryfallPool(cards, stubResolver(), 'vintage');
  const ids = (found: readonly { oracleId: string }[]) => found.map((card) => card.oracleId);

  it('holds each card once, and only what the base format allows off paper', () => {
    const all = ids(pool.search({ ...criteria, colours: ['W', 'U', 'B', 'R', 'G'] }));
    expect(all).toEqual(['bear', 'drake', 'goblin', 'gold', 'restricted', 'star']);
    const modern = new ScryfallPool(cards, stubResolver(), 'modern');
    expect(ids(modern.search({ ...criteria, colours: ['G'] }))).toEqual(['modern-only']);
  });

  it('searches by land or not, colour identity, mana value, exclusions and the ban list', () => {
    expect(ids(pool.search({ ...criteria, colours: ['G'] }))).toEqual([
      'bear',
      'restricted',
      'star',
    ]);
    expect(ids(pool.search({ ...criteria, land: true }))).toEqual(['dual', 'forest']);
    expect(ids(pool.search({ ...criteria, manaValue: { min: 3, max: 4 } }))).toEqual(['gold']);
    expect(ids(pool.search({ ...criteria, exclude: new Set([asOracleId('bear')]) }))).not.toContain(
      'bear',
    );
    expect(
      ids(pool.search({ ...criteria, banList: new Map([[asOracleId('goblin'), 'banned']]) })),
    ).not.toContain('goblin');
    expect(
      ids(pool.search({ ...criteria, banList: new Map([[asOracleId('goblin'), 'restricted']]) })),
    ).toContain('goblin');
  });

  it('reads the printed facts the static model prices', () => {
    const bear = poolCardFor(projection('bear'));
    expect([bear.power, bear.toughness, bear.copies, bear.land, bear.basic]).toEqual([
      2,
      2,
      4,
      false,
      false,
    ]);
    const star = poolCardFor(projection('star', { power: '*', toughness: '1+*' }));
    expect([star.power, star.toughness]).toEqual([null, null]);
    expect(poolCardFor(projection('r'), true).copies).toBe(1);
    const forest = poolCardFor(projection('f', { typeLine: 'Basic Land — Forest' }));
    expect([forest.land, forest.basic, forest.copies]).toEqual([true, true, Infinity]);
  });

  it('scripts a card once, keeps its definition, and logs an unplayable one with the run', async () => {
    const resolver = stubResolver(new Set(['goblin']));
    const scripting = new ScryfallPool(cards, resolver, 'vintage', 'run-1');
    expect((await scripting.script(asOracleId('bear')))?.name).toBe('bear');
    expect(await scripting.script(asOracleId('bear'))).not.toBeNull();
    expect(await scripting.script(asOracleId('goblin'))).toBeNull();
    expect(await scripting.script(asOracleId('drake'))).not.toBeNull();
    expect(await scripting.script(asOracleId('digital'))).toBeNull();
    expect(resolver.asked.map((a) => a.oracleId)).toEqual(['bear', 'goblin', 'drake']);
    expect(resolver.asked.every((a) => a.runId === 'run-1' && a.context === 'deck change')).toBe(
      true,
    );
    expect([...scripting.definitions().keys()]).toEqual(['bear', 'drake']);
  });
});

// --- End to end ---

const settings: RunSettings = {
  seed: '1',
  matchesPerCycle: 4,
  tieMargin: 0.04,
  tiebreakMatches: 0,
  changeSize: 'slot',
  shortlistSize: 12,
  trialTopK: 2,
  trialMatches: 2,
  turnCap: 30,
  agentLevel: 'greedy',
  maxSideboardSwaps: 4,
  seedDeck: 'constrainedRandom',
  seedDeckColours: [],
  seedDeckLands: 24,
  seedDeckLandsJitter: 2,
  legalityFilter: 'vintage',
};

describe('a deck change, end to end over the committed fixtures', async () => {
  const store = new MemoryScriptStore();
  const resolver = new ScriptResolver({
    hand: loadHandScripts(here('../../cards/scripts')),
    auto: autoScripter,
    store,
    skipSmokeTest: true,
  });
  const seeds = {
    A: generateSeedDeck({ pool: realPool, resolver, seed: 'change-A', settings }),
    B: generateSeedDeck({ pool: realPool, resolver, seed: 'change-B', settings }),
  };
  const decks = { A: seeds.A.deck, B: seeds.B.deck };
  const known = new Map([...seeds.A.definitions, ...seeds.B.definitions]);
  const cycle = runCycle({
    decks,
    definitions: known,
    seed: 'change-cycle',
    settings,
    agents: agentsAt('greedy'),
  });
  const loser = cycle.loser;
  const opponent = opponentOf(loser);
  const pool = new ScryfallPool(realPool, resolver, 'vintage', 'run-e2e');
  const definitions = () => new Map([...known, ...pool.definitions()]);
  const trialRunner = trials({
    opponent: decks[opponent],
    definitions,
    agents: agentsAt('greedy'),
    matches: settings.trialMatches,
    settings,
    seed: 'change-trial',
  });
  const cardsOf = (deck: Deck75) =>
    deckCardsFor(
      [...cardsIn(deck).keys()].flatMap((id) => {
        const definition = known.get(id);
        return definition === undefined ? [] : [definition];
      }),
    );
  const shown = cycle.shown[opponent];
  const change = await new StatisticalDeckAgent({
    shortlistSize: settings.shortlistSize,
    trialTopK: settings.trialTopK,
  }).chooseChange({
    deck: decks[loser],
    cards: cardsOf(decks[loser]),
    counts: cycle.stats[loser],
    opponent: {
      seen: shown,
      cards: deckCardsFor(
        shown.flatMap((slot) => {
          const definition = known.get(slot.oracleId);
          return definition === undefined ? [] : [definition];
        }),
      ),
    },
    banList: new Map(),
    pool,
    rng: createRng('change'),
    trial: trialRunner.run,
    cycleWinRate: cycle.winRate[loser],
  });
  const changed = applyDeckChange(decks[loser], change);

  it('shows each deck only its own cards, and adds the matches’ showings up', () => {
    for (const player of ['A', 'B'] as const) {
      const own = cardsIn(decks[player]);
      for (const slot of cycle.shown[player]) expect(own.has(slot.oracleId)).toBe(true);
      const summed = cycle.matches.reduce((sum, match) => sum + cardCount(match.shown[player]), 0);
      expect(cardCount(cycle.shown[player])).toBe(summed);
      expect(summed).toBeGreaterThan(0);
    }
  });

  it('changes one slot of the loser’s deck for a card the engine can play, keeping 60/15', () => {
    expect(cardCount(changed.main)).toBe(60);
    expect(cardCount(changed.side)).toBe(15);
    expect(cardsIn(decks[loser]).has(change.remove.oracleId)).toBe(true);
    if (change.shape === 'replace') {
      expect(definitions().has(change.add.oracleId)).toBe(true);
      const added = realPool.find((card) => card.oracleId === change.add.oracleId);
      expect(added?.legalities.vintage).toMatch(/legal|restricted/);
    }
    for (const [, count] of cardsIn(changed)) expect(count).toBeGreaterThan(0);
  });

  it('says why in words, and keeps the shortlist and the trials as evidence', () => {
    expect(change.reason.length).toBeGreaterThan(10);
    expect(change.evidence.deck.games).toBe(
      cycle.matches.reduce((sum, match) => sum + match.games.length, 0),
    );
    if (change.shape === 'replace') {
      expect(change.evidence.candidates.length).toBeGreaterThan(0);
      expect(change.evidence.candidates.length).toBeLessThanOrEqual(settings.shortlistSize);
      const trialled = change.evidence.candidates.filter((candidate) => candidate.trial !== null);
      expect(trialled.length).toBeGreaterThan(0);
      for (const candidate of trialled) {
        expect(candidate.supported).toBe(true);
        expect(trialRunner.countsFor(candidate.oracleId)?.deck.games).toBeGreaterThan(0);
      }
    }
  });

  it('plays: the changed deck goes through a whole match', () => {
    const match = playMatch({
      players: {
        A: { deck: changed, agent: agentsAt('greedy')('A', {}) },
        B: { deck: decks[opponent], agent: agentsAt('greedy')('B', {}) },
      },
      definitions: definitions(),
      seed: 'after-change',
      firstChooser: 'A',
      turnCap: 30,
    });
    for (const game of match.games) expect(game.result).not.toBeNull();
  });

  it('logs every card the change could not script as a request from the run', () => {
    const unplayable = change.evidence.candidates.filter((c) => c.supported === false);
    const logged = store
      .unsupportedRequests()
      .filter((request) => request.runId === 'run-e2e' && request.context === 'deck change');
    for (const candidate of unplayable) {
      expect(logged.some((request) => request.oracleId === candidate.oracleId)).toBe(true);
    }
  });
});
