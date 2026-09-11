import type {
  DurationDef,
  Effect,
  Filter,
  PlayerRef,
  Quantity,
  Ref,
  TargetSpec,
  TokenDef,
} from '@mtg/engine';
import type { CardType, Color } from '@mtg/shared';
import {
  eatKeyword,
  parseCount,
  parseDuration,
  parseObjectPhrase,
  parsePlayerPhrase,
} from './phrases.js';
import type { Scanner } from './scan.js';

export interface BindingsMark {
  targets: number;
  lastObject: Ref | null;
  lastPlayer: PlayerRef | null;
  subject: PlayerRef | null;
}

/**
 * Bindings shared by every clause of one ability: the target specs collected so far and the most recent
 * object/player, which is what "it", "that creature" and "that player" refer to (docs/03 §Auto-scripter,
 * anaphora resolution).
 */
export class Bindings {
  readonly targets: TargetSpec[] = [];
  lastObject: Ref | null = null;
  lastPlayer: PlayerRef | null = null;
  /** Set by "They can't be regenerated", which qualifies a destroy in an earlier clause. */
  noRegenerate = false;
  /**
   * The player subject of the sentence being read. "Target player draws two cards and loses 2 life"
   * omits the subject of the second clause; it carries over inside one sentence only.
   */
  subject: PlayerRef | null = null;

  /** Snapshot for backtracking: a clause that fails must not leave the targets it speculatively added. */
  mark(): BindingsMark {
    return {
      targets: this.targets.length,
      lastObject: this.lastObject,
      lastPlayer: this.lastPlayer,
      subject: this.subject,
    };
  }

  reset(m: BindingsMark): void {
    this.targets.length = m.targets;
    this.lastObject = m.lastObject;
    this.lastPlayer = m.lastPlayer;
    this.subject = m.subject;
  }

  /** The player a clause acts on when its subject is elided. */
  subjectOr(explicit: PlayerRef | null): PlayerRef {
    if (explicit !== null) this.subject = explicit;
    return explicit ?? this.subject ?? 'controller';
  }

  /** Whether target ids are `a`/`b` (fight) or `t`/`t2`/… (everything else). */
  private nextId(prefix: string): string {
    let n = 0;
    let id = prefix;
    while (this.targets.some((t) => t.id === id)) id = `${prefix}${++n + 1}`;
    return id;
  }

  addTarget(filter: Filter, count?: TargetSpec['count'], prefix = 't'): Ref {
    const id = this.nextId(prefix);
    const spec: TargetSpec = { id, filter };
    if (count !== undefined) spec.count = count;
    this.targets.push(spec);
    this.lastObject = `$${id}`;
    return `$${id}`;
  }

  addPlayerTarget(filter: Filter): PlayerRef {
    const id = this.nextId('p');
    this.targets.push({ id, filter });
    this.lastPlayer = `$${id}`;
    return `$${id}`;
  }
}

/** An object-valued phrase: a target, `~`, or an anaphor resolved against the bindings. */
export function parseObjectRef(s: Scanner, b: Bindings): Ref | null {
  return s.attempt<Ref>(() => {
    if (s.eat('~') || s.eat('this creature') || s.eat('this permanent') || s.eat('this spell')) {
      b.lastObject = '~';
      return '~';
    }
    if (s.eat('it') || s.eat('them')) return b.lastObject;
    if (
      s.eat('that creature') ||
      s.eat('that permanent') ||
      s.eat('that spell') ||
      s.eat('that card')
    )
      return b.lastObject;
    const obj = parseObjectPhrase(s);
    if (!obj) return null;
    if (obj.anaphor === 'self') {
      b.lastObject = '~';
      return '~';
    }
    if (!obj.targeted) return null;
    return b.addTarget(obj.filter, obj.count);
  });
}

/** A player-valued phrase. "its controller"/"its owner" resolve through the last object, as the engine does. */
export function parsePlayerRef(s: Scanner, b: Bindings): PlayerRef | null {
  return s.attempt<PlayerRef>(() => {
    const p = parsePlayerPhrase(s);
    if (!p) return null;
    switch (p.kind) {
      case 'you':
        b.lastPlayer = 'controller';
        return 'controller';
      case 'each':
        return 'each';
      case 'eachOpponent':
        b.lastPlayer = 'opponent';
        return 'opponent';
      case 'target':
        return b.addPlayerTarget(p.filter);
      case 'anaphor':
        if (p.word === 'that player') return b.lastPlayer;
        return b.lastObject;
    }
  });
}

