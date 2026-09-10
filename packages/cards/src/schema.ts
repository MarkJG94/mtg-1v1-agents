import type { AbilityDef, Effect, Quantity, TokenDef } from '@mtg/engine';
import {
  EFFECT_OPS,
  KEYWORDS,
  REPLACEMENTS,
  STATIC_EFFECTS,
  TRIGGERS,
  UNIMPLEMENTED_OPS,
} from '@mtg/engine';
import type { CardType, Color, Supertype } from '@mtg/shared';
import { z } from 'zod';

/**
 * The card-script document: an engine CardDefinition keyed by oracle id, plus the oracle text and the
 * `covers` bookkeeping that ties every sentence of the text to one ability (docs/03).
 */
export interface CardScript {
  oracleId: string;
  name: string;
  manaCost?: string;
  colors?: Color[];
  supertypes?: Supertype[];
  types: CardType[];
  subtypes?: string[];
  power?: number | Quantity | string;
  toughness?: number | Quantity | string;
  loyalty?: number;
  text: string;
  abilities: ScriptAbility[];
  tests?: ScenarioTest[];
}

/** An ability with the indices of the oracle-text sentences it implements. */
export type ScriptAbility = AbilityDef & { covers?: number[] };

export interface ScenarioTest {
  name: string;
  setup: Partial<Record<'A' | 'B', PlayerSetup>>;
  actions: ScenarioAction[];
  expect: Record<string, unknown>;
}

export interface PlayerSetup {
  hand?: string[];
  battlefield?: (
    | string
    | { name: string; tapped?: boolean; counters?: Record<string, number>; attachedTo?: string }
  )[];
  graveyard?: string[];
  library?: string[];
  life?: number;
}

export type ScenarioAction =
  | 'resolveAll'
  | 'pass'
  | 'passBoth'
  | 'finishCombat'
  | 'nextTurn'
  | {
      cast: string;
      target?: string | string[];
      targets?: (string | string[])[];
      x?: number;
      mode?: number;
      choose?: string[];
    }
  | {
      activate: string;
      ability?: number;
      target?: string | string[];
      targets?: (string | string[])[];
      x?: number;
      choose?: string[];
    }
  | { activateMana: string; ability?: number; option?: number }
  | { playLand: string }
  | { attack: (string | [string, string])[] }
  | { block: [string, string][] }
  | { toStep: string }
  | { answer: Record<string, unknown> };

const CARD_TYPES = [
  'creature',
  'instant',
  'sorcery',
  'artifact',
  'enchantment',
  'land',
  'planeswalker',
  'kindred',
] as const;
const SUPERTYPES = ['legendary', 'basic', 'snow'] as const;
const COLORS = ['W', 'U', 'B', 'R', 'G'] as const;
const ZONES = ['library', 'hand', 'battlefield', 'graveyard', 'exile', 'stack', 'command'] as const;
const PLAYER_SEL = ['you', 'opponent', 'any'] as const;
const DURATIONS = [
  'untilEndOfTurn',
  'permanent',
  'untilYourNextTurn',
  'whileSourceOnBattlefield',
  'untilSourceLeaves',
] as const;

const cardType = z.enum(CARD_TYPES);
const supertype = z.enum(SUPERTYPES);
const color = z.enum(COLORS);
const zone = z.enum(ZONES);
const playerSel = z.enum(PLAYER_SEL);
const duration = z.enum(DURATIONS);
const keyword = z.enum(
  KEYWORDS.filter((k) => k !== 'protection' && k !== 'ward') as [string, ...string[]],
);
const ref = z.string().min(1);
const playerRef = z.string().min(1);
const oneOrMany = <T extends z.ZodTypeAny>(s: T) => z.union([s, z.array(s)]);

