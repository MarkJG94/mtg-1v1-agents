import type { Condition, DurationDef, Filter, Keyword, Quantity } from '@mtg/engine';
import type { CardType, Color, Supertype } from '@mtg/shared';
import type { Scanner } from './scan.js';

/** Number words Magic templating uses; anything larger is spelled with digits. */
const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
};

export const COLOR_WORDS: Record<string, Color> = {
  white: 'W',
  blue: 'U',
  black: 'B',
  red: 'R',
  green: 'G',
};

const TYPE_WORDS: Record<string, CardType> = {
  creature: 'creature',
  creatures: 'creature',
  artifact: 'artifact',
  artifacts: 'artifact',
  enchantment: 'enchantment',
  enchantments: 'enchantment',
  land: 'land',
  lands: 'land',
  instant: 'instant',
  instants: 'instant',
  sorcery: 'sorcery',
  sorceries: 'sorcery',
  planeswalker: 'planeswalker',
  planeswalkers: 'planeswalker',
};

const SUPERTYPE_WORDS: Record<string, Supertype> = {
  legendary: 'legendary',
  basic: 'basic',
  snow: 'snow',
};

/** Evergreen keywords the grammar can name in "with flying", "gains trample" and keyword lines. */
export const KEYWORD_WORDS: Record<string, Keyword> = {
  flying: 'flying',
  'first strike': 'first strike',
  'double strike': 'double strike',
  deathtouch: 'deathtouch',
  haste: 'haste',
  hexproof: 'hexproof',
  indestructible: 'indestructible',
  lifelink: 'lifelink',
  menace: 'menace',
  reach: 'reach',
  trample: 'trample',
  vigilance: 'vigilance',
  defender: 'defender',
  flash: 'flash',
  shroud: 'shroud',
  'split second': 'split second',
};

/**
 * Words the grammar itself uses. A capitalised word outside this set is taken to be a creature/land
 * subtype ("target Goblin", "a Mountain card"), which is how oracle text distinguishes the two.
 */
const RESERVED = new Set(
  [
    ...Object.keys(NUMBER_WORDS),
    ...Object.keys(COLOR_WORDS),
    ...Object.keys(TYPE_WORDS),
    ...Object.keys(SUPERTYPE_WORDS),
    ...Object.keys(KEYWORD_WORDS).flatMap((k) => k.split(' ')),
    'the',
    'that',
    'this',
    'these',
    'those',
    'it',
    'its',
    'their',
    'them',
    'they',
    'you',
    'your',
    'yours',
    'each',
    'all',
    'any',
    'another',
    'other',
    'target',
    'up',
    'to',
    'of',
    'or',
    'and',
    'with',
    'without',
    'from',
    'in',
    'into',
    'onto',
    'on',
    'at',
    'as',
    'by',
    'for',
    'is',
    'are',
    'be',
    'been',
    'have',
    'has',
    'had',
    'do',
    'does',
    'don',
    'doesn',
    'can',
    'cant',
    'if',
    'unless',
    'when',
    'whenever',
    'then',
    'than',
    'where',
    'while',
    'until',
    'end',
    'turn',
    'beginning',
    'step',
    'upkeep',
    'combat',
    'damage',
    'life',
    'card',
    'cards',
    'counter',
    'counters',
    'permanent',
    'permanents',
    'spell',
    'spells',
    'token',
    'tokens',
    'player',
    'players',
    'opponent',
    'opponents',
    'controller',
    'controllers',
    'owner',
    'owners',
    'library',
    'graveyard',
    'battlefield',
    'hand',
    'exile',
    'draw',
    'draws',
    'destroy',
    'exiles',
    'gain',
    'gains',
    'gained',
    'lose',
    'loses',
    'put',
    'puts',
    'create',
    'creates',
    'deals',
    'deal',
    'dealt',
    'return',
    'returns',
    'search',
    'shuffle',
    'tap',
    'taps',
    'tapped',
    'untap',
    'untaps',
    'untapped',
    'sacrifice',
    'sacrifices',
    'discard',
    'discards',
    'mill',
    'mills',
    'scry',
    'surveil',
    'add',
    'adds',
    'prevent',
    'prevented',
    'choose',
    'chooses',
    'may',
    'must',
    'enters',
    'dies',
    'attack',
    'attacks',
    'attacking',
    'block',
    'blocks',
    'blocking',
    'blocked',
    'equip',
    'equipped',
    'enchant',
    'enchanted',
    'fights',
    'regenerate',
    'reveal',
    'reveals',
    'look',
    'take',
    'extra',
    'number',
    'many',
    'more',
    'less',
    'greater',
    'fewer',
    'equal',
    'power',
    'toughness',
    'mana',
    'value',
    'colorless',
    'multicolored',
    'nonland',
    'noncreature',
    'nonartifact',
    'nonenchantment',
    'nonbasic',
    'nontoken',
    'noncolored',
    'base',
    'abilities',
    'ability',
    'control',
    'controls',
    'an',
    'nonblack',
    'nonwhite',
    'nonblue',
    'nonred',
    'nongreen',
  ].map((w) => w.toLowerCase()),
);

