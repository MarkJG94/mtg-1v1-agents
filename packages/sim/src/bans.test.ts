import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StatisticalDeckAgent } from '@mtg/agents';
import {
  autoScripter,
  type CardProjection,
  loadHandScripts,
  MemoryScriptStore,
  ScriptResolver,
} from '@mtg/cards';
import {
  asOracleId,
  banViolations,
  type Deck75,
  type OracleId,
  type RunSettings,
} from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { BanRegistry, banEnforcer } from './bans.js';
import { agentsAt, runCycle } from './cycle.js';
import { cardCount, cardsIn } from './deck.js';
import { ScryfallPool } from './pool.js';
import { generateSeedDeck } from './seed-deck.js';

/**
 * Bans and legalisation (docs/05 "Bans and restrictions"; roadmap 5.5): the audit trail,
 * edits that wait for the game in progress to end, and decks legalised by the deck agent
 * while the match goes on.
 */

const id = asOracleId;
const at = '2026-09-26T12:00:00.000Z';

describe('the audit trail', () => {
  it('keeps an edit pending, and out of the list, until a game ends', () => {
    const registry = new BanRegistry();
    registry.request(id('lotus'), 'ban', { by: 'operator', at, note: 'too strong' });
    expect(registry.pending).toHaveLength(1);
    expect(registry.list.size).toBe(0);

    const applied = registry.applyPending('match-0:game-2');
    expect(applied).toEqual([
      {
        oracleId: id('lotus'),
        action: 'ban',
        note: 'too strong',
        by: 'operator',
        at,
        appliedAfterGameId: 'match-0:game-2',
      },
    ]);
    expect(registry.pending).toEqual([]);
    expect(registry.list.get(id('lotus'))).toBe('banned');
  });

  it('keeps every edit, in order, including those undone later', () => {
    const registry = new BanRegistry();
    registry.request(id('lotus'), 'ban', { by: 'a', at });
    registry.applyPending('g1');
    registry.request(id('lotus'), 'unban', { by: 'b', at });
    registry.request(id('recall'), 'restrict', { by: 'b', at });
    registry.applyPending('g2');
    expect(
      registry.history.map((event) => [event.oracleId, event.action, event.appliedAfterGameId]),
    ).toEqual([
      [id('lotus'), 'ban', 'g1'],
      [id('lotus'), 'unban', 'g2'],
      [id('recall'), 'restrict', 'g2'],
    ]);
    expect([...registry.list]).toEqual([[id('recall'), 'restricted']]);
    // The history handed out is a copy: nobody rewrites the trail from outside.
    const copy = registry.history as unknown as unknown[];
    copy.pop();
    expect(registry.history).toHaveLength(3);
  });

  it('resumes from a stored trail', () => {
    const registry = new BanRegistry([
      { oracleId: id('lotus'), action: 'ban', note: '', by: 'a', at, appliedAfterGameId: 'g1' },
      { oracleId: id('recall'), action: 'ban', note: '', by: 'a', at, appliedAfterGameId: null },
    ]);
    expect([...registry.list]).toEqual([[id('lotus'), 'banned']]);
    expect(registry.pending.map((event) => event.oracleId)).toEqual([id('recall')]);
  });
});

// --- Enforcement, over the committed fixtures ---

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
const fixture = (name: string) =>
  Object.values(
    JSON.parse(readFileSync(here(`../../cards/fixtures/${name}`), 'utf8')) as Record<
      string,
      CardProjection
    >,
  );
const realPool = [...fixture('scryfall.json'), ...fixture('corpus.json')];

const settings: RunSettings = {
  seed: '1',
  matchesPerCycle: 2,
  tieMargin: 0.04,
  tiebreakMatches: 0,
  changeSize: 'slot',
  shortlistSize: 8,
  trialTopK: 0,
  trialMatches: 1,
  turnCap: 30,
  agentLevel: 'greedy',
  maxSideboardSwaps: 4,
  seedDeck: 'constrainedRandom',
  seedDeckColours: [],
  seedDeckLands: 24,
  seedDeckLandsJitter: 2,
  legalityFilter: 'vintage',
};

const resolver = new ScriptResolver({
  hand: loadHandScripts(here('../../cards/scripts')),
  auto: autoScripter,
  store: new MemoryScriptStore(),
  skipSmokeTest: true,
});
const seeds = {
  A: generateSeedDeck({ pool: realPool, resolver, seed: 'bans-A', settings }),
  B: generateSeedDeck({ pool: realPool, resolver, seed: 'bans-B', settings }),
};
const decks = { A: seeds.A.deck, B: seeds.B.deck };
const known = new Map([...seeds.A.definitions, ...seeds.B.definitions]);
const isLand = (oracleId: OracleId) => known.get(oracleId)?.types.includes('land') ?? false;

/** A spell only A plays four of in the main deck, and one both decks hold, if any. */
const onlyA = decks.A.main.find(
  (slot) => slot.count === 4 && !isLand(slot.oracleId) && !cardsIn(decks.B).has(slot.oracleId),
)?.oracleId as OracleId;
const shared = [...cardsIn(decks.A).keys()].find(
  (oracleId) => !isLand(oracleId) && cardsIn(decks.B).has(oracleId),
);

const enforced = (registry: BanRegistry, seed = 'enforce') => {
  const pool = new ScryfallPool(realPool, resolver, 'vintage', 'run-bans');
  const applied: string[] = [];
  const hook = banEnforcer({
    registry,
    agent: new StatisticalDeckAgent({ shortlistSize: settings.shortlistSize, trialTopK: 0 }),
    pool,
    definitions: () => known,
    seed,
    onApplied: (events) => applied.push(...events.map((event) => event.oracleId)),
  });
  return { hook, pool, applied };
};

