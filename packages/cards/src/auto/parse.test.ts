import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCardScript } from '../load.js';
import { parseTypeLine } from '../oracle-text.js';
import type { CardProjection } from '../scryfall.js';
import { classifyCard } from './classify.js';
import {
  parseCost,
  parseEffects,
  parseManaModes,
  parseReplacement,
  parseStatic,
  parseTrigger,
} from './parse.js';

/**
 * The grammar (docs/03, auto-scripter step 3; ADR 0008).
 *
 * Each case below is a template the parser claims to read, and the run over the bootstrap
 * set at the end is the one that says whether it really does — with every parse loaded
 * through the loader, because a parse that produces a script the engine cannot read is
 * worse than one that admits it failed.
 */

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
const fixture = JSON.parse(readFileSync(here('../../fixtures/scryfall.json'), 'utf8')) as Record<
  string,
  CardProjection
>;

/** The effects one sentence parses to, or `null` if it did not parse at all. */
const effectsOf = (...sentences: readonly string[]): unknown => {
  const parsed = parseEffects(sentences);
  return parsed.ok ? parsed.ability.effects : null;
};

const targetsOf = (...sentences: readonly string[]): unknown => {
  const parsed = parseEffects(sentences);
  return parsed.ok ? parsed.ability.targets : null;
};

describe('damage and life', () => {
  it('reads a burn spell', () => {
    expect(effectsOf('~ deals 3 damage to any target.')).toEqual([
      { op: 'damage', to: '$t', amount: 3 },
    ]);
    expect(targetsOf('~ deals 3 damage to any target.')).toEqual([{ id: 't', filter: 'any' }]);
  });

  /**
   * "Each player" is not a filter over objects. `forEach` walks the battlefield, so a
   * player filter matches nothing and the damage lands on nobody — while the sentence is
   * *claimed*, which makes the card supported and blank. A burn spell that hits both
   * players would come down as a do-nothing.
   */
  it('deals damage to each player, rather than to no objects at all', () => {
    expect(effectsOf('~ deals 2 damage to each player.')).toEqual([
      { op: 'damage', to: 'each', amount: 2 },
    ]);
  });

  it('reads damage to everything', () => {
    expect(effectsOf('~ deals 2 damage to each creature.')).toEqual([
      { op: 'forEach', of: 'creature', effects: [{ op: 'damage', to: '$each', amount: 2 }] },
    ]);
  });

  it('reads life gained and lost', () => {
    expect(effectsOf('You gain 7 life.')).toEqual([{ op: 'gainLife', player: 'you', amount: 7 }]);
    expect(effectsOf('Target player loses 2 life.')).toEqual([
      { op: 'loseLife', player: '$t', amount: 2 },
    ]);
  });

  it('keeps the subject across an "and"', () => {
    expect(effectsOf('Target player draws two cards and loses 2 life.')).toEqual([
      { op: 'draw', player: '$t', count: 2 },
      { op: 'loseLife', player: '$t', amount: 2 },
    ]);
  });

  it('reads a fight', () => {
    expect(
      effectsOf("Target creature you control fights target creature you don't control."),
    ).toEqual([{ op: 'fight', first: '$t', second: '$u' }]);
  });
});

describe('cards and removal', () => {
  it('reads a cantrip and a draw spell', () => {
    expect(effectsOf('Draw a card.')).toEqual([{ op: 'draw', player: 'you', count: 1 }]);
    expect(effectsOf('Draw two cards.')).toEqual([{ op: 'draw', player: 'you', count: 2 }]);
  });

  it('reads removal, and what it is allowed to be pointed at', () => {
    expect(effectsOf('Destroy target creature.')).toEqual([{ op: 'destroy', object: '$t' }]);
    expect(targetsOf('Destroy target nonblack creature.')).toEqual([
      { id: 't', filter: { not: { colour: 'B' }, type: 'creature' } },
    ]);
    expect(targetsOf('Destroy target artifact or enchantment.')).toEqual([
      { id: 't', filter: { or: [{ type: 'artifact' }, { type: 'enchantment' }] } },
    ]);
  });

  it('reads a list of alternatives with commas in it', () => {
    expect(targetsOf('Tap target artifact, creature, or land.')).toEqual([
      { id: 't', filter: { or: [{ type: 'artifact' }, 'creature', { type: 'land' }] } },
    ]);
  });

  it('reads a board wipe as an effect on each of them', () => {
    expect(effectsOf('Destroy all creatures.')).toEqual([
      { op: 'forEach', of: 'creature', effects: [{ op: 'destroy', object: '$each' }] },
    ]);
  });

  it('reads a bounce spell', () => {
    expect(effectsOf("Return target creature to its owner's hand.")).toEqual([
      { op: 'bounce', object: '$t' },
    ]);
  });

  it('reads a counterspell, and what it may counter', () => {
    expect(targetsOf('Counter target creature spell.')).toEqual([
      { id: 't', filter: { type: 'creature', is: 'spell' } },
    ]);
    expect(targetsOf('Counter target noncreature spell.')).toEqual([
      { id: 't', filter: { not: { type: 'creature' }, is: 'spell' } },
    ]);
  });

  it('refuses a discard the player chooses, which needs a decision mid-resolution', () => {
    expect(effectsOf('Target player discards two cards.')).toBeNull();
    expect(effectsOf('Target player discards two cards at random.')).toEqual([
      { op: 'discardAtRandom', player: '$t', count: 2 },
    ]);
  });
});