/** Subtypes whose singular already ends in "s"; stripping it would invent a type that does not exist. */
const SINGULAR_IN_S = new Set(['plains', 'cyclops', 'pegasus', 'lotus']);

function singularSubtype(word: string): string {
  return SINGULAR_IN_S.has(word.toLowerCase()) ? word : word.replace(/s$/, '');
}

/** Whether the token at `off` can continue a type/subtype list ("artifact or enchantment", "a Plains or an Island"). */
function continuesTypeList(s: Scanner, off: number): boolean {
  const t = s.peek(off);
  if (!t) return false;
  if (TYPE_WORDS[t.lower] || SUPERTYPE_WORDS[t.lower] || COLOR_WORDS[t.lower]) return true;
  return t.kind === 'word' && /^[A-Z]/.test(t.text) && !RESERVED.has(t.lower);
}

/**
 * Consumes the separator between list items ("artifact or enchantment", "artifact, creature, or land",
 * "a Plains or an Island") only when another item actually follows — otherwise the "and" belongs to the
 * next effect clause.
 */
function eatConjunction(s: Scanner): void {
  let skip = 0;
  const isSeparator = (w: string | undefined): boolean => w === 'or' || w === 'and' || w === ',';
  while (isSeparator(s.peek(skip)?.lower)) skip++;
  if (skip === 0) return;
  const after = s.peek(skip)?.lower;
  if (after === 'a' || after === 'an' || after === 'the') skip++;
  if (!continuesTypeList(s, skip)) return;
  for (let k = 0; k < skip; k++) s.next();
}

/** A number, `X`, or a spelled-out count. Returns null when the next token is not a quantity. */
export function parseCount(s: Scanner): Quantity | null {
  const t = s.peek();
  if (!t) return null;
  if (t.kind === 'number') {
    s.next();
    return Number(t.text);
  }
  if (t.lower === 'x') {
    s.next();
    return 'x';
  }
  const n = NUMBER_WORDS[t.lower];
  if (n !== undefined) {
    s.next();
    return n;
  }
  return null;
}

/** `parseCount` restricted to literal integers (token counts, counter counts, P/T). */
export function parseInt_(s: Scanner): number | null {
  const q = s.attempt(() => parseCount(s));
  return typeof q === 'number' ? q : null;
}

export function parseDuration(s: Scanner): DurationDef | null {
  if (s.eat('until end of turn')) return 'untilEndOfTurn';
  if (s.eat('until your next turn')) return 'untilYourNextTurn';
  if (s.eat('this turn')) return 'untilEndOfTurn';
  return null;
}

/** Splits a mana token (`{1}{R}`) into its symbols. */
export function manaSymbols(text: string): string[] {
  return text.match(/\{[^}]*\}/g) ?? [];
}

export type PlayerPhrase =
  | { kind: 'you' }
  | { kind: 'each' }
  | { kind: 'eachOpponent' }
  | { kind: 'target'; filter: Filter }
  | { kind: 'anaphor'; word: 'that player' | 'its controller' | 'its owner' };

/** Player-valued noun phrases: "you", "target player", "each opponent", "that player". */
export function parsePlayerPhrase(s: Scanner): PlayerPhrase | null {
  return s.attempt<PlayerPhrase>(() => {
    if (s.eat('you')) return { kind: 'you' };
    if (s.eat('each player') || s.eat('all players')) return { kind: 'each' };
    if (s.eat('each opponent')) return { kind: 'eachOpponent' };
    if (s.eat('target player')) return { kind: 'target', filter: { player: 'any' } };
    if (s.eat('target opponent')) return { kind: 'target', filter: { player: 'opponent' } };
    if (s.eat('that player')) return { kind: 'anaphor', word: 'that player' };
    if (s.eat('its controller')) return { kind: 'anaphor', word: 'its controller' };
    if (s.eat('its owner')) return { kind: 'anaphor', word: 'its owner' };
    return null;
  });
}