/** "equal to the number of creatures you control" — the only comparative quantity the v1 grammar reads. */
export function parseEqualTo(s: Scanner): Quantity | null {
  return s.attempt<Quantity>(() => {
    if (!s.eat('equal to the number of')) return null;
    const obj = parseObjectPhrase(s);
    if (!obj) return null;
    return { count: obj.filter };
  });
}

/** "a +1/+1 counter", "two -1/-1 counters", "three charge counters". */
function parseCounterPhrase(s: Scanner): { counter: string; count: Quantity } | null {
  return s.attempt(() => {
    const count = parseCount(s) ?? 1;
    const pt = s.kind('pt');
    let counter: string;
    if (pt) counter = pt.text;
    else {
      const w = s.kind('word');
      if (!w) return null;
      counter = w.lower;
    }
    if (!s.eat('counter') && !s.eat('counters')) return null;
    return { counter, count };
  });
}

/** "two 1/1 white Soldier creature tokens", "a 4/4 green Beast creature token with trample". */
function parseTokenPhrase(s: Scanner): { token: TokenDef; count: Quantity } | null {
  return s.attempt(() => {
    const count = parseCount(s) ?? 1;
    const pt = s.kind('pt');
    const colors: Color[] = [];
    const subtypes: string[] = [];
    const types: CardType[] = [];
    for (;;) {
      const t = s.peek();
      if (!t) break;
      const c = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' }[t.lower] as
        | Color
        | undefined;
      if (c) {
        s.next();
        colors.push(c);
        continue;
      }
      if (t.lower === 'colorless') {
        s.next();
        continue;
      }
      if (t.lower === 'and') {
        s.next();
        continue;
      }
      const ty = {
        creature: 'creature',
        artifact: 'artifact',
        enchantment: 'enchantment',
        land: 'land',
      }[t.lower] as CardType | undefined;
      if (ty) {
        s.next();
        types.push(ty);
        continue;
      }
      if (t.kind === 'word' && /^[A-Z]/.test(t.text)) {
        s.next();
        subtypes.push(t.text);
        continue;
      }
      break;
    }
    if (!s.eat('token') && !s.eat('tokens')) return null;
    if (types.length === 0) return null;
    const token: TokenDef = { name: subtypes[0] ?? types[0]!, types };
    if (subtypes.length > 0) token.subtypes = subtypes;
    if (colors.length > 0) token.colors = colors;
    if (pt) {
      const [p, t] = pt.text.split('/');
      const pn = Number(p);
      const tn = Number(t);
      if (!Number.isFinite(pn) || !Number.isFinite(tn)) return null;
      token.power = pn;
      token.toughness = tn;
    } else if (types.includes('creature')) return null;
    if (s.eat('with')) {
      const kw = eatKeyword(s);
      if (!kw) return null;
      token.abilities = [{ kind: 'keyword', keyword: kw }];
    }
    return { token, count };
  });
}

/** `+3/+3` → [3, 3]; `-1/-1` → [-1, -1]. Returns null for `*` or `X`. */
function splitPT(text: string): [number, number] | null {
  const [p, t] = text.split('/');
  const pn = Number(p);
  const tn = Number(t);
  if (!Number.isFinite(pn) || !Number.isFinite(tn)) return null;
  return [pn, tn];
}

type Clause = (s: Scanner, b: Bindings) => Effect[] | null;

