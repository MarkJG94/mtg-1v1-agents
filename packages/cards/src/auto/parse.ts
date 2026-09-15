import { Bindings, duration, filter, player, quantity } from './phrases.js';
import { type ParseFailure, Reader } from './reader.js';
import { type ScriptEffect, verbs } from './verbs.js';

/**
 * Parsing a classified line into the pieces a script is made of (docs/03, step 3).
 *
 * The unit is the sentence, because the unit `covers:` counts in is the sentence. Each is
 * read in turn against every verb — ordered choice, the way a PEG would — and the targets
 * an early sentence declares are remembered for the later ones. That is what lets "Gain
 * control of target creature until end of turn. Untap that creature. It gains haste until
 * end of turn." be three sentences about one target.
 *
 * **A parse can stop part-way and still be worth having**, as long as it stops at a
 * sentence boundary. "Destroy all creatures. They can't be regenerated." reads the first
 * sentence and not the second, which is exactly the shape of a *partial* script: the
 * emitter claims the sentences that were read, the validator sees one unclaimed, and the
 * card is listed for somebody to finish rather than played as a card that does less than
 * it says. Stopping mid-sentence is never allowed, because half a sentence is a different
 * card.
 *
 * Failure names the token it stopped at. The coverage report in 3.5 is a list of those,
 * and "no effect this can read, at «regenerated»" is what turns that report into a list of
 * templates to teach.
 */

export interface ParsedAbility {
  /** Targets the ability declares, in script form, in the order they were declared. */
  readonly targets: readonly { readonly id: string; readonly filter: unknown }[];
  readonly effects: readonly ScriptEffect[];
  /** How many of the sentences offered were read. */
  readonly sentencesRead: number;
  /** Why it stopped, when it did not read them all. */
  readonly unread?: ParseFailure;
}

export type ParseResult =
  | { readonly ok: true; readonly ability: ParsedAbility }
  | { readonly ok: false; readonly failure: ParseFailure };

/** An activation cost, in the script's `cost:` shape. */
export interface ParsedCost {
  readonly mana?: string;
  readonly tap?: boolean;
  readonly sacrificeSelf?: boolean;
}

export const parseEffects = (sentences: readonly string[]): ParseResult => {
  const bindings = new Bindings();
  const effects: ScriptEffect[] = [];
  let read = 0;
  let failure: ParseFailure | null = null;

  for (const sentence of sentences) {
    // The subject carries between the clauses of one sentence and no further. "Target
    // player discards a card. Draw a card." is two sentences, and the second one is about
    // you however the first one began.
    bindings.subject = null;
    const parsed = readSentence(sentence, bindings);
    if (parsed === null) {
      failure = lastFailure;
      break;
    }
    effects.push(...parsed);
    bindings.started = effects.length > 0;
    read += 1;
  }

  if (read === 0) {
    return { ok: false, failure: failure ?? { reason: 'nothing to read', token: null } };
  }

  return {
    ok: true,
    ability: {
      // The filter a target may be aimed at is recorded by the phrase that declared it:
      // that phrase is the only thing that knows, and reading it back off the effects
      // would be a guess that made every target `any`.
      targets: bindings.targets.map(({ id, filter: what }) => ({ id, filter: what })),
      effects,
      sentencesRead: read,
      ...(failure === null ? {} : { unread: failure }),
    },
  };
};

/** Where the most recent sentence gave up, kept for the result above. */
let lastFailure: ParseFailure = { reason: 'nothing to read', token: null };

/** One sentence, read clause by clause, or nothing at all. */
const readSentence = (sentence: string, bindings: Bindings): readonly ScriptEffect[] | null => {
  const reader = Reader.of(sentence);
  const mark = bindings.mark();
  const effects: ScriptEffect[] = [];

  while (!reader.done) {
    if (reader.punctuation()) continue;
    // "Then draw a card" and "and draw a card" join clauses without changing them.
    if (reader.word('then') || reader.word('and')) continue;

    const clause = reader.first(
      ...verbs.map((verb) => () => {
        const before = bindings.mark();
        const built = verb(reader, bindings);
        if (built === null) bindings.reset(before);
        return built;
      }),
    );
    if (clause === null) {
      reader.stopped('no effect this can read');
      lastFailure = reader.failure();
      bindings.reset(mark);
      return null;
    }
    effects.push(...clause);
  }

  if (effects.length === 0) {
    lastFailure = reader.failure();
    bindings.reset(mark);
    return null;
  }
  return effects;
};

