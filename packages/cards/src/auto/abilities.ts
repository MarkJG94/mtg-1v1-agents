import type {
  AbilityDef,
  Condition,
  CostDef,
  Effect,
  Filter,
  Keyword,
  StaticEffectDef,
  TriggerDef,
} from '@mtg/engine';
import { applyNoRegenerate, Bindings, parseEffects } from './effects.js';
import {
  COLOR_WORDS,
  eatKeyword,
  KEYWORD_WORDS,
  manaSymbols,
  parseCondition,
  parseInt_,
  parseObjectPhrase,
} from './phrases.js';
import { Scanner } from './scan.js';

export type SentenceKind =
  | 'keyword'
  | 'enchant'
  | 'equip'
  | 'additionalCost'
  | 'loyalty'
  | 'activated'
  | 'triggered'
  | 'static'
  | 'spell';

export interface CardShape {
  types: readonly string[];
  /** Scryfall's `keywords` array, used to cross-check the keyword lines (docs/03 §Auto-scripter step 1). */
  keywords: readonly string[];
}

const LOYALTY = /^[+-]?\d+\s*:/;

/**
 * Keyword abilities the engine has no rules for. They are named so the coverage report says "keyword
 * ability X" instead of blaming whichever grammar rule tripped over the cost that follows the word.
 */
const UNIMPLEMENTED_KEYWORD_ABILITIES = new Set([
  'adapt',
  'affinity',
  'afflict',
  'afterlife',
  'aftermath',
  'amass',
  'amplify',
  'annihilator',
  'ascend',
  'backup',
  'bargain',
  'bestow',
  'blitz',
  'bloodthirst',
  'bushido',
  'buyback',
  'cascade',
  'casualty',
  'champion',
  'changeling',
  'cipher',
  'companion',
  'connive',
  'conspire',
  'convoke',
  'craft',
  'crew',
  'cumulative',
  'cycling',
  'dash',
  'daybound',
  'delve',
  'dethrone',
  'devoid',
  'devour',
  'disguise',
  'disturb',
  'dredge',
  'echo',
  'embalm',
  'emerge',
  'encore',
  'entwine',
  'epic',
  'escalate',
  'escape',
  'eternalize',
  'evoke',
  'evolve',
  'exalted',
  'exploit',
  'explore',
  'extort',
  'fabricate',
  'fading',
  'fear',
  'flashback',
  'forecast',
  'foretell',
  'fortify',
  'frenzy',
  'fuse',
  'graft',
  'gravestorm',
  'haunt',
  'hideaway',
  'horsemanship',
  'improvise',
  'infect',
  'ingest',
  'intimidate',
  'kicker',
  'landcycling',
  'level',
  'madness',
  'melee',
  'mentor',
  'miracle',
  'modular',
  'morph',
  'mutate',
  'myriad',
  'ninjutsu',
  'offering',
  'offspring',
  'outlast',
  'overload',
  'partner',
  'persist',
  'phasing',
  'plot',
  'poisonous',
  'prowess',
  'prowl',
  'provoke',
  'rampage',
  'ravenous',
  'rebound',
  'reconfigure',
  'recover',
  'reinforce',
  'renown',
  'replicate',
  'retrace',
  'riot',
  'ripple',
  'saddle',
  'scavenge',
  'shadow',
  'soulbond',
  'soulshift',
  'spectacle',
  'splice',
  'storm',
  'sunburst',
  'surge',
  'suspend',
  'toxic',
  'training',
  'transfigure',
  'transmute',
  'tribute',
  'undaunted',
  'undying',
  'unearth',
  'unleash',
  'vanishing',
  'wither',
]);

/** The keyword-ability name a line announces, when the engine cannot play it. */
export function unimplementedKeyword(sentence: string): string | null {
  const first = /^([a-z][a-z-]*)\b/i.exec(sentence.trim());
  if (!first) return null;
  const word = first[1]!.toLowerCase();
  return UNIMPLEMENTED_KEYWORD_ABILITIES.has(word) ? word : null;
}

