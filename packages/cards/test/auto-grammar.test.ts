import { describe, expect, it } from 'vitest';
import {
  Bindings,
  classify,
  parseActivated,
  parseEffects,
  parseKeywordLine,
  parseStatic,
  parseTriggered,
  Scanner,
  tokenize,
} from '../src/auto/index.js';

describe('tokeniser', () => {
  it('keeps mana runs, P/T pairs and possessives whole', () => {
    expect(tokenize('{1}{R}, {T}: ~ gets +3/+3.').map((t) => t.lower)).toEqual([
      '{1}{r}',
      ',',
      '{t}',
      ':',
      '~',
      'gets',
      '+3/+3',
      '.',
    ]);
    expect(tokenize("its owner's hand").map((t) => t.lower)).toEqual(['its', "owner's", 'hand']);
  });

  it('folds the unicode Scryfall uses', () => {
    expect(tokenize('−1: draw').map((t) => t.lower)).toEqual(['-1', ':', 'draw']);
  });
});

describe('scanner backtracking', () => {
  it('rewinds a failed attempt but remembers how far it reached', () => {
    const s = Scanner.of('destroy target creature');
    expect(s.attempt(() => (s.eat('destroy target land') ? true : null))).toBeNull();
    expect(s.i).toBe(0);
    expect(s.eat('destroy target creature')).toBe(true);
  });
});

describe('classifier', () => {
  const creature = { types: ['creature'], keywords: [] };
  const instant = { types: ['instant'], keywords: [] };
  it.each([
    ['Flying', creature, 'keyword'],
    ['Enchant creature', creature, 'enchant'],
    ['Equip {1}', creature, 'equip'],
    ['+2: Draw a card.', creature, 'loyalty'],
    ['{T}: Add {G}.', creature, 'activated'],
    ['When ~ enters, draw a card.', creature, 'triggered'],
    [
      'Landfall — Whenever a land enters the battlefield under your control, draw a card.',
      creature,
      'triggered',
    ],
    ['Creatures you control get +1/+1.', creature, 'static'],
    ['Draw a card.', instant, 'spell'],
    ['As an additional cost to cast this spell, discard a card.', instant, 'additionalCost'],
  ])('%s', (sentence, card, expected) => {
    expect(classify(sentence, card)).toBe(expected);
  });
});

describe('keyword lines', () => {
  it('splits a comma-separated line', () => {
    expect(parseKeywordLine('Flying, vigilance')).toEqual([
      { kind: 'keyword', keyword: 'flying' },
      { kind: 'keyword', keyword: 'vigilance' },
    ]);
  });
  it('reads protection', () => {
    expect(parseKeywordLine('Protection from white')).toEqual([
      { kind: 'keyword', keyword: 'protection', from: { color: 'W' } },
    ]);
  });
  it('rejects a sentence that only starts with a keyword', () => {
    expect(parseKeywordLine('Flying creatures you control get +1/+1.')).toBeNull();
  });
});

/** Each case pins the exact engine structures the grammar emits, so a regression is visible in the diff. */
describe('effect clauses', () => {
  const parse = (text: string) => {
    const s = Scanner.of(text);
    const b = new Bindings();
    const effects = parseEffects(s, b);
    return { effects, targets: b.targets, done: s.finish() };
  };

  it('damage to any target', () => {
    expect(parse('~ deals 3 damage to any target.')).toEqual({
      effects: [{ op: 'damage', amount: 3, to: '$t' }],
      targets: [{ id: 't', filter: { any: true } }],
      done: true,
    });
  });

  it('damage to each creature', () => {
    expect(parse('~ deals 2 damage to each creature.').effects).toEqual([
      { op: 'damageEach', filter: { type: 'creature' }, amount: 2 },
    ]);
  });

  it('destroy with a filtered target', () => {
    expect(parse('Destroy target nonland permanent with mana value 3 or less.')).toEqual({
      effects: [{ op: 'destroy', target: '$t' }],
      targets: [{ id: 't', filter: { notType: 'land', mvLTE: 3 } }],
      done: true,
    });
  });

  it('destroy all, qualified by a following sentence', () => {
    const s = Scanner.of('Destroy all creatures.');
    const b = new Bindings();
    const first = parseEffects(s, b)!;
    const s2 = Scanner.of("They can't be regenerated.");
    parseEffects(s2, b);
    expect(b.noRegenerate).toBe(true);
    expect(first).toEqual([{ op: 'destroyAll', filter: { type: 'creature' } }]);
  });

  it('counter unless the controller pays', () => {
    expect(parse('Counter target spell unless its controller pays {3}.').effects).toEqual([
      { op: 'counter', target: '$t', unlessPay: '{3}' },
    ]);
  });

  it('two effects joined by "and", sharing the target', () => {
    expect(parse('Untap target creature and gain control of it until end of turn.')).toEqual({
      effects: [
        { op: 'untap', target: '$t' },
        { op: 'gainControl', target: '$t', duration: 'untilEndOfTurn' },
      ],
      targets: [{ id: 't', filter: { type: 'creature' } }],
      done: true,
    });
  });

  it('a target player who draws and loses life', () => {
    expect(parse('Target player draws two cards and loses 2 life.')).toEqual({
      effects: [
        { op: 'draw', count: 2, player: '$p' },
        { op: 'loseLife', amount: 2, player: '$p' },
      ],
      targets: [{ id: 'p', filter: { player: 'any' } }],
      done: true,
    });
  });

  it('a token with a body and a keyword', () => {
    expect(parse('Create two 1/1 white Soldier creature tokens.').effects).toEqual([
      {
        op: 'createToken',
        token: {
          name: 'Soldier',
          types: ['creature'],
          subtypes: ['Soldier'],
          colors: ['W'],
          power: 1,
          toughness: 1,
        },
        count: 2,
      },
    ]);
  });

  it('counters on each creature you control', () => {
    expect(parse('Put a +1/+1 counter on each creature you control.').effects).toEqual([
      {
        op: 'forEach',
        filter: { type: 'creature', controller: 'you' },
        as: 'c',
        effects: [{ op: 'addCounters', target: 'c', counter: '+1/+1', count: 1 }],
      },
    ]);
  });

  it('a type list with an Oxford comma', () => {
    expect(parse('Tap target artifact, creature, or land.').targets).toEqual([
      { id: 't', filter: { type: ['artifact', 'creature', 'land'] } },
    ]);
  });

  it('search, put onto the battlefield tapped, then shuffle', () => {
    expect(
      parse(
        'Search your library for a basic land card, put that card onto the battlefield tapped, then shuffle.',
      ).effects,
    ).toEqual([
      {
        op: 'search',
        filter: { type: 'land', supertype: 'basic' },
        count: 1,
        to: 'battlefield',
        tapped: true,
      },
      { op: 'shuffle' },
    ]);
  });

  it('an "equal to the number of" quantity', () => {
    expect(parse('You gain life equal to the number of creatures you control.').effects).toEqual([
      { op: 'gainLife', amount: { count: { type: 'creature', controller: 'you' } } },
    ]);
  });

  it('refuses text it does not understand rather than guessing', () => {
    expect(parse('Exchange control of two target permanents.').effects).toBeNull();
  });
});