const cycleWith = (registry: BanRegistry) => {
  const { hook, applied } = enforced(registry);
  return runCycle({
    decks,
    definitions: known,
    seed: 'bans-cycle',
    settings,
    agents: agentsAt('greedy'),
    afterGame: hook,
  }).then((result) => ({ result, applied }));
};

describe('a ban asked for before the first game ends', async () => {
  expect(onlyA).toBeDefined();
  const registry = new BanRegistry();
  registry.request(onlyA, 'ban', { by: 'operator', at });
  const { result, applied } = await cycleWith(registry);
  const [first] = result.matches;
  const firstGame = first?.games[0];

  it('takes effect when that game ends, not before', () => {
    // Game 1 was played with the card; the ban names game 1 as the one it followed.
    expect(firstGame?.decks.A.some((slot) => slot.oracleId === onlyA)).toBe(true);
    expect(registry.history[0]?.appliedAfterGameId).toBe(firstGame?.seed);
    expect(applied).toEqual([onlyA]);
  });

  it('goes on with the legalised deck for the rest of the match, and after', () => {
    const later = result.matches.flatMap((match) => match.games).slice(1);
    expect(later.length).toBeGreaterThan(0);
    for (const game of later) {
      expect(game.decks.A.some((slot) => slot.oracleId === onlyA)).toBe(false);
    }
    expect(cardsIn(result.decks.A).has(onlyA)).toBe(false);
    expect(cardCount(result.decks.A.main)).toBe(60);
    expect(cardCount(result.decks.A.side)).toBe(15);
  });

  it('still counts the game played before it', () => {
    const games = result.matches.reduce((sum, match) => sum + match.games.length, 0);
    expect(result.stats.A.deck.games).toBe(games);
    expect(first?.games.length).toBeGreaterThanOrEqual(2);
  });

  it('records the forced change for the deck that held the card, and none for the other', () => {
    expect(result.legalisations).toHaveLength(1);
    const [legalisation] = result.legalisations;
    expect(legalisation?.afterGameId).toBe(firstGame?.seed);
    expect(legalisation?.match).toBe(0);
    expect(legalisation?.changes.B).toEqual([]);
    const [change] = legalisation?.changes.A ?? [];
    expect(change?.remove).toEqual({ oracleId: onlyA, zone: 'main', count: 4 });
    expect(change?.evidence.diagnosis).toBe('ban');
    expect(change?.reason).toMatch(/^Banned: cut 4 /);
    expect(result.decks.B).toEqual(decks.B);
  });
});

describe('the enforcer on its own', () => {
  it('does nothing when nothing is pending', async () => {
    const { hook } = enforced(new BanRegistry());
    expect(await hook({ gameId: 'g1', decks })).toBeNull();
  });

  it('leaves one copy of a restricted card', async () => {
    const registry = new BanRegistry();
    registry.request(onlyA, 'restrict', { by: 'operator', at });
    const { hook } = enforced(registry);
    const update = await hook({ gameId: 'g1', decks });
    expect(cardsIn(update?.decks.A as Deck75).get(onlyA)).toBe(1);
    expect(banViolations(update?.decks.A as Deck75, registry.list)).toEqual([]);
  });

  it('legalises both decks, each on its own, when both hold the card', async () => {
    expect(shared).toBeDefined();
    const registry = new BanRegistry();
    registry.request(shared as OracleId, 'ban', { by: 'operator', at });
    const { hook, pool } = enforced(registry);
    const update = await hook({ gameId: 'g1', decks });
    for (const player of ['A', 'B'] as const) {
      expect(update?.changes[player].length).toBeGreaterThan(0);
      expect(cardsIn(update?.decks[player] as Deck75).has(shared as OracleId)).toBe(false);
      // Every card the legalised deck holds can be played: its definition is handed over.
      for (const [oracleId] of cardsIn(update?.decks[player] as Deck75)) {
        expect(known.has(oracleId) || update?.definitions.has(oracleId)).toBe(true);
      }
    }
    expect(update?.definitions).toEqual(pool.definitions());
  });

  it('never changes a deck on an unban', async () => {
    const registry = new BanRegistry();
    registry.request(onlyA, 'ban', { by: 'operator', at });
    const { hook } = enforced(registry);
    const banned = await hook({ gameId: 'g1', decks });
    registry.request(onlyA, 'unban', { by: 'operator', at });
    expect(await hook({ gameId: 'g2', decks: banned?.decks ?? decks })).toBeNull();
    expect(registry.list.has(onlyA)).toBe(false);
    expect(registry.pending).toEqual([]);
  });

  it('changes nothing when the edit catches no deck out', async () => {
    const registry = new BanRegistry();
    registry.request(id('not-in-either-deck'), 'ban', { by: 'operator', at });
    const { hook, applied } = enforced(registry);
    expect(await hook({ gameId: 'g1', decks })).toBeNull();
    expect(applied).toEqual([id('not-in-either-deck')]);
    expect(registry.list.get(id('not-in-either-deck'))).toBe('banned');
  });

  it('legalises the same way from the same seed', async () => {
    const run = async () => {
      const registry = new BanRegistry();
      registry.request(onlyA, 'ban', { by: 'operator', at });
      return (await enforced(registry, 'same').hook({ gameId: 'g1', decks }))?.decks.A;
    };
    expect(await run()).toEqual(await run());
  });
});