export const filterSchema: z.ZodType<unknown> = z.lazy(() =>
  z
    .object({
      type: oneOrMany(cardType).optional(),
      notType: oneOrMany(cardType).optional(),
      subtype: oneOrMany(z.string()).optional(),
      supertype: oneOrMany(supertype).optional(),
      color: oneOrMany(color).optional(),
      colorless: z.boolean().optional(),
      multicolored: z.boolean().optional(),
      controller: playerSel.optional(),
      owner: playerSel.optional(),
      zone: zone.optional(),
      tapped: z.boolean().optional(),
      untapped: z.boolean().optional(),
      mvLTE: quantitySchema.optional(),
      mvGTE: quantitySchema.optional(),
      mvEQ: quantitySchema.optional(),
      powerGTE: quantitySchema.optional(),
      powerLTE: quantitySchema.optional(),
      toughnessGTE: quantitySchema.optional(),
      toughnessLTE: quantitySchema.optional(),
      hasKeyword: keyword.optional(),
      lacksKeyword: keyword.optional(),
      isToken: z.boolean().optional(),
      nonToken: z.boolean().optional(),
      name: z.string().optional(),
      attacking: z.boolean().optional(),
      blocking: z.boolean().optional(),
      blocked: z.boolean().optional(),
      other: z.boolean().optional(),
      player: playerSel.optional(),
      spell: z.boolean().optional(),
      ability: z.boolean().optional(),
      any: z.boolean().optional(),
      anyPermanent: z.boolean().optional(),
      attachedTo: filterSchema.optional(),
      hasCounter: z.string().optional(),
      damaged: z.boolean().optional(),
      enteredThisTurn: z.boolean().optional(),
      not: filterSchema.optional(),
      and: z.array(filterSchema).optional(),
      or: z.array(filterSchema).optional(),
      self: z.boolean().optional(),
    })
    .strict(),
);

export const quantitySchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.number().int(),
    z.literal('x'),
    z.object({ count: filterSchema, zone: z.union([zone, z.literal('any')]).optional() }).strict(),
    z.object({ countTypes: z.literal('inAllGraveyards') }).strict(),
    z.object({ add: z.array(quantitySchema) }).strict(),
    z.object({ sub: z.tuple([quantitySchema, quantitySchema]) }).strict(),
    z.object({ mul: z.tuple([quantitySchema, quantitySchema]) }).strict(),
    z.object({ max: z.array(quantitySchema) }).strict(),
    z.object({ min: z.array(quantitySchema) }).strict(),
    z.object({ negate: quantitySchema }).strict(),
    z.object({ lifeTotal: playerRef }).strict(),
    z.object({ cardsInHand: playerRef }).strict(),
    z.object({ cardsInGraveyard: playerRef }).strict(),
    z.object({ power: ref }).strict(),
    z.object({ toughness: ref }).strict(),
    z.object({ manaValue: ref }).strict(),
    z.object({ counters: ref, counter: z.string() }).strict(),
    z.object({ devotion: z.array(color), player: playerRef.optional() }).strict(),
    z.object({ lands: playerRef }).strict(),
    z.object({ damageDealt: z.literal(true) }).strict(),
    z.object({ bound: z.string() }).strict(),
  ]),
);

export const conditionSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z
      .object({
        compare: quantitySchema,
        op: z.enum(['<', '<=', '=', '>=', '>', '!=']),
        to: quantitySchema,
      })
      .strict(),
    z
      .object({
        controls: filterSchema,
        player: playerRef.optional(),
        count: z.number().int().optional(),
      })
      .strict(),
    z
      .object({
        exists: filterSchema,
        zone: z.union([zone, z.literal('any')]).optional(),
        count: z.number().int().optional(),
      })
      .strict(),
    z.object({ isYourTurn: z.literal(true) }).strict(),
    z.object({ isTapped: ref }).strict(),
    z.object({ isAttacking: ref }).strict(),
    z.object({ hasKeyword: ref, keyword }).strict(),
    z.object({ matches: ref, filter: filterSchema }).strict(),
    z.object({ onBattlefield: ref }).strict(),
    z.object({ inZone: ref, zone }).strict(),
    z
      .object({
        landsPlayedThisTurn: z
          .object({ op: z.enum(['<', '>=', '=']), count: z.number().int() })
          .strict(),
      })
      .strict(),
    z.object({ step: z.array(z.string()) }).strict(),
    z.object({ not: conditionSchema }).strict(),
    z.object({ and: z.array(conditionSchema) }).strict(),
    z.object({ or: z.array(conditionSchema) }).strict(),
    z.object({ lifeGainedThisTurn: playerRef }).strict(),
    z
      .object({
        spellsCastThisTurn: z
          .object({
            player: playerRef.optional(),
            op: z.enum(['>=', '<']),
            count: z.number().int(),
          })
          .strict(),
      })
      .strict(),
  ]),
);