// --- Triggers ---

export interface ParsedTrigger {
  readonly when: Readonly<Record<string, unknown>>;
  readonly ability: ParsedAbility;
}

/**
 * "When ~ enters, draw a card." — the condition, and then the effects it causes.
 *
 * The comma is the join: everything before it says when the ability triggers (CR 603.1),
 * everything after it is what it does, and that second half is an ordinary sentence.
 */
export const parseTrigger = (
  sentence: string,
): ParsedTrigger | { readonly failure: ParseFailure } => {
  const comma = sentence.indexOf(',');
  if (comma < 0) {
    return { failure: { reason: 'a trigger with no comma between when and what', token: null } };
  }

  const reader = Reader.of(sentence.slice(0, comma));
  const when = triggerCondition(reader);
  if (when === null || !reader.done) {
    reader.stopped('a trigger condition this cannot read');
    return { failure: reader.failure() };
  }

  const rest = parseEffects([sentence.slice(comma + 1).trim()]);
  return rest.ok ? { when, ability: rest.ability } : { failure: rest.failure };
};

const triggerCondition = (reader: Reader): Readonly<Record<string, unknown>> | null =>
  reader.first<Readonly<Record<string, unknown>>>(
    () =>
      reader.words('when', '~', 'enters') || reader.words('whenever', '~', 'enters')
        ? { kind: 'selfEntersBattlefield' }
        : null,
    () =>
      reader.words('when', '~', 'dies') || reader.words('whenever', '~', 'dies')
        ? { kind: 'selfDies' }
        : null,
    () => (reader.words('whenever', '~', 'attacks') ? { kind: 'selfAttacks' } : null),
    () => (reader.words('whenever', '~', 'blocks') ? { kind: 'selfBlocks' } : null),
    () => {
      if (!reader.words('whenever', 'another')) return null;
      const what = filter(reader);
      if (what === null) return null;
      const word = reader.anyWord('dies', 'enters');
      if (word === null) return null;
      const controlledBy = controllerOf(what);
      return {
        kind: word === 'dies' ? 'anotherDies' : 'anotherEntersBattlefield',
        ...(controlledBy === null ? {} : { controlledBy }),
      };
    },
    () =>
      reader.words('at', 'the', 'beginning', 'of', 'your', 'upkeep')
        ? { kind: 'beginningOfUpkeep' }
        : null,
    () =>
      reader.words('at', 'the', 'beginning', 'of', 'your', 'end', 'step')
        ? { kind: 'beginningOfEndStep' }
        : null,
  );

/** "another creature you control" carries a controller the trigger has to repeat. */
const controllerOf = (what: unknown): string | null => {
  if (typeof what !== 'object' || what === null) return null;
  const who = (what as Record<string, unknown>)['controller'];
  return typeof who === 'string' ? who : null;
};

// --- Mana abilities ---

/**
 * "Add {U} or {B}" — a mana ability's modes, which are not effects at all.
 *
 * A mana ability in a script is `modes:` rather than `effects:`, because choosing between
 * {U} and {B} is a choice made as the ability resolves and the engine has a place for it
 * (CR 605.1a). So it is read here and not by the `addMana` verb, which is for the rituals:
 * "Add {B}{B}{B}" on an instant is a spell, and it has no modes.
 */
export interface ManaMode {
  readonly type: string;
  readonly amount: number;
}

export const parseManaModes = (sentence: string): readonly (readonly ManaMode[])[] | null => {
  const reader = Reader.of(sentence);
  if (!reader.word('add')) return null;

  const modes: { type: string; amount: number }[][] = [];
  for (;;) {
    const symbols = reader.match(/(?:\{[^}]*\})+/);
    if (symbols === null) return null;

    const produced = [...symbols[0].matchAll(/\{([^}]*)\}/g)].map((match) => match[1] ?? '');
    if (!produced.every((type) => /^[WUBRGC]$/.test(type))) return null;

    const counted = new Map<string, number>();
    for (const type of produced) counted.set(type, (counted.get(type) ?? 0) + 1);
    modes.push([...counted].map(([type, amount]) => ({ type, amount })));

    if (!reader.try(() => reader.word('or') || reader.word(','))) break;
  }

  reader.punctuation();
  return reader.done && modes.length > 0 ? modes : null;
};