describe('ability grammars', () => {
  it('reads an activated ability with a compound cost', () => {
    expect(
      parseActivated(
        '{R}, {T}, Exile two cards from your graveyard: ~ deals 2 damage to any target.',
      ).value,
    ).toEqual({
      kind: 'activated',
      cost: { mana: '{R}', tap: true, exileFromGraveyard: { count: 2 } },
      targets: [{ id: 't', filter: { any: true } }],
      effects: [{ op: 'damage', amount: 2, to: '$t' }],
    });
  });

  it('reads a mana ability rather than an activated one', () => {
    expect(parseActivated('{T}: Add {G} or {U}.').value).toEqual({
      kind: 'mana',
      cost: { tap: true },
      choice: ['{G}', '{U}'],
    });
  });

  it('reads an enters trigger', () => {
    expect(parseTriggered('When ~ enters, draw a card.').value).toEqual({
      kind: 'triggered',
      trigger: { on: 'etb', filter: 'self' },
      effects: [{ op: 'draw', count: 1 }],
    });
  });

  it('reads a beginning-of-step trigger', () => {
    expect(parseTriggered('At the beginning of the end step, sacrifice ~.').value).toEqual({
      kind: 'triggered',
      trigger: { on: 'endStep', who: 'any' },
      effects: [{ op: 'sacrifice', target: '~' }],
    });
  });

  it('reads an anthem', () => {
    expect(parseStatic('Creatures you control get +1/+1.').value).toEqual({
      kind: 'static',
      effect: {
        type: 'pt',
        affects: { type: 'creature', controller: 'you' },
        power: 1,
        toughness: 1,
      },
    });
  });

  it('reads an Aura that grants P/T and a keyword', () => {
    expect(parseStatic('Enchanted creature gets +2/+1 and has menace.').value).toEqual({
      kind: 'static',
      effect: { type: 'pt', affects: 'attached', power: 2, toughness: 1 },
      also: [
        {
          type: 'addAbility',
          affects: 'attached',
          ability: { kind: 'keyword', keyword: 'menace' },
        },
      ],
    });
  });

  it('reads a conditional static ability', () => {
    expect(parseStatic('~ gets +1/+2 as long as you control a Forest.').value).toEqual({
      kind: 'static',
      effect: { type: 'pt', affects: 'self', power: 1, toughness: 2 },
      condition: { controls: { subtype: 'Forest' }, count: 1 },
    });
  });

  it('reads "enters tapped unless" as a gated replacement effect', () => {
    expect(parseStatic('~ enters tapped unless you control a Plains or an Island.').value).toEqual({
      kind: 'replacement',
      replaces: { event: 'etb', filter: 'self', tapped: true },
      condition: { not: { controls: { subtype: ['Plains', 'Island'] }, count: 1 } },
    });
  });

  it('reports where it gave up', () => {
    const r = parseTriggered('Whenever ~ becomes the target of a spell, counter that spell.');
    expect(r.value).toBeNull();
    expect(r.failure).toContain('trigger');
  });
});