/** "~ deals 3 damage to any target", "~ deals 2 damage to each creature", "it deals 1 damage to you". */
const damageClause: Clause = (s, b) => {
  const src = s.attempt(() => {
    if (s.eat('~') || s.eat('it')) return '~';
    return null;
  });
  if (src === null) return null;
  if (!s.eat('deals')) return null;
  const amount = parseCount(s);
  if (amount === null) return null;
  if (!s.eat('damage to')) return null;
  // "each creature" / "each opponent" / "each player" are simultaneous, not a target.
  const each = s.attempt(() => {
    if (s.eat('each player'))
      return { op: 'damageEach', filter: { self: false }, amount, players: 'any' } as const;
    if (s.eat('each opponent'))
      return { op: 'damageEach', filter: { self: false }, amount, players: 'opponent' } as const;
    const obj = parseObjectPhrase(s);
    if (!obj?.mass) return null;
    return { op: 'damageEach', filter: obj.filter, amount } as const;
  });
  if (each) {
    const eff: Effect =
      'players' in each && each.players !== undefined
        ? { op: 'damageEach', filter: {}, amount, players: each.players }
        : { op: 'damageEach', filter: each.filter, amount };
    return [eff];
  }
  const player = s.attempt(() => parsePlayerRef(s, b));
  if (player !== null) return [{ op: 'damage', amount, to: player }];
  const to = parseObjectRef(s, b);
  if (to === null) return null;
  return [{ op: 'damage', amount, to }];
};

const destroyClause: Clause = (s, b) => {
  if (!s.eat('destroy')) return null;
  const mass = s.attempt(() => {
    const obj = parseObjectPhrase(s);
    return obj?.mass ? obj : null;
  });
  if (mass) return [{ op: 'destroyAll', filter: mass.filter }];
  const t = parseObjectRef(s, b);
  if (t === null) return null;
  return [{ op: 'destroy', target: t }];
};

const exileClause: Clause = (s, b) => {
  if (!s.eat('exile')) return null;
  const mass = s.attempt(() => {
    const obj = parseObjectPhrase(s);
    return obj?.mass ? obj : null;
  });
  if (mass) return [{ op: 'exileAll', filter: mass.filter }];
  const t = parseObjectRef(s, b);
  if (t === null) return null;
  return [{ op: 'exile', target: t }];
};

const counterClause: Clause = (s, b) => {
  if (!s.eat('counter')) return null;
  const t = parseObjectRef(s, b);
  if (t === null) return null;
  const unless = s.attempt(() => {
    if (!s.eat('unless its controller pays')) return null;
    const m = s.kind('mana');
    return m ? m.text : null;
  });
  return unless
    ? [{ op: 'counter', target: t, unlessPay: unless }]
    : [{ op: 'counter', target: t }];
};

/** "<player> draws two cards" and the controller-implied "Draw a card." */
const drawClause: Clause = (s, b) => {
  const explicit = s.attempt(() => parsePlayerRef(s, b));
  if (!s.eat('draw') && !s.eat('draws')) return null;
  const player = b.subjectOr(explicit);
  const literal = parseCount(s);
  if (!s.eat('card') && !s.eat('cards')) return null;
  const count = literal ?? parseEqualTo(s);
  if (count === null) return null;
  return player === 'controller' ? [{ op: 'draw', count }] : [{ op: 'draw', count, player }];
};

const lifeClause: Clause = (s, b) => {
  const explicit = s.attempt(() => parsePlayerRef(s, b));
  const verb = s.eatAny('gains', 'gain', 'loses', 'lose');
  if (!verb) return null;
  const player = b.subjectOr(explicit);
  // "gains 3 life" and "gains life equal to the number of …" put the amount on either side of the noun.
  const amount = parseCount(s);
  if (amount !== null) {
    if (!s.eat('life')) return null;
  } else if (!s.eat('life')) return null;
  const value = amount ?? parseEqualTo(s);
  if (value === null) return null;
  const op = verb.startsWith('gain') ? 'gainLife' : 'loseLife';
  return player === 'controller' ? [{ op, amount: value }] : [{ op, amount: value, player }];
};

/** "Prevent the next 3 damage that would be dealt to any target this turn." */
const preventClause: Clause = (s, b) => {
  if (!s.eat('prevent the next')) return null;
  const amount = parseCount(s);
  if (amount === null) return null;
  if (!s.eat('damage that would be dealt to')) return null;
  const target = parseObjectRef(s, b);
  if (target === null) return null;
  s.eat('this turn');
  return [{ op: 'preventDamage', target, amount }];
};