const affects = z.union([z.literal('self'), z.literal('attached'), filterSchema]);
const selfOrFilter = z.union([z.literal('self'), filterSchema]);

export const costSchema = z
  .object({
    mana: z.string().optional(),
    tap: z.boolean().optional(),
    untap: z.boolean().optional(),
    life: z.number().int().optional(),
    sacrifice: selfOrFilter.optional(),
    discard: z
      .union([
        z.number().int(),
        z.object({ filter: filterSchema.optional(), count: z.number().int() }).strict(),
      ])
      .optional(),
    exileFromGraveyard: z
      .object({ filter: filterSchema.optional(), count: z.number().int() })
      .strict()
      .optional(),
    removeCounters: z.object({ counter: z.string(), count: z.number().int() }).strict().optional(),
    tapOther: z.object({ filter: filterSchema, count: z.number().int() }).strict().optional(),
    x: z.boolean().optional(),
  })
  .strict();

export const targetSpecSchema = z
  .object({
    id: z.string().min(1),
    filter: filterSchema,
    count: z
      .union([z.number().int(), z.object({ upTo: z.number().int() }).strict(), z.literal('any')])
      .optional(),
    optional: z.boolean().optional(),
  })
  .strict();

const triggerOn = z.enum(TRIGGERS as unknown as [string, ...string[]]);
export const triggerSchema = z
  .object({
    on: triggerOn,
    filter: selfOrFilter.optional(),
    who: playerSel.optional(),
    combat: z.boolean().optional(),
    toPlayer: z.boolean().optional(),
  })
  .strict();

export const staticEffectSchema: z.ZodType<unknown> = z.lazy(() =>
  z
    .object({
      type: z.enum(STATIC_EFFECTS as unknown as [string, ...string[]]),
      affects: z.union([affects, z.literal('you')]).optional(),
      power: quantitySchema.optional(),
      toughness: quantitySchema.optional(),
      cda: z.boolean().optional(),
      ability: abilitySchema.optional(),
      keyword: z.union([keyword, z.literal('all')]).optional(),
      types: z.array(cardType).optional(),
      subtypes: z.array(z.string()).optional(),
      colors: z.array(color).optional(),
      controller: z.literal('you').optional(),
      by: z.union([filterSchema, z.enum(['opponents', 'any'])]).optional(),
      amount: z.union([quantitySchema, z.literal('all')]).optional(),
      who: playerSel.optional(),
      abilities: z.enum(['all', 'nonMana']).optional(),
      player: playerSel.optional(),
      size: z.union([z.number().int(), z.literal('unlimited')]).optional(),
      count: z.number().int().optional(),
      combat: z.boolean().optional(),
      noncombat: z.boolean().optional(),
    })
    .strict(),
);

export const replacementSchema: z.ZodType<unknown> = z.lazy(() =>
  z
    .object({
      event: z.enum(REPLACEMENTS as unknown as [string, ...string[]]),
      filter: selfOrFilter.optional(),
      tapped: z.literal(true).optional(),
      withCounters: z.object({ counter: z.string(), count: quantitySchema }).strict().optional(),
      unlessPay: z.object({ life: z.number().int() }).strict().optional(),
      instead: z.enum(['exile', 'libraryBottom', 'libraryTop', 'hand']).optional(),
      to: z.union([z.literal('you'), selfOrFilter]).optional(),
      prevent: z.union([z.literal('all'), quantitySchema]).optional(),
      combat: z.boolean().optional(),
      noncombat: z.boolean().optional(),
      from: filterSchema.optional(),
      double: z.literal(true).optional(),
      extra: z.union([z.number().int(), quantitySchema]).optional(),
      who: playerSel.optional(),
      skip: z.literal(true).optional(),
      multiplier: z.number().optional(),
    })
    .strict(),
);

export const tokenSchema: z.ZodType<unknown> = z.lazy(() =>
  z
    .object({
      name: z.string(),
      types: z.array(cardType),
      subtypes: z.array(z.string()).optional(),
      supertypes: z.array(supertype).optional(),
      colors: z.array(color).optional(),
      power: z.number().int().optional(),
      toughness: z.number().int().optional(),
      abilities: z.array(abilitySchema).optional(),
    })
    .strict(),
);