describe('permanents', () => {
  it('reads a pump spell with its duration', () => {
    expect(effectsOf('Target creature gets +3/+3 until end of turn.')).toEqual([
      { op: 'pump', object: '$t', power: 3, toughness: 3, duration: 'untilEndOfTurn' },
    ]);
  });

  it('reads a pump that also grants a keyword', () => {
    expect(
      effectsOf('Target creature gets +1/+1 and gains double strike until end of turn.'),
    ).toEqual([
      { op: 'pump', object: '$t', power: 1, toughness: 1 },
      { op: 'grantKeyword', object: '$t', keyword: 'doubleStrike', duration: 'untilEndOfTurn' },
    ]);
  });

  it('reads counters put on something', () => {
    expect(effectsOf('Put a +1/+1 counter on ~.')).toEqual([
      { op: 'addCounters', object: '~', counter: '+1/+1', amount: 1 },
    ]);
  });

  it('reads taking control of something', () => {
    expect(effectsOf('Gain control of target creature until end of turn.')).toEqual([
      { op: 'gainControl', object: '$t', player: 'you', duration: 'untilEndOfTurn' },
    ]);
  });

  it('reads a switch of power and toughness', () => {
    expect(effectsOf("Switch target creature's power and toughness until end of turn.")).toEqual([
      { op: 'switchPowerToughness', object: '$t', duration: 'untilEndOfTurn' },
    ]);
  });
});

describe('anaphora', () => {
  it('follows one target through three sentences', () => {
    const parsed = parseEffects([
      'Gain control of target creature until end of turn.',
      'Untap that creature.',
      'It gains haste until end of turn.',
    ]);
    expect(parsed.ok && parsed.ability.targets).toEqual([{ id: 't', filter: 'creature' }]);
    expect(parsed.ok && parsed.ability.effects).toEqual([
      { op: 'gainControl', object: '$t', player: 'you', duration: 'untilEndOfTurn' },
      { op: 'untap', object: '$t' },
      { op: 'grantKeyword', object: '$t', keyword: 'haste', duration: 'untilEndOfTurn' },
    ]);
  });

  it('declares one target however many rules tried to read the sentence', () => {
    expect(targetsOf('Target creature gets +3/+3 until end of turn.')).toEqual([
      { id: 't', filter: 'creature' },
    ]);
  });

  it('takes an opening "it" for the card itself, and a later one for nothing', () => {
    expect(effectsOf('It deals 1 damage to any target.')).toEqual([
      { op: 'damage', to: '$t', amount: 1 },
    ]);
    const later = parseEffects(['Draw a card.', 'It deals 1 damage to any target.']);
    expect(later.ok && later.ability.sentencesRead).toBe(1);
  });
});

describe('stopping part-way', () => {
  it('keeps the sentences it read and says what stopped it', () => {
    const parsed = parseEffects(['Destroy all creatures.', "They can't be regenerated."]);
    expect(parsed.ok && parsed.ability.sentencesRead).toBe(1);
    expect(parsed.ok && parsed.ability.unread?.token?.word).toBe('they');
  });

  it('never keeps half a sentence', () => {
    const parsed = parseEffects(['Destroy target creature and untap all the frogs in Ohio.']);
    expect(parsed.ok).toBe(false);
  });

  it('points at the furthest word any rule reached', () => {
    const parsed = parseEffects(['~ deals 3 damage to the moon.']);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.failure.token?.word).toBe('the');
  });
});

