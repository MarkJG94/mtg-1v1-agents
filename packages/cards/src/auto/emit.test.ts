import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { differentialTest } from '../differential.js';
import { readScripts } from '../files.js';
import { loadCardScript } from '../load.js';
import { cardScriptSchema } from '../schema.js';
import type { CardProjection } from '../scryfall.js';
import { validateScript } from '../validate.js';
import { autoScripter, emitScript } from './emit.js';
import { goldensFor, tally } from './goldens.js';

/**
 * The emitter and its golden corpus (docs/03 step 4, docs/09 "Auto-scripter golden tests").
 *
 * Three different questions are asked here, and they are not the same question. Does the
 * emitter follow its own rules — which is what the unit cases below are for. Does the
 * pipeline still do what it did yesterday — which is the golden corpus. And is what it
 * produces *right* — which only the differential against the hand scripts can answer, and
 * only for the cards that have one.
 */

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
const read = <T>(path: string): T => JSON.parse(readFileSync(here(path), 'utf8')) as T;

const fixture = read<Record<string, CardProjection>>('../../fixtures/scryfall.json');
const corpus = read<Record<string, CardProjection>>('../../fixtures/corpus.json');
const goldens = read<Record<string, { status: string; reasons: string[]; script: unknown }>>(
  '../../fixtures/corpus-goldens.json',
);

const card = (name: string): CardProjection => {
  const found = [...Object.values(fixture), ...Object.values(corpus)].find(
    (each) => each.name === name,
  );
  if (found === undefined) throw new Error(`no ${name} in the fixtures`);
  return found;
};

const abilitiesOf = (name: string): readonly Record<string, unknown>[] => {
  const emitted = emitScript(card(name));
  return (emitted.script?.['abilities'] ?? []) as readonly Record<string, unknown>[];
};

describe('what the emitter writes down', () => {
  it('takes the characteristics off the printed card', () => {
    const script = emitScript(card('Grizzly Bears')).script;
    expect(script).toMatchObject({
      name: 'Grizzly Bears',
      manaCost: '{1}{G}',
      types: ['creature'],
      subtypes: ['bear'],
      colours: ['G'],
      power: 2,
      toughness: 2,
    });
  });

  it('leaves a printed * out rather than guessing at it', () => {
    const nightmare = emitScript(card('Nightmare')).script;
    expect(nightmare).not.toHaveProperty('power');
    // And the validator then says so, which is the point of leaving it out.
    expect(validateScript(nightmare, card('Nightmare')).status).toBe('unsupported');
  });

  it('puts a keyword line in keywords rather than in an ability', () => {
    const script = emitScript(card('Serra Angel')).script;
    expect(script?.['keywords']).toEqual(['flying', 'vigilance']);
    expect(script?.['abilities']).toEqual([]);
  });

  it('claims only the sentences the grammar actually read', () => {
    // "Destroy all creatures. They can't be regenerated." — the second sentence is not
    // read, so it is not claimed, and the validator calls the script partial.
    const wrath = emitScript(card('Wrath of God'));
    expect(wrath.script?.['abilities']).toMatchObject([{ covers: [0] }]);
    expect(validateScript(wrath.script, card('Wrath of God')).status).toBe('partial');
  });

  it('gives a card one spell ability however many lines its text runs to', () => {
    // Twisted Image is two lines of spell text. One ability per line would leave the
    // second unplayed, because the engine resolves the first spell ability it finds.
    const abilities = abilitiesOf('Twisted Image');
    expect(abilities).toHaveLength(1);

    const spell = abilities[0];
    if (spell === undefined) throw new Error('no spell ability');
    expect(spell).toMatchObject({ kind: 'spell', covers: [0, 1] });
    expect((spell['effects'] as { op: string }[]).map((each) => each.op)).toEqual([
      'switchPowerToughness',
      'draw',
    ]);
  });

  it('gives an ability an id that does not move between runs', () => {
    // Derived from the line it came from, so the same card always scripts to the same
    // ids — a cached script and a fresh one have to name the same ability.
    expect(abilitiesOf('Wall of Omens')[0]?.['id']).toBe('auto-triggered-1');
    expect(abilitiesOf('Wall of Omens')[0]?.['id']).toBe(abilitiesOf('Wall of Omens')[0]?.['id']);
  });

  it('reports what it could not read, rather than dropping it', () => {
    expect(emitScript(card('Humility')).problems.join(' ')).toContain(
      'All creatures lose all abilities',
    );
  });
});

describe('the resolver’s third link', () => {
  it('is an auto-scripter the resolver can use', () => {
    expect(autoScripter.version).toBeGreaterThan(0);
    expect(autoScripter.script(card('Lightning Bolt'))).toMatchObject({ name: 'Lightning Bolt' });
  });

  it('hands back nothing for a card with no type it understands', () => {
    expect(autoScripter.script({ ...card('Lightning Bolt'), typeLine: 'Scheme' })).toBeNull();
  });
});

describe('the golden corpus', () => {
  it('is what the pipeline produces now', () => {
    // `pnpm cards:goldens` rewrites the file; the diff is what somebody reads and accepts.
    expect(goldensFor(corpus)).toEqual(goldens);
  });

  it('is big enough to span the common templates', () => {
    expect(Object.keys(goldens).length).toBeGreaterThanOrEqual(300);
  });

  /**
   * The safety property, and the one worth stating plainly: the auto-scripter may write a
   * script that does *less* than the card says, and a partial script is never played. What
   * it must never do is write one that disagrees with the printed card, because that is a
   * card quietly better or worse than the one everybody else is playing with.
   */
  it('never writes a script that disagrees with the printed card, except about a printed *', () => {
    const wrong = Object.entries(goldens).filter(([, golden]) =>
      golden.reasons.some(
        (reason) => reason.startsWith('characteristics:') && !reason.includes('is printed as *'),
      ),
    );
    expect(wrong.map(([name]) => name)).toEqual([]);
  });

  it('never writes one the engine falls over on', () => {
    const broken = Object.entries(goldens).filter(([, golden]) =>
      golden.reasons.some((reason) => reason.startsWith('executability:')),
    );
    expect(broken.map(([name]) => name)).toEqual([]);
  });

  it('reads a third of two core sets', () => {
    const counts = tally(goldens);
    expect(counts['supported'] ?? 0).toBeGreaterThanOrEqual(100);
  });
});

describe('the differential, with something real to compare at last', () => {
  /**
   * 2.5 built this harness and had nothing to point it at. Now every bootstrap card has
   * both a hand script and an auto one, and the two are claims about the same cardboard.
   */
  const pairs = readScripts(here('../../scripts')).flatMap((file) => {
    const script = cardScriptSchema.parse(file.content);
    const printed = Object.values(fixture).find((each) => each.oracleId === script.oracleId);
    if (printed === undefined) return [];

    const emitted = emitScript(printed);
    const verdict = validateScript(emitted.script, printed);
    if (verdict.status !== 'supported' || verdict.definition === null) return [];

    return [
      {
        name: script.name,
        hand: loadCardScript(file.content),
        auto: verdict.definition,
        tests: script.tests,
      },
    ];
  });

  it('has a hand script and an auto script for most of the set', () => {
    expect(pairs.length).toBeGreaterThanOrEqual(50);
  });

  it.each(pairs.map((pair) => [pair.name, pair] as const))('%s', (_name, pair) => {
    const result = differentialTest(pair.hand, pair.auto, pair.tests);
    expect(result.disagreements.map((each) => `${each.scenario}: ${each.detail}`)).toEqual([]);
  });
});