const discardClause: Clause = (s, b) => {
  const explicit = s.attempt(() => parsePlayerRef(s, b));
  if (!s.eat('discards') && !s.eat('discard')) return null;
  const player = b.subjectOr(explicit);
  const count = parseCount(s);
  if (count === null) return null;
  if (!s.eat('card') && !s.eat('cards')) return null;
  const random = s.eat('at random');
  const eff: Effect = { op: 'discard', count, ...(player === 'controller' ? {} : { player }) };
  return random ? [{ ...eff, random: true } as Effect] : [eff];
};

const millClause: Clause = (s, b) => {
  const explicit = s.attempt(() => parsePlayerRef(s, b));
  if (!s.eat('mills') && !s.eat('mill')) return null;
  const player = b.subjectOr(explicit);
  const count = parseCount(s);
  if (count === null) return null;
  if (!s.eat('card') && !s.eat('cards')) return null;
  return player === 'controller' ? [{ op: 'mill', count }] : [{ op: 'mill', count, player }];
};

/** "target creature gets +3/+3 until end of turn" (and "and gains trample until end of turn"). */
const pumpClause: Clause = (s, b) => {
  const t = parseObjectRef(s, b);
  if (t === null) return null;
  if (!s.eat('gets')) return null;
  const pt = s.kind('pt');
  if (!pt) return null;
  const split = splitPT(pt.text);
  if (!split) return null;
  const duration = parseDuration(s) ?? 'untilEndOfTurn';
  return [{ op: 'pump', target: t, power: split[0], toughness: split[1], duration }];
};

/** "target creature gains flying until end of turn". */
const grantClause: Clause = (s, b) => {
  const t = parseObjectRef(s, b);
  if (t === null) return null;
  if (!s.eat('gains') && !s.eat('gain') && !s.eat('has') && !s.eat('have')) return null;
  const kw = eatKeyword(s);
  if (!kw) return null;
  const duration = parseDuration(s);
  const eff: Effect = { op: 'grantAbility', target: t, ability: { kind: 'keyword', keyword: kw } };
  return duration ? [{ ...eff, duration } as Effect] : [eff];
};

/** "put a +1/+1 counter on ~", "put two +1/+1 counters on each creature you control". */
const counterPlacementClause: Clause = (s, b) => {
  if (!s.eat('put')) return null;
  const c = parseCounterPhrase(s);
  if (!c) return null;
  if (!s.eat('on')) return null;
  const mass = s.attempt(() => {
    const obj = parseObjectPhrase(s);
    return obj?.mass ? obj : null;
  });
  if (mass)
    return [
      {
        op: 'forEach',
        filter: mass.filter,
        as: 'c',
        effects: [{ op: 'addCounters', target: 'c', counter: c.counter, count: c.count }],
      },
    ];
  const t = parseObjectRef(s, b);
  if (t === null) return null;
  return [{ op: 'addCounters', target: t, counter: c.counter, count: c.count }];
};

const tokenClause: Clause = (s) => {
  if (!s.eat('create')) return null;
  const t = parseTokenPhrase(s);
  if (!t) return null;
  return t.count === 1
    ? [{ op: 'createToken', token: t.token }]
    : [{ op: 'createToken', token: t.token, count: t.count }];
};

const bounceClause: Clause = (s, b) => {
  if (!s.eat('return')) return null;
  const t = parseObjectRef(s, b);
  if (t === null) return null;
  if (s.eat("to its owner's hand") || s.eat("to their owners' hands"))
    return [{ op: 'bounce', target: t }];
  // "Return target creature card from your graveyard to your hand" is a zone change, not a bounce.
  if (s.eat('to your hand')) return [{ op: 'moveZone', target: t, to: 'hand' }];
  return null;
};

const tapClause: Clause = (s, b) => {
  const verb = s.eatAny('tap', 'untap');
  if (!verb) return null;
  const t = parseObjectRef(s, b);
  if (t === null) return null;
  return [{ op: verb === 'tap' ? 'tap' : 'untap', target: t }];
};

const scryClause: Clause = (s) => {
  const verb = s.eatAny('scry', 'surveil');
  if (!verb) return null;
  const count = parseCount(s);
  if (count === null) return null;
  return [{ op: verb === 'scry' ? 'scry' : 'surveil', count }];
};

