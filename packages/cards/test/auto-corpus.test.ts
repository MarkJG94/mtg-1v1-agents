import { describe, expect, it } from 'vitest';
import { GrammarAutoScripter, scriptCard } from '../src/auto/index.js';
import { MemoryUnsupportedLog, ScriptResolver } from '../src/resolver.js';
import { CardDatabase, type ScryfallCard } from '../src/scryfall.js';
import { validateScript } from '../src/validate.js';
import corpus from './fixtures/auto-corpus.json' with { type: 'json' };
import bootstrap from './fixtures/scryfall-subset.json' with { type: 'json' };

const CORPUS = corpus as ScryfallCard[];
const BOOTSTRAP = bootstrap as ScryfallCard[];

/** Cards in the corpus that the v1 grammar is not expected to reach; each names the pattern it lacks. */
const EXPECTED_UNSUPPORTED: Record<string, string> = {
  Lhurgoyf: 'characteristic-defining power/toughness',
  'Dark Confidant': 'reveal-and-put-into-hand, "equal to its mana value"',
};

/**
 * The golden corpus (docs/03 §Auto-scripter, roadmap 3.4): one card per template the grammar claims to
 * handle, validated end to end including the executability smoke games.
 */
describe('auto-scripter golden corpus', () => {
  for (const card of CORPUS) {
    const expectedReason = EXPECTED_UNSUPPORTED[card.name];
    it(`${card.name}${expectedReason ? ' (out of scope)' : ''}`, () => {
      const attempt = scriptCard(card);
      if (expectedReason) {
        expect(attempt.script, `expected no script: ${expectedReason}`).toBeNull();
        expect(attempt.reasons.length).toBeGreaterThan(0);
        return;
      }
      expect(attempt.script, attempt.reasons.join('\n')).not.toBeNull();
      const result = validateScript(attempt.script, card);
      expect(
        `${result.status}${result.status === 'supported' ? '' : `: ${result.reasons.join('; ')}`}`,
      ).toBe('supported');
    });
  }
});

/**
 * The bootstrap set doubles as a harder corpus: every card there has a hand script, so whatever the
 * grammar reaches is a card the auto-scripter could have supplied on its own. Smoke games are skipped
 * here because the hand-script suite already plays all 98.
 */
describe('auto-scripter against the bootstrap set', () => {
  const results = BOOTSTRAP.map((card) => {
    const attempt = scriptCard(card);
    if (!attempt.script) return { card, status: 'unparsed' as const, reasons: attempt.reasons };
    const v = validateScript(attempt.script, card, { skipSmoke: true });
    return { card, status: v.status, reasons: v.reasons };
  });

  it('never emits a script that fails validation', () => {
    const broken = results
      .filter((r) => r.status !== 'supported' && r.status !== 'unparsed')
      .map((r) => `${r.card.name} [${r.status}]: ${r.reasons.join('; ')}`);
    expect(broken).toEqual([]);
  });

  it('supports at least 85 of the 98 hand-scripted cards', () => {
    const supported = results.filter((r) => r.status === 'supported');
    expect(supported.length).toBeGreaterThanOrEqual(85);
  });
});

describe('resolver integration', () => {
  it('falls back to the auto-scripter when there is no hand script', () => {
    const db = new CardDatabase(CORPUS);
    const log = new MemoryUnsupportedLog();
    const resolver = new ScriptResolver({
      db,
      handScripts: new Map(),
      autoScripter: new GrammarAutoScripter(),
      unsupportedLog: log,
      validate: { skipSmoke: true },
    });
    const bolt = resolver.resolveByName('Lightning Strike');
    expect(bolt.status).toBe('supported');
    expect(bolt.source).toBe('auto');
    expect(bolt.definition?.abilities).toHaveLength(1);
    expect(log.entries).toHaveLength(0);
  });

  it('logs a card the grammar cannot read', () => {
    const db = new CardDatabase(CORPUS);
    const log = new MemoryUnsupportedLog();
    const resolver = new ScriptResolver({
      db,
      handScripts: new Map(),
      autoScripter: new GrammarAutoScripter(),
      unsupportedLog: log,
      validate: { skipSmoke: true },
    });
    const goyf = resolver.resolveByName('Lhurgoyf', 'deck-generation');
    expect(goyf.status).toBe('unsupported');
    expect(goyf.definition).toBeNull();
    expect(log.entries[0]?.context).toBe('deck-generation');
  });

  it('prefers a hand script over the auto-scripter', () => {
    const db = new CardDatabase(CORPUS);
    const card = db.named('Murder')!;
    const hand = {
      oracleId: card.oracle_id,
      name: 'Murder',
      manaCost: '{1}{B}{B}',
      types: ['instant'],
      text: 'Destroy target creature.',
      abilities: [
        {
          kind: 'spell',
          covers: [0],
          targets: [{ id: 'x', filter: { type: 'creature' } }],
          effects: [{ op: 'destroy', target: '$x' }],
        },
      ],
    };
    const resolver = new ScriptResolver({
      db,
      handScripts: new Map([[card.oracle_id, hand]]),
      autoScripter: new GrammarAutoScripter(),
      validate: { skipSmoke: true },
    });
    const r = resolver.resolve(card.oracle_id);
    expect(r.source).toBe('hand');
    expect(r.status).toBe('supported');
  });
});
