import {
  type CardType,
  type Condition,
  cardTypes,
  type Filter,
  grantableKeywords,
  manaTypes,
  type ObjectSelector,
  opNames,
  type PlayerSelector,
  type Quantity,
  supertypes,
  type TargetSelector,
} from '@mtg/engine';
import { colours } from '@mtg/shared';
import { z } from 'zod';

/**
 * The card-script schema (docs/03 "Script schema").
 *
 * A script is written by a person in YAML, or emitted by the auto-scripter, and has to be
 * pleasant in both. So the schema accepts the friendly shapes docs/03 shows — `filter:
 * any`, `to: $t`, `amount: 3` — and transforms them into the engine's tagged unions,
 * which are precise but no fun to type. What the engine sees is always the tagged form;
 * what a script author sees is always the short one.
 *
 * The vocabulary itself is not repeated here. Op names come from the engine's own
 * registry and keywords from its keyword list, so a script can never name an op or a
 * keyword the engine has not got — the failure docs/03 asks to be impossible, rather than
 * a second list to keep in step.
 */

const colourSchema = z.enum(colours);
const typeSchema = z.enum(cardTypes as readonly [CardType, ...CardType[]]);
const keywordSchema = z.enum(grantableKeywords);

/** `$t` names a target the ability declared; `~` is the source; `$each` the loop object. */
const reference = z.string().regex(/^(~|\$[a-zA-Z][\w-]*|you|opponent|each)$/);

// --- Filters ---

const filterShorthand = z.enum([
  'any',
  'player',
  'creature',
  'permanent',
  'planeswalker',
  'spell',
  'attacking',
  'blocking',
]);

/**
 * The object form is read as "all of these at once", which is how it reads in YAML:
 * `{ type: creature, controller: opponent }` is a creature an opponent controls.
 */
const filterObject = z.object({
  type: typeSchema.optional(),
  subtype: z.string().optional(),
  colour: colourSchema.optional(),
  controller: z.enum(['you', 'opponent', 'any']).optional(),
  zone: z.string().optional(),
  tapped: z.boolean().optional(),
  keyword: keywordSchema.optional(),
  powerAtLeast: z.number().int().optional(),
  powerAtMost: z.number().int().optional(),
  toughnessAtMost: z.number().int().optional(),
  manaValueAtMost: z.number().int().optional(),
  token: z.boolean().optional(),
  name: z.string().optional(),
  is: filterShorthand.optional(),
  not: z.lazy(() => filterSchema).optional(),
  and: z.lazy(() => z.array(filterSchema)).optional(),
  or: z.lazy(() => z.array(filterSchema)).optional(),
});

type FilterObject = z.infer<typeof filterObject>;

const filterFromObject = (value: FilterObject): Filter => {
  const parts: Filter[] = [];

  if (value.is !== undefined) parts.push({ kind: value.is });
  if (value.type !== undefined) parts.push({ kind: 'type', type: value.type });
  if (value.subtype !== undefined) parts.push({ kind: 'subtype', subtype: value.subtype });
  if (value.colour !== undefined) parts.push({ kind: 'colour', colour: value.colour });
  if (value.controller !== undefined) {
    parts.push({ kind: 'controlledBy', player: value.controller });
  }
  if (value.zone !== undefined) parts.push({ kind: 'inZone', zone: value.zone as never });
  if (value.tapped !== undefined) parts.push({ kind: 'tapped', tapped: value.tapped });
  if (value.keyword !== undefined) parts.push({ kind: 'hasKeyword', keyword: value.keyword });
  if (value.powerAtLeast !== undefined) {
    parts.push({ kind: 'powerAtLeast', amount: value.powerAtLeast });
  }
  if (value.powerAtMost !== undefined) {
    parts.push({ kind: 'powerAtMost', amount: value.powerAtMost });
  }
  if (value.toughnessAtMost !== undefined) {
    parts.push({ kind: 'toughnessAtMost', amount: value.toughnessAtMost });
  }
  if (value.manaValueAtMost !== undefined) {
    parts.push({ kind: 'manaValueAtMost', amount: value.manaValueAtMost });
  }
  if (value.token !== undefined) parts.push({ kind: 'token', token: value.token });
  if (value.name !== undefined) parts.push({ kind: 'named', name: value.name });
  if (value.not !== undefined) parts.push({ kind: 'not', filter: value.not as Filter });
  if (value.and !== undefined) parts.push({ kind: 'and', filters: value.and as Filter[] });
  if (value.or !== undefined) parts.push({ kind: 'or', filters: value.or as Filter[] });

  const first = parts[0];
  if (first === undefined) return { kind: 'permanent' };
  return parts.length === 1 ? first : { kind: 'and', filters: parts };
};