// --- Static abilities ---

export interface ParsedStatic {
  readonly affects: Readonly<Record<string, unknown>>;
  readonly change: Readonly<Record<string, unknown>>;
}

/**
 * "Creatures you control get +1/+1" — an anthem, which is a continuous effect rather than
 * anything that happens (CR 604.1).
 *
 * A static ability is `affects` and `change` rather than effects, so it has its own rule.
 * Only the anthem shape is here: it is the one docs/03 names as an early target, and the
 * rest of the static templates ("as long as", "can't", "costs {1} less") each want a
 * different part of the layer system.
 */
export const parseStatic = (sentence: string): ParsedStatic | null => {
  const reader = Reader.of(sentence);

  // "Creatures you control" with no determiner in front of it: a bare plural means all of
  // them, which is how every anthem is written.
  const what = filter(reader);
  if (what === null) return null;
  if (reader.anyWord('get', 'gets') === null) return null;

  const change = reader.match(/([+-]\d+)\/([+-]\d+)/);
  if (change === null) return null;
  reader.punctuation();
  if (!reader.done) return null;

  const who = controllerOf(what);
  if (who !== 'you') return null;

  return {
    affects: { kind: 'creaturesControlledBy', player: 'sourceController' },
    change: {
      kind: 'modifyPowerToughness',
      power: Number(change[1]) || 0,
      toughness: Number(change[2]) || 0,
    },
  };
};

// --- Replacements ---

export interface ParsedReplacement {
  readonly applies: Readonly<Record<string, unknown>>;
  readonly change: Readonly<Record<string, unknown>>;
  readonly selfReplacement: boolean;
}

/**
 * "~ enters tapped." — how a permanent changes its own arrival (CR 614.1c).
 *
 * The one shape here is the one the bootstrap set needs and the one every gate, shockland
 * and checkland shares. It is a self-replacement (CR 616.1a), which is what lets it apply
 * before anything else that would modify the same event.
 */
export const parseReplacement = (sentence: string): ParsedReplacement | null => {
  const reader = Reader.of(sentence);
  if (!reader.word('~')) return null;
  if (!reader.word('enters')) return null;
  reader.try(() => reader.words('the', 'battlefield'));
  if (!reader.word('tapped')) return null;
  reader.punctuation();
  if (!reader.done) return null;

  return {
    applies: { kind: 'entersBattlefield', object: 'source' },
    change: { kind: 'entersTapped' },
    selfReplacement: true,
  };
};

// --- Costs ---

/**
 * An activated ability's cost: `{1}, {T}` or `Sacrifice ~`.
 *
 * The script's `cost:` can say three things — mana, tapping, and sacrificing the source —
 * so those are the three read here. Anything else makes the cost unreadable rather than
 * partly read, because a cost read wrongly is a card cheaper than the one printed.
 */
export const parseCost = (text: string): ParsedCost | null => {
  const reader = Reader.of(text);
  const cost: { mana?: string; tap?: boolean; sacrificeSelf?: boolean } = {};

  while (!reader.done) {
    if (reader.punctuation()) continue;

    const symbols = reader.match(/(?:\{[^}]*\})+/);
    if (symbols !== null) {
      const parts = [...symbols[0].matchAll(/\{([^}]*)\}/g)].map((match) => match[1] ?? '');
      const taps = parts.filter((part) => part.toUpperCase() === 'T');
      const rest = parts.filter((part) => part.toUpperCase() !== 'T');
      if (taps.length > 0) cost.tap = true;
      if (rest.length > 0) {
        cost.mana = `${cost.mana ?? ''}${rest.map((part) => `{${part}}`).join('')}`;
      }
      continue;
    }

    if (reader.words('sacrifice', '~')) {
      cost.sacrificeSelf = true;
      continue;
    }

    return null;
  }

  return Object.keys(cost).length === 0 ? null : cost;
};

export type { ParseFailure };
export { duration, player, quantity };