const sacrificeClause: Clause = (s, b) => {
  const player = s.attempt(() => parsePlayerRef(s, b));
  if (!s.eat('sacrifices') && !s.eat('sacrifice')) return null;
  const t = parseObjectRef(s, b);
  if (t !== null) return [{ op: 'sacrifice', target: t }];
  const obj = parseObjectPhrase(s);
  if (!obj) return null;
  const eff: Effect = { op: 'sacrifice', filter: obj.filter, count: 1 };
  return player && player !== 'controller' ? [{ ...eff, player } as Effect] : [eff];
};

const fightClause: Clause = (s, b) => {
  const a = parseObjectRef(s, b);
  if (a === null) return null;
  if (!s.eat('fights')) return null;
  const other = parseObjectRef(s, b);
  if (other === null) return null;
  return [{ op: 'fight', a, b: other }];
};

const gainControlClause: Clause = (s, b) => {
  if (!s.eat('gain control of')) return null;
  const t = parseObjectRef(s, b);
  if (t === null) return null;
  const duration = parseDuration(s);
  return duration
    ? [{ op: 'gainControl', target: t, duration }]
    : [{ op: 'gainControl', target: t }];
};

const regenerateClause: Clause = (s, b) => {
  if (!s.eat('regenerate')) return null;
  const t = parseObjectRef(s, b);
  if (t === null) return null;
  return [{ op: 'regenerate', target: t }];
};

const extraTurnClause: Clause = (s) => {
  if (!s.eat('take an extra turn after this one')) return null;
  return [{ op: 'extraTurn' }];
};

const shuffleClause: Clause = (s) => {
  if (!s.eat('shuffle')) return null;
  return [{ op: 'shuffle' }];
};

/** "look at target opponent's hand" / "target opponent reveals their hand". */
const revealHandClause: Clause = (s, b) => {
  // The tokeniser keeps possessives together, so the phrases are matched with the apostrophe in place.
  const lookAt = s.attempt(() => {
    if (!s.eat('look at')) return null;
    if (s.eat("target opponent's hand")) return { player: 'opponent' } as const;
    if (s.eat("target player's hand")) return { player: 'any' } as const;
    return null;
  });
  if (lookAt) {
    const p = b.addPlayerTarget({ player: lookAt.player });
    return [{ op: 'reveal', hand: p }];
  }
  const player = s.attempt(() => parsePlayerRef(s, b));
  if (player === null) return null;
  if (!s.eat('reveals their hand') && !s.eat('reveal their hand')) return null;
  return [{ op: 'reveal', hand: player }];
};

/**
 * "search your library for a basic land card, put that card onto the battlefield tapped, then shuffle"
 * is one templated effect in the engine, so the whole sentence is consumed here.
 */
const searchClause: Clause = (s) => {
  if (!s.eat('search your library for')) return null;
  const obj = parseObjectPhrase(s);
  if (!obj) return null;
  s.eat(',');
  let to: 'hand' | 'battlefield' | 'libraryTop' | 'graveyard' = 'hand';
  let tapped = false;
  if (s.eat('put that card onto the battlefield') || s.eat('put it onto the battlefield')) {
    to = 'battlefield';
    tapped = s.eat('tapped');
  } else if (s.eat('put that card into your hand') || s.eat('reveal it, put it into your hand')) {
    to = 'hand';
  }
  s.eat(',');
  const shuffles = s.eat('then shuffle') || s.eat('then shuffle your library');
  const search: Effect = {
    op: 'search',
    filter: obj.filter,
    count: 1,
    to,
    ...(tapped ? { tapped } : {}),
  };
  return shuffles ? [search, { op: 'shuffle' }] : [search];
};

/** "add {B}{B}{B}" as a spell effect (mana abilities are handled by the ability-level grammar). */
const addManaClause: Clause = (s) => {
  if (!s.eat('add')) return null;
  const m = s.kind('mana');
  if (!m) return null;
  return [{ op: 'addMana', mana: m.text }];
};