export const filterSchema: z.ZodType<Filter> = z.lazy(() =>
  z.union([
    filterShorthand.transform((kind): Filter => ({ kind })),
    filterObject.transform(filterFromObject),
  ]),
);

// --- Selectors ---

const objectSelector = (value: string): ObjectSelector => {
  if (value === '~') return { kind: 'source' };
  if (value === '$each') return { kind: 'each' };
  return { kind: 'target', id: value.slice(1) };
};

const playerSelector = (value: string): PlayerSelector => {
  if (value === 'you') return { kind: 'you' };
  if (value === 'opponent') return { kind: 'opponent' };
  if (value === 'each') return { kind: 'each' };
  if (value === '~') return { kind: 'controllerOf', object: { kind: 'source' } };
  return { kind: 'target', id: value.slice(1) };
};

/** "Any target" keeps whatever was chosen, which may be a player or a permanent. */
const targetSelector = (value: string): TargetSelector => {
  if (value === 'you' || value === 'opponent' || value === 'each') {
    return { kind: 'player', player: playerSelector(value) };
  }
  if (value === '~' || value === '$each') {
    return { kind: 'object', object: objectSelector(value) };
  }
  return { kind: 'chosen', id: value.slice(1) };
};

export const objectRef = reference.transform(objectSelector);
export const playerRef = reference.transform(playerSelector);
export const targetRef = reference.transform(targetSelector);

// --- Quantities and conditions ---

const quantityObject = z.object({
  x: z.literal(true).optional(),
  count: z.lazy(() => filterSchema).optional(),
  cardsInHand: reference.optional(),
  lifeTotal: reference.optional(),
  powerOf: reference.optional(),
  toughnessOf: reference.optional(),
  counters: z.object({ on: reference, kind: z.string() }).optional(),
  add: z.lazy(() => z.array(quantitySchema)).optional(),
  sub: z.lazy(() => z.array(quantitySchema)).optional(),
  mul: z.lazy(() => z.array(quantitySchema)).optional(),
});

const fold = (kind: 'add' | 'sub' | 'mul', parts: readonly Quantity[]): Quantity =>
  parts.length === 0 ? 0 : parts.reduce((left, right) => ({ kind, left, right }) as Quantity);

const quantityFromObject = (value: z.infer<typeof quantityObject>): Quantity => {
  if (value.x === true) return { kind: 'x' };
  if (value.count !== undefined) return { kind: 'count', of: value.count as Filter };
  if (value.cardsInHand !== undefined) {
    return { kind: 'cardsInHand', player: playerSelector(value.cardsInHand) };
  }
  if (value.lifeTotal !== undefined) {
    return { kind: 'lifeTotal', player: playerSelector(value.lifeTotal) };
  }
  if (value.powerOf !== undefined) {
    return { kind: 'powerOf', object: objectSelector(value.powerOf) };
  }
  if (value.toughnessOf !== undefined) {
    return { kind: 'toughnessOf', object: objectSelector(value.toughnessOf) };
  }
  if (value.counters !== undefined) {
    return {
      kind: 'countersOn',
      object: objectSelector(value.counters.on),
      counter: value.counters.kind,
    };
  }
  if (value.add !== undefined) return fold('add', value.add as Quantity[]);
  if (value.sub !== undefined) return fold('sub', value.sub as Quantity[]);
  if (value.mul !== undefined) return fold('mul', value.mul as Quantity[]);
  return 0;
};

export const quantitySchema: z.ZodType<Quantity> = z.lazy(() =>
  z.union([
    z.number().int(),
    z.literal('x').transform((): Quantity => ({ kind: 'x' })),
    quantityObject.transform(quantityFromObject),
  ]),
);

const conditionObject = z.object({
  atLeast: z.object({ amount: quantitySchema, than: quantitySchema }).optional(),
  equal: z.object({ amount: quantitySchema, than: quantitySchema }).optional(),
  exists: filterSchema.optional(),
  notExists: filterSchema.optional(),
  not: z.lazy(() => conditionSchema).optional(),
  and: z.lazy(() => z.array(conditionSchema)).optional(),
  or: z.lazy(() => z.array(conditionSchema)).optional(),
});