const ALL_OPS = [...EFFECT_OPS, ...UNIMPLEMENTED_OPS] as unknown as [string, ...string[]];

/**
 * Effects are validated structurally by op. The object is permissive about which keys each op uses
 * (the engine ignores extras) but strict about unknown ops and value shapes.
 */
export const effectSchema: z.ZodType<unknown> = z.lazy(() =>
  z
    .object({
      op: z.enum(ALL_OPS),
      amount: z.union([quantitySchema, z.literal('all')]).optional(),
      to: z
        .union([
          ref,
          z.array(ref),
          z.enum(['hand', 'graveyard', 'libraryTop', 'libraryBottom', 'battlefield', 'exile']),
        ])
        .optional(),
      from: ref.optional(),
      divided: z.boolean().optional(),
      player: playerRef.optional(),
      count: z.union([quantitySchema, z.literal('hand')]).optional(),
      random: z.boolean().optional(),
      filter: filterSchema.optional(),
      chooser: z.literal('controller').optional(),
      target: ref.optional(),
      unlessPay: z.string().optional(),
      noRegenerate: z.boolean().optional(),
      zone: zone.optional(),
      players: playerSel.optional(),
      tapped: z.boolean().optional(),
      controller: playerRef.optional(),
      token: tokenSchema.optional(),
      attacking: z.boolean().optional(),
      counter: z.string().optional(),
      power: quantitySchema.optional(),
      toughness: quantitySchema.optional(),
      duration: duration.optional(),
      ability: abilitySchema.optional(),
      reveal: z.boolean().optional(),
      mana: z.string().optional(),
      combat: z.boolean().optional(),
      a: ref.optional(),
      b: ref.optional(),
      effects: z.array(effectSchema).optional(),
      as: z.string().optional(),
      order: z.literal('apnap').optional(),
      condition: conditionSchema.optional(),
      // biome-ignore lint/suspicious/noThenProperty: `then` is the effect-op field name for `if`
      then: z.array(effectSchema).optional(),
      else: z.array(effectSchema).optional(),
      cost: costSchema.optional(),
      trigger: triggerSchema.optional(),
      bind: z.array(ref).optional(),
      effect: staticEffectSchema.optional(),
      options: z
        .array(z.object({ label: z.string(), effects: z.array(effectSchema) }).strict())
        .optional(),
      newTargets: z.boolean().optional(),
      value: quantitySchema.optional(),
      newTarget: ref.optional(),
      hand: playerRef.optional(),
    })
    .strict(),
);

const modeSchema = z
  .object({
    label: z.string(),
    targets: z.array(targetSpecSchema).optional(),
    effects: z.array(effectSchema),
  })
  .strict();

export const abilitySchema: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('keyword'),
        keyword: z.enum(KEYWORDS as unknown as [string, ...string[]]),
        from: z
          .union([
            z.object({ color }).strict(),
            z.object({ type: cardType }).strict(),
            z.object({ everything: z.literal(true) }).strict(),
            z.object({ colored: z.literal(true) }).strict(),
            z.object({ filter: filterSchema }).strict(),
          ])
          .optional(),
        cost: costSchema.optional(),
        covers: z.array(z.number().int()).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('spell'),
        targets: z.array(targetSpecSchema).optional(),
        effects: z.array(effectSchema),
        modes: z.array(modeSchema).optional(),
        additionalCost: costSchema.optional(),
        alternativeCost: costSchema.optional(),
        covers: z.array(z.number().int()).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('activated'),
        cost: costSchema,
        targets: z.array(targetSpecSchema).optional(),
        effects: z.array(effectSchema),
        timing: z.enum(['instant', 'sorcery']).optional(),
        zone: zone.optional(),
        oncePerTurn: z.boolean().optional(),
        condition: conditionSchema.optional(),
        covers: z.array(z.number().int()).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('mana'),
        cost: costSchema,
        produces: z.string().optional(),
        choice: z.array(z.string()).optional(),
        anyColor: z.boolean().optional(),
        condition: conditionSchema.optional(),
        covers: z.array(z.number().int()).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('triggered'),
        trigger: triggerSchema,
        condition: conditionSchema.optional(),
        targets: z.array(targetSpecSchema).optional(),
        effects: z.array(effectSchema),
        optional: z.boolean().optional(),
        oncePerTurn: z.boolean().optional(),
        covers: z.array(z.number().int()).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('static'),
        effect: staticEffectSchema,
        also: z.array(staticEffectSchema).optional(),
        condition: conditionSchema.optional(),
        covers: z.array(z.number().int()).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('loyalty'),
        cost: z.number().int(),
        targets: z.array(targetSpecSchema).optional(),
        effects: z.array(effectSchema),
        covers: z.array(z.number().int()).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('replacement'),
        replaces: replacementSchema,
        condition: conditionSchema.optional(),
        covers: z.array(z.number().int()).optional(),
      })
      .strict(),
  ]),
);

