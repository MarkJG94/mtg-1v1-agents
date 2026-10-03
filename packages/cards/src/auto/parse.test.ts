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
  parseRiders,
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

  /**
   * "and 2 damage to" is a second damage clause with its own amount, and it was the single
   * commonest thing standing between a burn spell and being read: "deals 4 damage to
   * target creature" parsed and "deals 6 damage to target creature and 2 damage to target
   * player" did not.
   */
  it('reads a second amount dealt to a second recipient', () => {
    expect(
      effectsOf(
        '~ deals 3 damage to target player or planeswalker and 3 damage to target creature.',
      ),
    ).toEqual([
      { op: 'damage', to: '$t', amount: 3 },
      // Two targets, so two ids: the second declares its own (CR 601.2c).
      { op: 'damage', to: '$u', amount: 3 },
    ]);
    expect(effectsOf('~ deals 2 damage to any target and 1 damage to you.')).toEqual([
      { op: 'damage', to: '$t', amount: 2 },
      { op: 'damage', to: 'you', amount: 1 },
    ]);
  });

  it('reads one amount dealt to each of two sets', () => {
    expect(effectsOf('~ deals 1 damage to each creature and each player.')).toEqual([
      { op: 'forEach', of: 'creature', effects: [{ op: 'damage', to: '$each', amount: 1 }] },
      { op: 'damage', to: 'each', amount: 1 },
    ]);
  });

  it('leaves "and" alone when what follows it is not a recipient', () => {
    // The sentence-level "and" joins clauses, and swallowing it here would make "and draw
    // a card" a thing damage was dealt to.
    expect(effectsOf('~ deals 2 damage to any target and you gain 2 life.')).toEqual([
      { op: 'damage', to: '$t', amount: 2 },
      { op: 'gainLife', player: 'you', amount: 2 },
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

  /**
   * The filter is where most of Magic's variation lives, and the engine already has every
   * predicate below (CR 115.1). Each of these was a whole card unread for the want of one
   * adjective: "deals 4 damage to target creature" reads, and "to target attacking or
   * blocking creature" did not.
   */
  it('reads the adjectives in front of a noun', () => {
    expect(targetsOf('Destroy target attacking creature.')).toEqual([
      { id: 't', filter: { is: 'creature', and: ['attacking'] } },
    ]);
    expect(targetsOf('Destroy target attacking or blocking creature.')).toEqual([
      { id: 't', filter: { is: 'creature', and: [{ or: ['attacking', 'blocking'] }] } },
    ]);
    expect(targetsOf('Destroy target tapped creature.')).toEqual([
      { id: 't', filter: { is: 'creature', and: [{ tapped: true }] } },
    ]);
    expect(targetsOf('Destroy target untapped artifact.')).toEqual([
      { id: 't', filter: { type: 'artifact', and: [{ tapped: false }] } },
    ]);
  });

  it('reads a colour alternation, which is not a single colour', () => {
    expect(targetsOf('Destroy target white or blue creature.')).toEqual([
      { id: 't', filter: { is: 'creature', and: [{ or: [{ colour: 'W' }, { colour: 'U' }] }] } },
    ]);
  });

  it('reads the keyword a noun is qualified by, either side of "you control"', () => {
    expect(targetsOf('Destroy target creature with flying.')).toEqual([
      { id: 't', filter: { is: 'creature', and: [{ keyword: 'flying' }] } },
    ]);
    expect(targetsOf('Destroy target creature without flying.')).toEqual([
      { id: 't', filter: { is: 'creature', and: [{ not: { keyword: 'flying' } }] } },
    ]);
    expect(targetsOf('Destroy target creature with first strike.')).toEqual([
      { id: 't', filter: { is: 'creature', and: [{ keyword: 'firstStrike' }] } },
    ]);
    expect(effectsOf('Destroy all creatures you control with flying.')).toEqual([
      {
        op: 'forEach',
        of: { is: 'creature', and: [{ keyword: 'flying' }], controller: 'you' },
        effects: [{ op: 'destroy', object: '$each' }],
      },
    ]);
  });

  it('refuses a qualifier it has no predicate for rather than dropping it', () => {
    // "That blocked this turn" needs the game to remember what blocked, and the engine has
    // no filter for it. Dropping it would make every blocker a legal target.
    expect(effectsOf('Destroy target creature that blocked this turn.')).toBeNull();
    expect(effectsOf('Destroy target creature with a +1/+1 counter on it.')).toBeNull();
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

  /**
   * The engine reads a step trigger as "the active player's step unless `whose` says
   * `any`", so the word the card uses for whose step it is has to reach the script: "your
   * upkeep" and "each player's upkeep" are the same trigger with different answers.
   */
  it('says whose step a step trigger is about', () => {
    expect(parseTrigger('At the beginning of your upkeep, draw a card.')).toMatchObject({
      when: { kind: 'beginningOfUpkeep', whose: 'self' },
    });
    expect(parseTrigger("At the beginning of each player's upkeep, draw a card.")).toMatchObject({
      when: { kind: 'beginningOfUpkeep', whose: 'any' },
    });
    expect(parseTrigger('At the beginning of your end step, draw a card.')).toMatchObject({
      when: { kind: 'beginningOfEndStep', whose: 'self' },
    });
    expect(parseTrigger('At the beginning of each end step, draw a card.')).toMatchObject({
      when: { kind: 'beginningOfEndStep', whose: 'any' },
    });
  });

  it('refuses a step it has no trigger for', () => {
    expect(parseTrigger('At the beginning of your first main phase, draw a card.')).toHaveProperty(
      'failure',
    );
    expect(parseTrigger('At the beginning of combat on your turn, draw a card.')).toHaveProperty(
      'failure',
    );
  });

  it('reads a mana ability’s modes', () => {
    expect(parseManaModes('Add {U} or {B}.')).toEqual([
      [{ type: 'U', amount: 1 }],
      [{ type: 'B', amount: 1 }],
    ]);
    expect(parseManaModes('Add {G}.')).toEqual([[{ type: 'G', amount: 1 }]]);
  });

  it('reads "one mana of any color" as the five colours', () => {
    expect(parseManaModes('Add one mana of any color.')).toEqual([
      [{ type: 'W', amount: 1 }],
      [{ type: 'U', amount: 1 }],
      [{ type: 'B', amount: 1 }],
      [{ type: 'R', amount: 1 }],
      [{ type: 'G', amount: 1 }],
    ]);
  });

  it('refuses "any color" with anything else left on the line', () => {
    // A spend restriction is part of the ability, and a mana ability that dropped one
    // would add mana this card never said you could spend that way.
    expect(
      parseManaModes('Add one mana of any color. Spend this mana only to cast an artifact spell.'),
    ).toBeNull();
    // Two mana of one colour is a different ability, and reading it as one would be a card
    // producing half the mana it prints.
    expect(parseManaModes('Add two mana of any one color.')).toBeNull();
  });

  it('reads the sorcery-speed rider off an activated ability', () => {
    expect(parseRiders('Draw a card. Activate only as a sorcery.')).toEqual({
      effect: 'Draw a card.',
      sorceryOnly: true,
    });
  });

  it('leaves a rider the engine has no field for on the effect', () => {
    // "Only once each turn" is a real restriction with nowhere to put it: an activated
    // ability has no `onceEachTurn`. Left on the effect, so the parse fails and the card
    // is partial — rather than stripped, which would be an ability with no limit on it.
    expect(parseRiders('~ gets +2/+2 until end of turn. Activate only once each turn.')).toEqual({
      effect: '~ gets +2/+2 until end of turn. Activate only once each turn.',
    });
    expect(parseRiders('Draw a card. Activate only during your turn.')).toEqual({
      effect: 'Draw a card. Activate only during your turn.',
    });
  });

  it('reads a permanent entering with counters on it', () => {
    expect(parseReplacement('~ enters with four +1/+1 counters on it.')).toEqual({
      applies: { kind: 'entersBattlefield', object: 'source' },
      change: { kind: 'entersWithCounters', counter: '+1/+1', amount: 4 },
      selfReplacement: true,
    });
    expect(parseReplacement('~ enters the battlefield with a -1/-1 counter on it.')).toMatchObject({
      change: { kind: 'entersWithCounters', counter: '-1/-1', amount: 1 },
    });
    expect(parseReplacement('~ enters with two charge counters on it.')).toMatchObject({
      change: { kind: 'entersWithCounters', counter: 'charge', amount: 2 },
    });
  });

  it('refuses a count of counters it cannot turn into a number', () => {
    // `entersWithCounters` takes a number, so an X or a "for each" would have to be
    // evaluated as the permanent enters and there is nowhere for that to happen — a card
    // entering with one counter instead of five is a weaker card, quietly.
    expect(parseReplacement('~ enters with X +1/+1 counters on it.')).toBeNull();
    expect(
      parseReplacement('~ enters with a +1/+1 counter on it for each creature you control.'),
    ).toBeNull();
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