const conditionFromObject = (value: z.infer<typeof conditionObject>): Condition => {
  if (value.atLeast !== undefined) return { kind: 'atLeast', ...value.atLeast };
  if (value.equal !== undefined) return { kind: 'equal', ...value.equal };
  if (value.exists !== undefined) return { kind: 'exists', filter: value.exists as Filter };
  if (value.notExists !== undefined) {
    return { kind: 'notExists', filter: value.notExists as Filter };
  }
  if (value.not !== undefined) return { kind: 'not', condition: value.not as Condition };
  if (value.and !== undefined) return { kind: 'and', conditions: value.and as Condition[] };
  if (value.or !== undefined) return { kind: 'or', conditions: value.or as Condition[] };
  return { kind: 'exists', filter: { kind: 'permanent' } };
};

export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  conditionObject.transform(conditionFromObject),
);

// --- Effects ---

/**
 * Ops are checked against the engine's registry by name, and their arguments are left as
 * written: the loader turns them into the engine's op objects, and a name the engine does
 * not know never gets that far.
 */
export const effectSchema = z.looseObject({
  op: z.enum(opNames),
});

export type ScriptEffect = z.infer<typeof effectSchema>;

// --- Abilities ---

const targetSpecSchema = z.object({
  id: z.string().min(1),
  filter: filterSchema,
  count: z.number().int().positive().optional(),
  upTo: z.boolean().optional(),
});

const manaProductionSchema = z.object({
  type: z.enum(manaTypes),
  amount: z.number().int().positive().default(1),
  snow: z.boolean().optional(),
  restriction: z.string().optional(),
});

const costSchema = z.object({
  mana: z.string().optional(),
  tap: z.boolean().optional(),
  sacrificeSelf: z.boolean().optional(),
});

const effectsField = z.array(effectSchema).default([]);

/**
 * Which sentences of the oracle text this ability claims (docs/03 "Text coverage"). Per
 * ability rather than per card: the validator's rule is that every sentence is claimed by
 * exactly one of them, and a card-level list could not say which.
 */
const coverage = { covers: z.array(z.number().int().nonnegative()).optional() };

export const abilitySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('spell'),
    ...coverage,
    targets: z.array(targetSpecSchema).optional(),
    effects: effectsField,
  }),
  z.object({
    kind: z.literal('triggered'),
    ...coverage,
    id: z.string().min(1),
    when: z.looseObject({ kind: z.string() }),
    interveningIf: z.looseObject({ kind: z.string() }).optional(),
    onceEachTurn: z.boolean().optional(),
    targets: z.array(targetSpecSchema).optional(),
    effects: effectsField,
  }),
  z.object({
    kind: z.literal('activated'),
    ...coverage,
    id: z.string().min(1),
    cost: costSchema,
    sorceryOnly: z.boolean().optional(),
    targets: z.array(targetSpecSchema).optional(),
    effects: effectsField,
  }),
  z.object({
    kind: z.literal('static'),
    ...coverage,
    affects: z.looseObject({ kind: z.string() }),
    change: z.looseObject({ kind: z.string() }),
    duration: z.looseObject({ kind: z.string() }).optional(),
  }),
  z.object({
    kind: z.literal('mana'),
    ...coverage,
    id: z.string().min(1),
    requiresTap: z.boolean().optional(),
    modes: z.array(z.array(manaProductionSchema)).min(1),
  }),
  z.object({
    kind: z.literal('loyalty'),
    ...coverage,
    id: z.string().min(1),
    cost: z.number().int(),
    targets: z.array(targetSpecSchema).optional(),
    effects: effectsField,
  }),
  z.object({
    kind: z.literal('replacement'),
    ...coverage,
    id: z.string().min(1),
    applies: z.looseObject({ kind: z.string() }),
    change: z.looseObject({ kind: z.string() }),
    selfReplacement: z.boolean().optional(),
  }),
]);

// --- Scenario tests ---

/**
 * A card's own tests, in the same file as the script (docs/09 "Card tests").
 *
 * Deliberately small and declarative: a board, one action, and what to expect. Somebody
 * who has never written TypeScript should be able to add one by copying the card above
 * theirs, and the auto-scripter's future LLM-assisted mode should be able to emit one.
 *
 * Everything is optional and has a sensible default — enough lands to cast the card, both
 * players at twenty — so a test says only what the card is about.
 */
const permanentFields = {
  name: z.string().min(1),
  keywords: z.array(keywordSchema).optional(),
  tapped: z.boolean().optional(),
};