describe('the parts that are not effects', () => {
  it('reads a trigger and what it causes', () => {
    expect(parseTrigger('When ~ enters, draw a card.')).toMatchObject({
      when: { kind: 'selfEntersBattlefield' },
      ability: { effects: [{ op: 'draw', player: 'you', count: 1 }] },
    });
  });

  it('keeps "you control" on a trigger that says it', () => {
    expect(
      parseTrigger('Whenever another creature you control dies, put a +1/+1 counter on ~.'),
    ).toMatchObject({ when: { kind: 'anotherDies', controlledBy: 'you' } });
  });

  it('reads a mana ability’s modes', () => {
    expect(parseManaModes('Add {U} or {B}.')).toEqual([
      [{ type: 'U', amount: 1 }],
      [{ type: 'B', amount: 1 }],
    ]);
    expect(parseManaModes('Add {G}.')).toEqual([[{ type: 'G', amount: 1 }]]);
  });

  it('reads an anthem', () => {
    expect(parseStatic('Creatures you control get +1/+1.')).toEqual({
      affects: { kind: 'creaturesControlledBy', player: 'sourceController' },
      change: { kind: 'modifyPowerToughness', power: 1, toughness: 1 },
    });
  });

  it('does not read an anthem that helps everybody', () => {
    expect(parseStatic('Creatures get +1/+1.')).toBeNull();
  });

  it('reads a land that enters tapped', () => {
    expect(parseReplacement('~ enters tapped.')).toEqual({
      applies: { kind: 'entersBattlefield', object: 'source' },
      change: { kind: 'entersTapped' },
      selfReplacement: true,
    });
  });

  it('reads an activation cost, and refuses one it cannot', () => {
    expect(parseCost('{1}, {T}')).toEqual({ mana: '{1}', tap: true });
    expect(parseCost('Sacrifice ~')).toEqual({ sacrificeSelf: true });
    expect(parseCost('Discard a card')).toBeNull();
  });

  /**
   * The half it *could* read is the dangerous part: `{1}` alone is a real cost, and a card
   * that pays it without discarding is cheaper than the one that is printed.
   */
  it('refuses a cost it can only read half of', () => {
    expect(parseCost('{1}, Discard a card')).toBeNull();
    expect(parseCost('{T}, Pay 3 life')).toBeNull();
  });
});

describe('over the bootstrap set', () => {
  /** Every line of the set, with what the parser made of it. */
  const attempts = Object.values(fixture).flatMap((card) =>
    classifyCard(card)
      .lines.filter((line) => line.kind !== 'keyword' && line.kind !== 'unknown')
      .map((line) => ({ card, line })),
  );

  const read = ({ card, line }: (typeof attempts)[number]): unknown => {
    const text = line.line.text;
    if (line.kind === 'mana') return parseManaModes(line.effect ?? text);
    if (line.kind === 'static') return parseStatic(text);
    if (line.kind === 'replacement') return parseReplacement(text);
    if (line.kind === 'triggered') {
      const parsed = parseTrigger(text);
      return 'failure' in parsed ? null : parsed;
    }
    const parsed = parseEffects(
      line.effect === undefined ? line.line.sentences.map((each) => each.text) : [line.effect],
    );
    void card;
    return parsed.ok ? parsed.ability : null;
  };

  it('reads all but the templates it does not claim to know', () => {
    const failures = attempts
      .filter((attempt) => read(attempt) === null)
      .map((attempt) => `${attempt.card.name}: ${attempt.line.line.text}`);

    // Humility is a static ability that takes every ability off every creature and sets
    // their power and toughness, and Turn to Frog is the same change as a spell. Both
    // want layer changes the script vocabulary cannot say, and Turn to Frog's hand script
    // is already one of the three the set marks partial.
    expect(failures).toHaveLength(2);
    expect(failures.join(' ')).toContain('Humility');
    expect(failures.join(' ')).toContain('Turn to Frog');
  });

  it('produces a script the loader accepts, for every line it reads', () => {
    const broken: string[] = [];

    for (const attempt of attempts) {
      const parsed = read(attempt);
      if (parsed === null) continue;
      try {
        loadCardScript(scriptAround(attempt.card, attempt.line.kind, parsed, attempt.line.cost));
      } catch (error) {
        broken.push(`${attempt.card.name}: ${(error as Error).message}`);
      }
    }

    expect(broken).toEqual([]);
  });
});

/**
 * A card script with one ability in it, so that what the parser produced can be put through
 * the loader. Assembling a whole card is the emitter's job in 3.4; this is the least that
 * proves what came out of the grammar is something the engine can actually read.
 */
const scriptAround = (
  card: CardProjection,
  kind: string,
  parsed: unknown,
  cost: string | undefined,
): unknown => {
  const printed = parseTypeLine(card.typeLine);
  const ability = (() => {
    const body = parsed as Record<string, unknown>;
    switch (kind) {
      case 'mana':
        return { kind, id: 'mana', modes: parsed };
      case 'static':
        return { kind, ...body };
      case 'replacement':
        return { kind, id: 'replaces', ...body };
      case 'triggered': {
        const inner = body['ability'] as Record<string, unknown>;
        return { kind, id: 'trigger', when: body['when'], ...abilityBody(inner) };
      }
      case 'activated':
        return { kind, id: 'activated', cost: parseCost(cost ?? '') ?? {}, ...abilityBody(body) };
      case 'loyalty':
        return { kind, id: 'loyalty', cost: Number(cost ?? 0), ...abilityBody(body) };
      default:
        return { kind: 'spell', ...abilityBody(body) };
    }
  })();

  return {
    oracleId: card.oracleId,
    name: card.name,
    manaCost: card.manaCost ?? '',
    types: printed.types,
    colours: card.colors.map((colour) => colour.toUpperCase()),
    text: card.oracleText,
    abilities: [ability],
  };
};

const abilityBody = (parsed: Record<string, unknown>): Record<string, unknown> => ({
  effects: parsed['effects'],
  ...((parsed['targets'] as unknown[]).length > 0 ? { targets: parsed['targets'] } : {}),
});