const playerSetupSchema = z
  .object({
    hand: z.array(z.string()).optional(),
    battlefield: z
      .array(
        z.union([
          z.string(),
          z
            .object({
              name: z.string(),
              tapped: z.boolean().optional(),
              counters: z.record(z.string(), z.number().int()).optional(),
              attachedTo: z.string().optional(),
            })
            .strict(),
        ]),
      )
      .optional(),
    graveyard: z.array(z.string()).optional(),
    library: z.array(z.string()).optional(),
    life: z.number().int().optional(),
  })
  .strict();

const targetsField = z.array(z.union([z.string(), z.array(z.string())])).optional();
const actionSchema = z.union([
  z.enum(['resolveAll', 'pass', 'passBoth', 'finishCombat', 'nextTurn']),
  z
    .object({
      cast: z.string(),
      target: z.union([z.string(), z.array(z.string())]).optional(),
      targets: targetsField,
      x: z.number().int().optional(),
      mode: z.number().int().optional(),
      choose: z.array(z.string()).optional(),
    })
    .strict(),
  z
    .object({
      activate: z.string(),
      ability: z.number().int().optional(),
      target: z.union([z.string(), z.array(z.string())]).optional(),
      targets: targetsField,
      x: z.number().int().optional(),
      choose: z.array(z.string()).optional(),
    })
    .strict(),
  z
    .object({
      activateMana: z.string(),
      ability: z.number().int().optional(),
      option: z.number().int().optional(),
    })
    .strict(),
  z.object({ playLand: z.string() }).strict(),
  z.object({ attack: z.array(z.union([z.string(), z.tuple([z.string(), z.string()])])) }).strict(),
  z.object({ block: z.array(z.tuple([z.string(), z.string()])) }).strict(),
  z.object({ toStep: z.string() }).strict(),
  z.object({ answer: z.record(z.string(), z.unknown()) }).strict(),
]);

export const scenarioTestSchema = z
  .object({
    name: z.string(),
    setup: z.object({ A: playerSetupSchema.optional(), B: playerSetupSchema.optional() }).strict(),
    actions: z.array(actionSchema),
    expect: z.record(z.string(), z.unknown()),
  })
  .strict();

export const cardScriptSchema = z
  .object({
    oracleId: z.string().min(1),
    name: z.string().min(1),
    manaCost: z.string().optional(),
    colors: z.array(color).optional(),
    supertypes: z.array(supertype).optional(),
    types: z.array(cardType).min(1),
    subtypes: z.array(z.string()).optional(),
    power: z.union([z.number().int(), z.string(), quantitySchema]).optional(),
    toughness: z.union([z.number().int(), z.string(), quantitySchema]).optional(),
    loyalty: z.number().int().optional(),
    text: z.string(),
    abilities: z.array(abilitySchema),
    tests: z.array(scenarioTestSchema).optional(),
  })
  .strict();

export interface SchemaResult {
  ok: boolean;
  script: CardScript | null;
  errors: string[];
}

/** Validates a raw document against the card-script schema, returning readable error paths. */
export function parseCardScript(raw: unknown): SchemaResult {
  const r = cardScriptSchema.safeParse(raw);
  if (r.success) return { ok: true, script: r.data as unknown as CardScript, errors: [] };
  const errors = r.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`);
  return { ok: false, script: null, errors };
}

/** JSON Schema for editor completion in YAML files (`pnpm --filter @mtg/cards schema`). */
export function cardScriptJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(cardScriptSchema, { unrepresentable: 'any' }) as Record<string, unknown>;
}

export type { Effect, TokenDef };
