import { describe, expect, it } from 'vitest';
import { type AutoScripter, loadHandScripts, ScriptResolver } from './resolver.js';
import type { CardProjection } from './scryfall.js';
import { MemoryScriptStore } from './store.js';
import { VALIDATOR_VERSION } from './validate.js';

/**
 * The resolver (docs/03 "Sources of truth"), with the auto-scripter stood in for: phase 3
 * builds the real one, and the point of these tests is the *order* and what is remembered,
 * not the grammar.
 */

const jolt: CardProjection = {
  id: 'p1',
  oracleId: 'oracle-jolt',
  name: 'Jolt',
  manaCost: '{R}',
  manaValue: 1,
  colors: ['R'],
  colorIdentity: ['R'],
  typeLine: 'Instant',
  oracleText: 'Jolt deals 3 damage to any target.',
  power: null,
  toughness: null,
  loyalty: null,
  keywords: [],
  layout: 'normal',
  legalities: {},
  setCode: 'tst',
  rarity: 'common',
  reserved: false,
  digital: false,
};

const script = (over: Record<string, unknown> = {}) => ({
  oracleId: 'oracle-jolt',
  name: 'Jolt',
  manaCost: '{R}',
  types: ['instant'],
  colours: ['R'],
  abilities: [
    {
      kind: 'spell',
      covers: [0],
      targets: [{ id: 't', filter: 'any' }],
      effects: [{ op: 'damage', to: '$t', amount: 3 }],
    },
  ],
  ...over,
});

/** A parser that hands back whatever it was given, so the tests can steer it. */
const parser = (version: number, output: unknown | null): AutoScripter => ({
  version,
  script: () => output,
});

const at = () => '2026-01-01T00:00:00.000Z';

describe('resolving a card', () => {
  it('prefers a hand script, and remembers the verdict', () => {
    const store = new MemoryScriptStore();
    const resolver = new ScriptResolver({
      hand: new Map([['oracle-jolt', script()]]),
      store,
      auto: parser(1, script({ name: 'Wrong' })),
      now: at,
    });

    const resolved = resolver.resolve(jolt);

    expect(resolved.source).toBe('hand');
    expect(resolved.definition?.name).toBe('Jolt');
    expect(store.get('oracle-jolt')).toMatchObject({
      source: 'hand',
      status: 'supported',
      parserVersion: VALIDATOR_VERSION,
    });
  });

  it('falls back to the auto-scripter when nobody has written one', () => {
    const store = new MemoryScriptStore();
    const resolver = new ScriptResolver({ store, auto: parser(7, script()), now: at });

    const resolved = resolver.resolve(jolt);

    expect(resolved.source).toBe('auto');
    expect(resolved.definition?.name).toBe('Jolt');
    expect(store.get('oracle-jolt')?.parserVersion).toBe(7);
  });

  it('uses the cached verdict rather than running the parser again', () => {
    const store = new MemoryScriptStore();
    let calls = 0;
    const counting: AutoScripter = {
      version: 7,
      script: () => {
        calls += 1;
        return script();
      },
    };
    const resolver = new ScriptResolver({ store, auto: counting, now: at });

    resolver.resolve(jolt);
    resolver.resolve(jolt);

    expect(calls).toBe(1);
    expect(resolver.resolve(jolt).source).toBe('cache');
  });

  it('does not believe a verdict from an older parser', () => {
    const store = new MemoryScriptStore();
    store.put({
      oracleId: 'oracle-jolt',
      source: 'auto',
      parserVersion: 6,
      status: 'unsupported',
      reasons: [{ check: 'schema', message: 'the old grammar could not read it' }],
      script: null,
      updatedAt: at(),
    });

    const resolved = new ScriptResolver({ store, auto: parser(7, script()), now: at }).resolve(
      jolt,
    );

    expect(resolved.status).toBe('supported');
    expect(store.get('oracle-jolt')?.parserVersion).toBe(7);
  });
});

describe('what the resolver refuses to play', () => {
  it('never plays a partial script, and says why', () => {
    const store = new MemoryScriptStore();
    const partial = { ...jolt, oracleText: 'Jolt deals 3 damage to any target.\nDraw a card.' };
    const resolver = new ScriptResolver({
      hand: new Map([['oracle-jolt', script()]]),
      store,
      now: at,
    });

    const resolved = resolver.resolve(partial);

    expect(resolved.status).toBe('partial');
    expect(resolved.definition).toBeNull();
    expect(store.unsupportedRequests()[0]?.reason).toMatch(/partial/);
  });

  it('logs an unsupported request with where it came from', () => {
    const store = new MemoryScriptStore();
    const resolver = new ScriptResolver({ store, now: at });

    const resolved = resolver.resolve(jolt, { runId: 'run-1', context: 'deck generation' });

    expect(resolved.status).toBe('unscripted');
    expect(resolved.source).toBe('none');
    expect(store.unsupportedRequests()).toEqual([
      {
        oracleId: 'oracle-jolt',
        runId: 'run-1',
        context: 'deck generation',
        reason: 'no hand script, and no auto-scripter is configured',
        requestedAt: at(),
      },
    ]);
  });

  it('remembers that a card was unplayable, so the parser is not run again for it', () => {
    const store = new MemoryScriptStore();
    let calls = 0;
    const failing: AutoScripter = {
      version: 2,
      script: () => {
        calls += 1;
        return script({ manaCost: '{0}' });
      },
    };
    const resolver = new ScriptResolver({ store, auto: failing, now: at });

    expect(resolver.resolve(jolt).status).toBe('unsupported');
    expect(resolver.resolve(jolt).status).toBe('unsupported');
    expect(calls).toBe(1);
    expect(store.unsupportedRequests()).toHaveLength(2);
  });

  it('hands a game only the cards it can actually play', () => {
    const store = new MemoryScriptStore();
    const resolver = new ScriptResolver({
      hand: new Map([['oracle-jolt', script()]]),
      store,
      now: at,
    });
    const unknown = { ...jolt, oracleId: 'oracle-unknown', name: 'Nobody' };

    expect(resolver.definitionsFor([jolt, unknown])).toHaveLength(1);
  });
});

describe('the hand-script library', () => {
  it('indexes the bootstrap scripts by oracle id', () => {
    const scripts = loadHandScripts(new URL('../scripts', import.meta.url).pathname);

    expect(scripts.size).toBeGreaterThan(50);
    expect(scripts.get('4457ed35-7c10-48c8-9776-456485fdf070')).toMatchObject({
      name: 'Lightning Bolt',
    });
  });
});