export interface ObjectPhrase {
  filter: Filter;
  /** "target ..." — the caller turns this into a TargetSpec. */
  targeted: boolean;
  /** "each"/"all" — a mass selection rather than one object. */
  mass: boolean;
  /** "up to N target creatures" / "two target creatures". */
  count?: number | { upTo: number };
  /** "~", "it", "that creature" — resolved by the caller against its bindings. */
  anaphor?: 'self' | 'it' | 'that';
}

function mergeType(f: Filter, types: CardType[]): void {
  if (types.length === 1) f.type = types[0]!;
  else if (types.length > 1) f.type = types;
}

/**
 * Object noun phrases: determiner, adjectives, head noun and post-modifiers
 * ("up to two target nonblack creatures an opponent controls with power 3 or greater").
 */
export function parseObjectPhrase(s: Scanner): ObjectPhrase | null {
  return s.attempt<ObjectPhrase>(() => {
    if (s.eat('any target')) return { filter: { any: true }, targeted: true, mass: false };
    if (s.eat('~'))
      return { filter: { self: true }, targeted: false, mass: false, anaphor: 'self' };

    const out: ObjectPhrase = { filter: {}, targeted: false, mass: false };
    let count: number | { upTo: number } | undefined;
    if (s.eat('up to')) {
      const n = parseInt_(s);
      if (n === null) return null;
      count = { upTo: n };
    } else if (s.eat('each') || s.eat('all') || s.eat('every')) {
      out.mass = true;
    } else {
      const n = s.attempt(() => {
        const v = parseInt_(s);
        // "a"/"an"/"one" are determiners, not counts worth recording.
        return v === null ? null : v;
      });
      if (n !== null && n > 1) count = n;
    }
    if (s.eat('target')) out.targeted = true;
    if (count !== undefined) out.count = count;
    // "each target creature" is not templating; a count without `target` still reads as a determiner.
    const f = out.filter;
    const types: CardType[] = [];
    const subtypes: string[] = [];
    const notColors: Color[] = [];
    let sawHead = false;
    let progress = false;

    for (;;) {
      const t = s.peek();
      if (!t) break;
      const w = t.lower;
      if (w === 'another' || w === 'other') {
        s.next();
        f.other = true;
        progress = true;
        continue;
      }
      if (w === 'nontoken') {
        s.next();
        f.nonToken = true;
        progress = true;
        continue;
      }
      if (w === 'colorless') {
        s.next();
        f.colorless = true;
        progress = true;
        continue;
      }
      if (w === 'multicolored') {
        s.next();
        f.multicolored = true;
        progress = true;
        continue;
      }
      if (w === 'tapped' || w === 'untapped') {
        s.next();
        if (w === 'tapped') f.tapped = true;
        else f.untapped = true;
        progress = true;
        continue;
      }
      if (w === 'attacking' || w === 'blocking' || w === 'blocked') {
        s.next();
        if (w === 'attacking') f.attacking = true;
        else if (w === 'blocking') f.blocking = true;
        else f.blocked = true;
        progress = true;
        continue;
      }
      if (COLOR_WORDS[w]) {
        s.next();
        const c = COLOR_WORDS[w]!;
        f.color =
          f.color === undefined ? c : [...(Array.isArray(f.color) ? f.color : [f.color]), c];
        progress = true;
        continue;
      }
      if (w.startsWith('non') && COLOR_WORDS[w.slice(3)]) {
        s.next();
        notColors.push(COLOR_WORDS[w.slice(3)]!);
        progress = true;
        continue;
      }
      if (w.startsWith('non') && TYPE_WORDS[w.slice(3)]) {
        s.next();
        const nt = TYPE_WORDS[w.slice(3)]!;
        f.notType =
          f.notType === undefined
            ? nt
            : [...(Array.isArray(f.notType) ? f.notType : [f.notType]), nt];
        progress = true;
        continue;
      }
      if (w === 'nonbasic') {
        s.next();
        f.not = { ...(f.not ?? {}), supertype: 'basic' };
        progress = true;
        continue;
      }
      if (SUPERTYPE_WORDS[w]) {
        s.next();
        f.supertype = SUPERTYPE_WORDS[w]!;
        progress = true;
        continue;
      }
      if (TYPE_WORDS[w]) {
        s.next();
        types.push(TYPE_WORDS[w]!);
        progress = true;
        // A type word is also a valid head; keep going for "artifact creature" or "artifact or enchantment",
        // but only consume a conjunction when another type or subtype actually follows it.
        eatConjunction(s);
        continue;
      }
      if (w === 'permanent' || w === 'permanents') {
        s.next();
        sawHead = true;
        progress = true;
        break;
      }
      if (w === 'card' || w === 'cards') {
        s.next();
        sawHead = true;
        progress = true;
        break;
      }
      if (w === 'spell' || w === 'spells') {
        s.next();
        f.spell = true;
        sawHead = true;
        progress = true;
        break;
      }
      if (w === 'token' || w === 'tokens') {
        s.next();
        f.isToken = true;
        sawHead = true;
        progress = true;
        break;
      }
      // A capitalised word the grammar does not use is a subtype ("target Goblin", "a Mountain card").
      if (t.kind === 'word' && /^[A-Z]/.test(t.text) && !RESERVED.has(w)) {
        s.next();
        subtypes.push(singularSubtype(t.text));
        progress = true;
        eatConjunction(s);
        continue;
      }
      break;
    }
    if (!progress) return null;
    if (!sawHead && types.length === 0 && subtypes.length === 0) return null;
    mergeType(f, types);
    if (subtypes.length === 1) f.subtype = subtypes[0]!;
    else if (subtypes.length > 1) f.subtype = subtypes;
    if (notColors.length > 0) {
      const nc: Filter = notColors.length === 1 ? { color: notColors[0]! } : { color: notColors };
      f.not = f.not ? { and: [f.not, nc] } : nc;
    }
    parseObjectPostModifiers(s, f);
    return out;
  });
}