/** Which grammar a sentence belongs to. Permanents default to static text, spells to spell text. */
export function classify(sentence: string, card: CardShape): SentenceKind {
  const t = sentence.trim();
  if (LOYALTY.test(t)) return 'loyalty';
  if (/^enchant\s/i.test(t)) return 'enchant';
  if (/^equip\s/i.test(t)) return 'equip';
  if (/^as an additional cost to cast (this spell|~),/i.test(t)) return 'additionalCost';
  if (parseKeywordLine(t) !== null) return 'keyword';
  if (/^(when|whenever|at the beginning)\b/i.test(stripAbilityWord(t))) return 'triggered';
  if (/:/.test(t)) return 'activated';
  const isSpell = card.types.includes('instant') || card.types.includes('sorcery');
  return isSpell ? 'spell' : 'static';
}

/** Ability words ("Landfall — Whenever …") carry no rules meaning. */
export function stripAbilityWord(sentence: string): string {
  const m = /^[A-Za-z' ]+\s--\s(.*)$/.exec(sentence.replace(/—/g, '--'));
  return m ? m[1]! : sentence;
}

/** A whole line of keywords: "Flying, vigilance", "Protection from white", "Trample". */
export function parseKeywordLine(line: string): AbilityDef[] | null {
  const s = Scanner.of(line);
  const out: AbilityDef[] = [];
  for (;;) {
    const kw = eatKeyword(s);
    if (kw) out.push({ kind: 'keyword', keyword: kw });
    else if (s.eat('protection from')) {
      const w = s.kind('word');
      const color = w ? COLOR_WORDS[w.lower] : undefined;
      if (!color) return null;
      out.push({ kind: 'keyword', keyword: 'protection', from: { color } });
    } else if (s.eat('this spell') || s.eat('~')) {
      if (!s.eat("can't be countered")) return null;
      out.push({ kind: 'keyword', keyword: 'cant be countered' });
    } else return null;
    if (s.finish()) return out.length > 0 ? out : null;
    if (!s.eat(',') && !s.eat('and')) return null;
  }
}

/** Keywords Scryfall lists that the script did not produce — the cross-check in docs/03 step 1. */
export function missingKeywords(emitted: AbilityDef[], card: CardShape): string[] {
  const have = new Set(
    emitted.filter((a) => a.kind === 'keyword').map((a) => String(a.keyword).toLowerCase()),
  );
  return card.keywords
    .map((k) => k.toLowerCase())
    .filter((k) => KEYWORD_WORDS[k] !== undefined && !have.has(k));
}

/** Cost parts of an activated ability: "{R}, {T}, Exile two cards from your graveyard". */
export function parseCost(s: Scanner): CostDef | null {
  const cost: CostDef = {};
  let any = false;
  for (;;) {
    const m = s.kind('mana');
    if (m) {
      const symbols = manaSymbols(m.text);
      const mana = symbols.filter((x) => x !== '{T}' && x !== '{Q}');
      if (symbols.includes('{T}')) cost.tap = true;
      if (symbols.includes('{Q}')) cost.untap = true;
      if (mana.length > 0) cost.mana = (cost.mana ?? '') + mana.join('');
      if (mana.some((x) => x === '{X}')) cost.x = true;
      any = true;
    } else if (s.eat('sacrifice ~') || s.eat('sacrifice this creature')) {
      cost.sacrifice = 'self';
      any = true;
    } else if (s.at('sacrifice')) {
      s.next();
      const obj = parseObjectPhrase(s);
      if (!obj || obj.targeted) return null;
      cost.sacrifice = obj.filter;
      any = true;
    } else if (s.eat('pay')) {
      const n = parseInt_(s);
      if (n === null || !s.eat('life')) return null;
      cost.life = n;
      any = true;
    } else if (s.eat('discard')) {
      const n = parseInt_(s);
      if (n === null || (!s.eat('card') && !s.eat('cards'))) return null;
      cost.discard = n;
      any = true;
    } else if (s.eat('exile')) {
      const n = parseInt_(s);
      if (n === null || (!s.eat('cards') && !s.eat('card'))) return null;
      if (!s.eat('from your graveyard')) return null;
      cost.exileFromGraveyard = { count: n };
      any = true;
    } else return null;
    if (!s.eat(',')) return any ? cost : null;
  }
}

/** "Add {G}", "Add {G} or {U}", "Add one mana of any color", "Add {C}{C}". */
function parseManaProduction(
  s: Scanner,
): { produces?: string; choice?: string[]; anyColor?: true } | null {
  if (!s.eat('add')) return null;
  if (s.eat('one mana of any color')) return { anyColor: true };
  const first = s.kind('mana');
  if (!first) return null;
  const options = [first.text];
  while (s.eat('or')) {
    const m = s.kind('mana');
    if (!m) return null;
    options.push(m.text);
  }
  if (!s.finish()) return null;
  return options.length === 1 ? { produces: options[0]! } : { choice: options };
}

export interface ParseResult<T> {
  value: T | null;
  /** What stopped the parse, for the coverage report's top failing patterns. */
  failure: string | null;
}

const fail = <T>(where: string): ParseResult<T> => ({ value: null, failure: where });

/** `[cost]: [effects]` — a mana ability when every effect only adds mana, otherwise activated. */
export function parseActivated(sentence: string): ParseResult<AbilityDef> {
  const colon = sentence.indexOf(':');
  if (colon < 0) return fail('no cost/effect separator');
  const cs = Scanner.of(sentence.slice(0, colon));
  const cost = parseCost(cs);
  if (!cost || !cs.done) return fail(`cost: ${cs.remainder() || sentence.slice(0, colon)}`);
  const body = sentence.slice(colon + 1).trim();
  const ms = Scanner.of(body);
  const mana = ms.attempt(() => parseManaProduction(ms));
  if (mana) return { value: { kind: 'mana', cost, ...mana }, failure: null };
  const s = Scanner.of(body);
  const b = new Bindings();
  const effects = parseEffects(s, b);
  if (!effects || !s.finish()) return fail(`effect: ${s.remainder() || body}`);
  const ability: AbilityDef = { kind: 'activated', cost, effects: applyNoRegenerate(effects, b) };
  if (b.targets.length > 0) ability.targets = b.targets;
  return { value: ability, failure: null };
}

/** The trigger event of "When/Whenever/At the beginning of …, <effects>". */
function parseTrigger(s: Scanner): TriggerDef | null {
  return s.attempt<TriggerDef>(() => {
    if (s.eat('at the beginning of')) {
      if (s.eat('your upkeep')) return { on: 'upkeep', who: 'you' };
      if (s.eat("each opponent's upkeep")) return { on: 'upkeep', who: 'opponent' };
      if (s.eat('each upkeep') || s.eat("each player's upkeep"))
        return { on: 'upkeep', who: 'any' };
      if (s.eat('your end step')) return { on: 'endStep', who: 'you' };
      if (s.eat("each opponent's end step")) return { on: 'endStep', who: 'opponent' };
      if (s.eat('the end step') || s.eat('each end step') || s.eat("each player's end step"))
        return { on: 'endStep', who: 'any' };
      if (s.eat('combat on your turn') || s.eat('your combat'))
        return { on: 'beginCombat', who: 'you' };
      if (s.eat('each combat')) return { on: 'beginCombat', who: 'any' };
      return null;
    }
    if (!s.eat('when') && !s.eat('whenever')) return null;
    if (s.eat('you gain life')) return { on: 'lifeGain', who: 'you' };
    const caster = s.attempt(() => {
      if (s.eat('you cast')) return 'you' as const;
      if (s.eat('an opponent casts')) return 'opponent' as const;
      if (s.eat('a player casts')) return 'any' as const;
      return null;
    });
    if (caster) {
      const spell = parseObjectPhrase(s);
      if (!spell || spell.targeted) return null;
      return { on: 'cast', filter: { ...spell.filter, spell: true }, who: caster };
    }
    if (
      s.eat('a land enters the battlefield under your control') ||
      s.eat('a land you control enters')
    )
      return { on: 'landfall', who: 'you' };
    const subject = s.attempt(() => {
      if (s.eat('~')) return 'self' as const;
      const obj = parseObjectPhrase(s);
      return obj && !obj.targeted ? obj.filter : null;
    });
    if (subject === null) return null;
    // "Whenever ~ or another creature dies" — the wider clause wins.
    const wider = s.attempt(() => {
      if (!s.eat('or another')) return null;
      const obj = parseObjectPhrase(s);
      return obj ? obj.filter : null;
    });
    const filter: Filter | 'self' = wider ?? subject;
    if (s.eat('enters the battlefield') || s.eat('enters')) {
      // "…enters the battlefield under your control" narrows who controls it; it is not noise to drop.
      if (filter !== 'self') {
        if (s.eat('under your control'))
          return { on: 'etb', filter: { ...filter, controller: 'you' } };
        if (s.eat("under an opponent's control"))
          return { on: 'etb', filter: { ...filter, controller: 'opponent' } };
      }
      return { on: 'etb', filter };
    }
    if (s.eat('dies')) return { on: 'dies', filter };
    if (s.eat('leaves the battlefield')) return { on: 'ltb', filter };
    if (s.eat('attacks')) return { on: 'attacks', filter };
    if (s.eat('blocks')) return { on: 'blocks', filter };
    if (s.eat('becomes blocked')) return { on: 'becomesBlocked', filter };
    if (s.eat('becomes tapped')) return { on: 'tapped', filter };
    if (s.eat('is put into a graveyard from the battlefield')) return { on: 'dies', filter };
    if (s.eat('deals combat damage to a player'))
      return { on: 'dealsDamage', filter, combat: true, toPlayer: true };
    if (s.eat('deals combat damage')) return { on: 'dealsDamage', filter, combat: true };
    if (s.eat('deals damage to a player') || s.eat('deals damage to an opponent'))
      return { on: 'dealsDamage', filter, toPlayer: true };
    if (s.eat('deals damage')) return { on: 'dealsDamage', filter };
    if (s.eat('is dealt damage')) return { on: 'dealtDamage', filter };
    if (s.eat('is sacrificed')) return { on: 'sacrificed', filter };
    return null;
  });
}

export function parseTriggered(sentence: string): ParseResult<AbilityDef> {
  const s = Scanner.of(stripAbilityWord(sentence));
  const trigger = parseTrigger(s);
  if (!trigger) return fail(`trigger: ${sentence}`);
  if (!s.eat(',')) return fail(`trigger: missing comma in "${sentence}"`);
  const b = new Bindings();
  const effects = parseEffects(s, b);
  if (!effects || !s.finish()) return fail(`effect: ${s.remainder() || sentence}`);
  const ability: AbilityDef = {
    kind: 'triggered',
    trigger,
    effects: applyNoRegenerate(effects, b),
  };
  if (b.targets.length > 0) ability.targets = b.targets;
  return { value: ability, failure: null };
}

export function parseLoyalty(sentence: string): ParseResult<AbilityDef> {
  const colon = sentence.indexOf(':');
  const cost = Number(sentence.slice(0, colon).replace(/−/g, '-').trim());
  if (!Number.isFinite(cost)) return fail(`loyalty cost: ${sentence}`);
  const s = Scanner.of(sentence.slice(colon + 1).trim());
  const b = new Bindings();
  const effects = parseEffects(s, b);
  if (!effects || !s.finish()) return fail(`effect: ${s.remainder() || sentence}`);
  const ability: AbilityDef = { kind: 'loyalty', cost, effects: applyNoRegenerate(effects, b) };
  if (b.targets.length > 0) ability.targets = b.targets;
  return { value: ability, failure: null };
}

/** "Enchant creature" becomes the Aura's targeting spell ability (see the hand script for Pacifism). */
export function parseEnchant(sentence: string): ParseResult<AbilityDef> {
  const s = Scanner.of(sentence);
  if (!s.eat('enchant')) return fail(`enchant: ${sentence}`);
  const obj = parseObjectPhrase(s);
  if (!obj || !s.finish()) return fail(`enchant: ${s.remainder() || sentence}`);
  return {
    value: { kind: 'spell', targets: [{ id: 'e', filter: obj.filter }], effects: [] },
    failure: null,
  };
}

/** "haste and shroud", "flying, first strike and vigilance". */
function eatKeywordList(s: Scanner): Keyword[] | null {
  const out: Keyword[] = [];
  for (;;) {
    const kw = eatKeyword(s);
    if (!kw) return out.length > 0 ? out : null;
    out.push(kw);
    if (!s.eat(',') && !s.eat('and')) return out;
  }
}

/** "Equip {1}" — the Equipment's activated ability (CR 702.6), which oracle text leaves implicit. */
export function parseEquip(sentence: string): ParseResult<AbilityDef> {
  const s = Scanner.of(sentence);
  if (!s.eat('equip')) return fail(`equip: ${sentence}`);
  const cost = parseCost(s);
  if (!cost || !s.finish()) return fail(`equip cost: ${s.remainder() || sentence}`);
  return {
    value: {
      kind: 'activated',
      cost,
      timing: 'sorcery',
      targets: [{ id: 'c', filter: { type: 'creature', controller: 'you' } }],
      effects: [{ op: 'attach', target: '~', to: '$c' }],
    },
    failure: null,
  };
}

/** "As an additional cost to cast this spell, discard a card." */
export function parseAdditionalCost(sentence: string): ParseResult<CostDef> {
  const s = Scanner.of(sentence);
  if (
    !s.eat('as an additional cost to cast ~') &&
    !s.eat('as an additional cost to cast this spell')
  )
    return fail(`additional cost: ${sentence}`);
  if (!s.eat(',')) return fail(`additional cost: ${s.remainder()}`);
  const cost = parseCost(s);
  if (!cost || !s.finish()) return fail(`additional cost: ${s.remainder() || sentence}`);
  return { value: cost, failure: null };
}

/** The subject of a static sentence: a filter, the source, or what an Aura/Equipment is attached to. */
function parseStaticSubject(s: Scanner): Filter | 'self' | 'attached' | null {
  return s.attempt<Filter | 'self' | 'attached'>(() => {
    if (s.eat('enchanted creature') || s.eat('equipped creature') || s.eat('enchanted permanent'))
      return 'attached';
    if (s.eat('~')) return 'self';
    const obj = parseObjectPhrase(s);
    return obj && !obj.targeted ? obj.filter : null;
  });
}

export function parseStatic(sentence: string): ParseResult<AbilityDef> {
  const s = Scanner.of(sentence);

  if (s.attempt(() => (s.eat('you have no maximum hand size') && s.finish() ? true : null)))
    return {
      value: { kind: 'static', effect: { type: 'maxHandSize', player: 'you', size: 'unlimited' } },
      failure: null,
    };

  const spellsCost = s.attempt(() => {
    if (!s.eat('spells cost')) return null;
    const m = s.kind('mana');
    if (!m) return null;
    const more = s.eat('more to cast');
    if (!more || !s.finish()) return null;
    return manaSymbols(m.text).length;
  });
  if (spellsCost)
    return {
      value: {
        kind: 'static',
        effect: { type: 'costIncrease', affects: { spell: true }, amount: spellsCost },
      },
      failure: null,
    };

  // "~ enters tapped [unless …]" is a replacement effect, not a continuous one (CR 614.1c).
  const entersTapped = s.attempt(() => {
    if (!s.eat('~ enters tapped')) return null;
    if (s.finish()) return { gated: null };
    if (!s.eat('unless')) return null;
    const cond = parseCondition(s);
    if (!cond || !s.finish()) return null;
    return { gated: cond };
  });
  if (entersTapped) {
    const ability: AbilityDef = {
      kind: 'replacement',
      replaces: { event: 'etb', filter: 'self', tapped: true },
    };
    return {
      value: entersTapped.gated ? { ...ability, condition: { not: entersTapped.gated } } : ability,
      failure: null,
    };
  }

  // "You control enchanted creature." — the subject follows the verb in this one template.
  if (s.attempt(() => (s.eat('you control enchanted creature') && s.finish() ? true : null)))
    return {
      value: {
        kind: 'static',
        effect: { type: 'control', affects: 'attached', controller: 'you' },
      },
      failure: null,
    };

  if (
    s.attempt(() =>
      s.eat('you may play an additional land on each of your turns') && s.finish() ? true : null,
    )
  )
    return {
      value: { kind: 'static', effect: { type: 'extraLandDrop', player: 'you', count: 1 } },
      failure: null,
    };

  const subject = parseStaticSubject(s);
  if (subject === null) return fail(`static subject: ${sentence}`);

  const pt = s.attempt(() => {
    if (!s.eat('gets') && !s.eat('get')) return null;
    const p = s.kind('pt');
    if (!p) return null;
    const [pw, tg] = p.text.split('/');
    const pn = Number(pw);
    const tn = Number(tg);
    if (!Number.isFinite(pn) || !Number.isFinite(tn)) return null;
    // "… and has menace", "… as long as you control a Forest" both continue the same static ability.
    const extra = s.attempt(() =>
      s.eat('and has') || s.eat('and have') ? eatKeywordList(s) : null,
    );
    const when = s.attempt(() => (s.eat('as long as') ? parseCondition(s) : null));
    return s.finish() ? { power: pn, toughness: tn, extra, when } : null;
  });
  if (pt) {
    const effect: StaticEffectDef = {
      type: 'pt',
      affects: subject,
      power: pt.power,
      toughness: pt.toughness,
    };
    const also = (pt.extra ?? []).map<StaticEffectDef>((k) => ({
      type: 'addAbility',
      affects: subject,
      ability: { kind: 'keyword', keyword: k },
    }));
    return {
      value: {
        kind: 'static',
        effect,
        ...(also.length > 0 ? { also } : {}),
        ...(pt.when ? { condition: pt.when } : {}),
      },
      failure: null,
    };
  }

  const granted = s.attempt<Keyword[]>(() => {
    if (!s.eat('have') && !s.eat('has')) return null;
    const kws = eatKeywordList(s);
    return kws && s.finish() ? kws : null;
  });
  if (granted) {
    const [first, ...rest] = granted;
    const effect: StaticEffectDef = {
      type: 'addAbility',
      affects: subject,
      ability: { kind: 'keyword', keyword: first! },
    };
    const also = rest.map<StaticEffectDef>((k) => ({
      type: 'addAbility',
      affects: subject,
      ability: { kind: 'keyword', keyword: k },
    }));
    return {
      value: { kind: 'static', effect, ...(also.length > 0 ? { also } : {}) },
      failure: null,
    };
  }

  const cant = s.attempt<StaticEffectDef[]>(() => {
    if (!s.eat("can't")) return null;
    const out: StaticEffectDef[] = [];
    for (;;) {
      if (s.eat('be blocked')) out.push({ type: 'cantBeBlocked', affects: subject });
      else if (s.eat('attack')) out.push({ type: 'cantAttack', affects: subject });
      else if (s.eat('block')) out.push({ type: 'cantBlock', affects: subject });
      else return null;
      if (s.finish()) return out;
      if (!s.eat('or') && !s.eat('and')) return null;
    }
  });
  if (cant) {
    const [first, ...rest] = cant;
    return {
      value: { kind: 'static', effect: first!, ...(rest.length > 0 ? { also: rest } : {}) },
      failure: null,
    };
  }

  const doesntUntap = s.attempt(() => {
    if (!s.eat("don't untap during their controllers' untap steps"))
      if (!s.eat("doesn't untap during its controller's untap step")) return null;
    return s.finish() ? true : null;
  });
  if (doesntUntap)
    return {
      value: { kind: 'static', effect: { type: 'doesntUntap', affects: subject } },
      failure: null,
    };

  // "Each land is a Swamp in addition to its other land types." — an added subtype, not a replacement.
  const addedType = s.attempt(() => {
    if (!s.eat('is a') && !s.eat('are')) return null;
    const obj = parseObjectPhrase(s);
    if (!obj || typeof obj.filter.subtype !== 'string') return null;
    if (!s.eat('in addition to its other types') && !s.eat('in addition to its other land types'))
      return null;
    return s.finish() ? obj.filter.subtype : null;
  });
  if (addedType)
    return {
      value: {
        kind: 'static',
        effect: { type: 'addType', affects: subject, subtypes: [addedType] },
      },
      failure: null,
    };

  // "Nonbasic lands are Mountains." — the subtype is replaced outright.
  const setType = s.attempt(() => {
    if (!s.eat('are') && !s.eat('is a') && !s.eat('is')) return null;
    const obj = parseObjectPhrase(s);
    if (!obj || typeof obj.filter.subtype !== 'string' || !s.finish()) return null;
    return obj.filter.subtype;
  });
  if (setType && typeof subject === 'object' && typeof subject.type === 'string')
    return {
      value: {
        kind: 'static',
        effect: { type: 'setTypes', affects: subject, types: [subject.type], subtypes: [setType] },
      },
      failure: null,
    };

  // "~ can't be blocked except by creatures with flying."
  const exceptBy = s.attempt(() => {
    if (!s.eat("can't be blocked except by")) return null;
    const obj = parseObjectPhrase(s);
    if (!obj || !s.finish()) return null;
    const by: Filter = {};
    if (obj.filter.hasKeyword) by.lacksKeyword = obj.filter.hasKeyword;
    else return null;
    return by;
  });
  if (exceptBy)
    return {
      value: {
        kind: 'static',
        effect: { type: 'cantBeBlockedBy', affects: subject, by: exceptBy },
      },
      failure: null,
    };

  return fail(`static: ${s.remainder() || sentence}`);
}

/** Spell text: one or more effect clauses, with the bindings shared across the spell's sentences. */
export function parseSpellSentence(sentence: string, b: Bindings): ParseResult<Effect[]> {
  const s = Scanner.of(sentence);
  const effects = parseEffects(s, b);
  if (!effects || !s.finish()) return fail(`effect: ${s.remainder() || sentence}`);
  return { value: effects, failure: null };
}

export type { Condition };