/** "prevent all combat damage that would be dealt this turn" (Fog). */
const fogClause: Clause = (s) => {
  if (!s.eat('prevent all combat damage that would be dealt this turn')) return null;
  return [
    {
      op: 'createEffect',
      effect: {
        type: 'preventDamage',
        affects: { anyPermanent: true },
        amount: 'all',
        combat: true,
      },
      duration: 'untilEndOfTurn',
    },
    {
      op: 'forEachPlayer',
      as: 'p',
      effects: [
        {
          op: 'createEffect',
          effect: { type: 'preventDamage', affects: 'you', amount: 'all', combat: true },
          duration: 'untilEndOfTurn',
        },
      ],
    },
  ];
};

const cantRegenerateClause: Clause = (s, b) => {
  if (!s.eat("they can't be regenerated") && !s.eat("it can't be regenerated")) return null;
  b.noRegenerate = true;
  return [];
};

/** "Target player puts N cards from their hand on top of their library" and friends are out of scope;
 * this covers the common "put ~ on top of its owner's library" bounce-to-library. */
const toLibraryClause: Clause = (s, b) => {
  if (!s.eat('put')) return null;
  const t = parseObjectRef(s, b);
  if (t === null) return null;
  if (s.eat("on top of its owner's library"))
    return [{ op: 'moveZone', target: t, to: 'libraryTop' }];
  if (s.eat("on the bottom of its owner's library"))
    return [{ op: 'moveZone', target: t, to: 'libraryBottom' }];
  return null;
};

/**
 * Order matters: clauses whose first token is a noun phrase (pump, grant, fight) run after the ones that
 * start with a verb, so "Destroy target creature" is never read as an object phrase.
 */
const CLAUSES: Clause[] = [
  cantRegenerateClause,
  fogClause,
  searchClause,
  damageClause,
  destroyClause,
  exileClause,
  counterClause,
  counterPlacementClause,
  toLibraryClause,
  tokenClause,
  bounceClause,
  scryClause,
  preventClause,
  addManaClause,
  extraTurnClause,
  shuffleClause,
  gainControlClause,
  regenerateClause,
  revealHandClause,
  tapClause,
  drawClause,
  lifeClause,
  discardClause,
  millClause,
  sacrificeClause,
  pumpClause,
  grantClause,
  fightClause,
];

/** One effect clause, without the conjunctions that join them. */
export function parseClause(s: Scanner, b: Bindings): Effect[] | null {
  const may = s.attempt(() => (s.eat('you may') ? true : null));
  for (const c of CLAUSES) {
    const mark = b.mark();
    const r = s.attempt(() => c(s, b));
    if (r) return may ? [{ op: 'may', effects: r }] : r;
    b.reset(mark);
  }
  return null;
}

/** Ops that take a duration; a leading "Until end of turn," supplies it when the clause did not. */
function withDuration(effect: Effect, duration: DurationDef): Effect {
  switch (effect.op) {
    case 'pump':
    case 'grantAbility':
    case 'setPT':
    case 'gainControl':
    case 'loseAbilities':
      return effect.duration === undefined ? ({ ...effect, duration } as Effect) : effect;
    default:
      return effect;
  }
}

/** "They can't be regenerated" qualifies the destroy in an earlier clause (CR 701.15). */
export function applyNoRegenerate(effects: Effect[], b: Bindings): Effect[] {
  if (!b.noRegenerate) return effects;
  return effects.map((e) =>
    e.op === 'destroy' || e.op === 'destroyAll' ? ({ ...e, noRegenerate: true } as Effect) : e,
  );
}

/** Clauses joined by "and", ", then", "," or a sentence break. */
export function parseEffects(s: Scanner, b: Bindings): Effect[] | null {
  // An elided subject only carries within one sentence.
  b.subject = null;
  // "Until end of turn, target creature gains flying." states the duration before the effect.
  const lead = s.attempt(() => {
    const d = parseDuration(s);
    return d !== null && s.eat(',') ? d : null;
  });
  const out: Effect[] = [];
  for (;;) {
    const c = parseClause(s, b);
    if (!c) return null;
    out.push(...c);
    if (s.atEnd()) return lead ? out.map((e) => withDuration(e, lead)) : out;
    if (s.eat(', then') || s.eat('and then') || s.eat('then') || s.eat('and') || s.eat(','))
      continue;
    return null;
  }
}