/** "you control", "an opponent controls", "with flying", "with mana value 3 or less", "in your graveyard". */
function parseObjectPostModifiers(s: Scanner, f: Filter): void {
  for (;;) {
    if (s.eat('you control') || s.eat('you controls')) {
      f.controller = 'you';
      continue;
    }
    if (
      s.eat("you don't control") ||
      s.eat('an opponent controls') ||
      s.eat('your opponents control')
    ) {
      f.controller = 'opponent';
      continue;
    }
    if (s.eat('in your graveyard') || s.eat('from your graveyard')) {
      f.zone = 'graveyard';
      f.controller = 'you';
      continue;
    }
    if (s.eat('in a graveyard') || s.eat('from a graveyard')) {
      f.zone = 'graveyard';
      continue;
    }
    const withMod = s.attempt(() => {
      if (!s.eat('with')) return null;
      const kw = eatKeyword(s);
      if (kw) {
        f.hasKeyword = kw;
        return true;
      }
      if (s.eat('mana value')) {
        const n = parseInt_(s);
        if (n === null) return null;
        if (s.eat('or less')) f.mvLTE = n;
        else if (s.eat('or greater')) f.mvGTE = n;
        else f.mvEQ = n;
        return true;
      }
      if (s.eat('power')) {
        const n = parseInt_(s);
        if (n === null) return null;
        if (s.eat('or less')) f.powerLTE = n;
        else if (s.eat('or greater')) f.powerGTE = n;
        else return null;
        return true;
      }
      if (s.eat('toughness')) {
        const n = parseInt_(s);
        if (n === null) return null;
        if (s.eat('or less')) f.toughnessLTE = n;
        else if (s.eat('or greater')) f.toughnessGTE = n;
        else return null;
        return true;
      }
      return null;
    });
    if (withMod) continue;
    const without = s.attempt(() => {
      if (!s.eat('without')) return null;
      const kw = eatKeyword(s);
      if (!kw) return null;
      f.lacksKeyword = kw;
      return true;
    });
    if (without) continue;
    return;
  }
}

/** Consumes a keyword name (including the two-word ones) and returns it. */
export function eatKeyword(s: Scanner): Keyword | null {
  for (const k of Object.keys(KEYWORD_WORDS).sort((a, b) => b.length - a.length))
    if (s.eat(k)) return KEYWORD_WORDS[k]!;
  return null;
}

/** "if you control a Plains", "if that player controls two or more creatures". */
export function parseCondition(s: Scanner): Condition | null {
  return s.attempt<Condition>(() => {
    if (s.eat("it's your turn") || s.eat('it is your turn')) return { isYourTurn: true };
    const who = parsePlayerPhrase(s);
    if (!who) return null;
    if (!s.eat('control') && !s.eat('controls')) return null;
    const obj = parseObjectPhrase(s);
    if (!obj) return null;
    const count = typeof obj.count === 'number' ? obj.count : 1;
    const cond: Condition = { controls: obj.filter, count };
    if (who.kind === 'you') return cond;
    return null;
  });
}
