import { describe, expect, it } from 'vitest';
import { MemoryScriptCache, MemoryUnsupportedLog, ScriptResolver } from '../src/resolver.js';
import { handScriptsByOracleId, loadHandScriptFiles } from '../src/scripts.js';
import { CardDatabase, type ScryfallCard } from '../src/scryfall.js';
import fixture from './fixtures/scryfall-subset.json' with { type: 'json' };

const db = new CardDatabase(fixture as ScryfallCard[]);
const hand = handScriptsByOracleId(loadHandScriptFiles());

describe('ScriptResolver', () => {
  it('resolves hand scripts and returns engine definitions', () => {
    const r = new ScriptResolver({ db, handScripts: hand, validate: { skipSmoke: true } });
    const bolt = r.resolveByName('Lightning Bolt', 'test');
    expect(bolt.status).toBe('supported');
    expect(bolt.source).toBe('hand');
    expect(bolt.definition?.name).toBe('Lightning Bolt');
    expect(Object.keys(r.definitions())).toContain(bolt.oracleId);
  });

  it('logs unsupported requests with a reason', () => {
    const log = new MemoryUnsupportedLog();
    const r = new ScriptResolver({
      db,
      handScripts: hand,
      unsupportedLog: log,
      validate: { skipSmoke: true },
      now: () => 't0',
    });
    const unknown = r.resolve('fixture:does-not-exist', 'seed-deck', 'run-1');
    expect(unknown.status).toBe('unsupported');
    expect(log.entries).toEqual([
      {
        oracleId: 'fixture:does-not-exist',
        runId: 'run-1',
        context: 'seed-deck',
        reason: 'unknown oracle id',
        requestedAt: 't0',
      },
    ]);
    const missing = r.resolveByName('Nope', 'seed-deck');
    expect(missing.status).toBe('unsupported');
  });

  it('caches auto-scripter output and honours the parser version', () => {
    const cache = new MemoryScriptCache();
    const noHand = new Map<string, unknown>();
    let calls = 0;
    const boltCard = db.named('Lightning Bolt')!;
    const script = hand.get(boltCard.oracle_id);
    const auto = {
      version: 1,
      script: (c: ScryfallCard) => {
        calls++;
        return c.oracle_id === boltCard.oracle_id
          ? { script, reasons: [] }
          : { script: null, reasons: ['cannot parse'] };
      },
    };
    const r1 = new ScriptResolver({
      db,
      handScripts: noHand,
      cache,
      autoScripter: auto,
      validate: { skipSmoke: true },
    });
    expect(r1.resolve(boltCard.oracle_id).status).toBe('supported');
    expect(r1.resolve(boltCard.oracle_id).source).toBe('auto');
    expect(r1.resolveByName('Grizzly Bears').status).toBe('unsupported');
    expect(calls).toBe(2);
    // A fresh resolver with the same cache does not call the auto-scripter again.
    const r2 = new ScriptResolver({
      db,
      handScripts: noHand,
      cache,
      autoScripter: auto,
      validate: { skipSmoke: true },
    });
    expect(r2.resolve(boltCard.oracle_id).status).toBe('supported');
    expect(r2.resolveByName('Grizzly Bears').status).toBe('unsupported');
    expect(calls).toBe(2);
    // Bumping the parser version invalidates the cache.
    const r3 = new ScriptResolver({
      db,
      handScripts: noHand,
      cache,
      autoScripter: { ...auto, version: 2 },
      validate: { skipSmoke: true },
    });
    r3.resolve(boltCard.oracle_id);
    expect(calls).toBe(3);
  });

  it('is unsupported without an auto-scripter when no hand script exists', () => {
    const r = new ScriptResolver({ db, handScripts: new Map(), validate: { skipSmoke: true } });
    expect(r.resolveByName('Grizzly Bears').reasons[0]).toMatch(/no hand script/);
  });
});