const creatureSchema = z.object({
  ...permanentFields,
  power: z.number().int().default(2),
  toughness: z.number().int().default(2),
});

/**
 * Something on the battlefield that is not (only) a creature: the artifact for a
 * Shatter, the enchantment for a Naturalize. It needs its types spelled out because a
 * type is a characteristic of a card, and a board full of anonymous 2/2s cannot stand in
 * for one.
 */
const permanentSchema = z.object({
  ...permanentFields,
  types: z.array(typeSchema).min(1),
  power: z.number().int().optional(),
  toughness: z.number().int().optional(),
});

const sideSchema = z.object({
  creatures: z.array(creatureSchema).optional(),
  permanents: z.array(permanentSchema).optional(),
  life: z.number().int().optional(),
  handSize: z.number().int().optional(),
});

export const scenarioTestSchema = z.object({
  name: z.string().min(1),
  setup: z
    .object({
      you: sideSchema.optional(),
      opponent: sideSchema.optional(),
      /** Any-colour lands for the caster. Defaults to enough for the card's cost. */
      lands: z.number().int().nonnegative().optional(),
      /**
       * A spell the opponent casts first, so the card can be cast in response to it. What
       * a counterspell needs, and the only way to get a real spell on the stack. A bare
       * name is a creature spell; a card that cares what it counters says so.
       */
      opponentSpell: z
        .union([
          z.string(),
          z.object({ name: z.string().min(1), types: z.array(typeSchema).min(1) }),
        ])
        .optional(),
    })
    .optional(),
  /** Activate this ability of the card instead of casting it: an id, or a loyalty one. */
  activate: z.string().optional(),
  /** Activate one of the card's mana abilities, for a land. */
  activateMana: z.string().optional(),
  /** Destroy a permanent after the action, for the cards that care about dying. */
  kill: z.string().optional(),
  /** What the spell or ability targets: a creature by name, or `you` / `opponent`. */
  targets: z.array(z.string()).optional(),
  expect: z.object({
    life: z
      .object({ you: z.number().int().optional(), opponent: z.number().int().optional() })
      .optional(),
    handSize: z
      .object({ you: z.number().int().optional(), opponent: z.number().int().optional() })
      .optional(),
    /** Where a named creature — or the card itself, `this` — ended up. */
    zone: z.record(z.string(), z.string()).optional(),
    power: z.record(z.string(), z.number().int()).optional(),
    toughness: z.record(z.string(), z.number().int()).optional(),
    tapped: z.record(z.string(), z.boolean()).optional(),
    counters: z.record(z.string(), z.record(z.string(), z.number().int())).optional(),
    /** Permanents each player controls, for tokens and for board wipes. */
    permanents: z
      .object({ you: z.number().int().optional(), opponent: z.number().int().optional() })
      .optional(),
    /** Mana left in the caster's pool, for the cards that make some. */
    manaPool: z.number().int().optional(),
    /** Turns the caster is owed, for the ones that give an extra. */
    extraTurns: z.number().int().optional(),
    keywords: z.record(z.string(), z.array(keywordSchema)).optional(),
  }),
});

export type ScenarioTest = z.infer<typeof scenarioTestSchema>;

// --- The card ---

export const cardScriptSchema = z.object({
  /** Scryfall's oracle id: card identity everywhere in the system (docs/03). */
  oracleId: z.string().min(1),
  name: z.string().min(1),
  /** Written as it is printed: `{1}{G}`, or empty for a land. */
  manaCost: z.string().default(''),
  types: z.array(typeSchema).min(1),
  supertypes: z.array(z.enum(supertypes)).optional(),
  subtypes: z.array(z.string()).optional(),
  colours: z.array(colourSchema).default([]),
  power: z.number().int().optional(),
  toughness: z.number().int().optional(),
  loyalty: z.number().int().optional(),
  /** The printed keyword line, expanded into the engine's keywords at load time. */
  keywords: z.array(keywordSchema).default([]),
  flash: z.boolean().optional(),
  splitSecond: z.boolean().optional(),
  abilities: z.array(abilitySchema).default([]),
  /** The oracle text this script was written against, for the validator to check. */
  text: z.string().optional(),
  /** The card's own scenario tests (docs/09). */
  tests: z.array(scenarioTestSchema).default([]),
});

export type CardScript = z.infer<typeof cardScriptSchema>;
export type CardScriptInput = z.input<typeof cardScriptSchema>;
