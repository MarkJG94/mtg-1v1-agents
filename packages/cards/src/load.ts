import {
  type CardAbility,
  type CardDefinition,
  type Condition,
  type EffectOp,
  effectChangeKinds,
  effectDurationKinds,
  effectSelectorKinds,
  eventMatcherKinds,
  type Filter,
  isKnownOp,
  keywords as keywordSet,
  parseManaCost,
  type Quantity,
  replacementChangeKinds,
  type TargetSpec,
  triggerWhenKinds,
} from '@mtg/engine';
import { asOracleId } from '@mtg/shared';
import { type ArgKind, opSpecs } from './ops-spec.js';
import {
  type CardScript,
  cardScriptSchema,
  conditionSchema,
  filterSchema,
  objectRef,
  playerRef,
  quantitySchema,
  targetRef,
} from './schema.js';

/**
 * The loader: a card script becomes a `CardDefinition` the engine can play (docs/03).
 *
 * Two jobs. The schema has already checked the shape, so this converts the friendly
 * script forms into the engine's tagged unions — `$t` into a target selector, `{R}` into
 * a parsed cost, a keyword line into the engine's keyword set. And it checks the things a
 * shape check cannot: that every op has the arguments it needs, that an ability only
 * refers to targets it declared, and that a `when` or a `change` names something the
 * engine actually has.
 *
 * Anything wrong is a `ScriptError` naming the card and the path, because these are read
 * by whoever is writing the script — a hand-scripter or the auto-scripter's report.
 */

export class ScriptError extends Error {
  constructor(
    readonly card: string,
    readonly path: string,
    message: string,
  ) {
    super(`${card}: ${path}: ${message}`);
    this.name = 'ScriptError';
  }
}

/** Parse and convert in one step. Throws `ScriptError` on anything unusable. */
export const loadCardScript = (input: unknown): CardDefinition => {
  const parsed = cardScriptSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const name =
      typeof input === 'object' && input !== null && 'name' in input
        ? String((input as { name: unknown }).name)
        : 'card script';
    throw new ScriptError(
      name,
      issue === undefined ? '' : issue.path.join('.'),
      issue?.message ?? 'did not match the card-script schema',
    );
  }

  return definitionFrom(parsed.data);
};

export const loadCardScripts = (inputs: readonly unknown[]): readonly CardDefinition[] =>
  inputs.map(loadCardScript);

const definitionFrom = (script: CardScript): CardDefinition => {
  const cost = parseManaCost(script.manaCost);

  return {
    oracleId: asOracleId(script.oracleId),
    name: script.name,
    manaCost: cost,
    types: script.types,
    ...(script.supertypes !== undefined ? { supertypes: script.supertypes } : {}),
    ...(script.subtypes !== undefined ? { subtypes: script.subtypes } : {}),
    colours: script.colours,
    ...(script.power !== undefined ? { power: script.power } : {}),
    ...(script.toughness !== undefined ? { toughness: script.toughness } : {}),
    ...(script.loyalty !== undefined ? { loyalty: script.loyalty } : {}),
    keywords: keywordSet(Object.fromEntries(script.keywords.map((each) => [each, true]))),
    ...(script.flash !== undefined ? { flash: script.flash } : {}),
    ...(script.splitSecond !== undefined ? { splitSecond: script.splitSecond } : {}),
    abilities: script.abilities.map((ability, index) =>
      abilityFrom(script, ability, `abilities[${index}]`),
    ),
  };
};

const abilityFrom = (
  script: CardScript,
  ability: CardScript['abilities'][number],
  path: string,
): CardAbility => {
  switch (ability.kind) {
    case 'spell':
    case 'triggered':
    case 'activated':
    case 'loyalty': {
      // Rebuilt field by field: zod makes an absent optional `undefined`, which is not
      // the same as absent under `exactOptionalPropertyTypes`.
      const targets: TargetSpec[] = (ability.targets ?? []).map((target) => ({
        id: target.id,
        filter: target.filter,
        ...(target.count !== undefined ? { count: target.count } : {}),
        ...(target.upTo !== undefined ? { upTo: target.upTo } : {}),
      }));
      const declared = new Set(targets.map((target) => target.id));
      const effects = ability.effects.map((effect, index) =>
        opFrom(script, effect, declared, `${path}.effects[${index}]`),
      );

      if (ability.kind === 'spell') {
        return { kind: 'spell', ...(targets.length > 0 ? { targets } : {}), effects };
      }
      if (ability.kind === 'triggered') {
        checkKind(script, `${path}.when`, ability.when.kind, triggerWhenKinds);
        return {
          kind: 'triggered',
          id: ability.id,
          when: ability.when as never,
          ...(ability.interveningIf !== undefined
            ? { interveningIf: ability.interveningIf as never }
            : {}),
          ...(ability.onceEachTurn !== undefined ? { onceEachTurn: ability.onceEachTurn } : {}),
          ...(targets.length > 0 ? { targets } : {}),
          effects,
        };
      }
      if (ability.kind === 'activated') {
        return {
          kind: 'activated',
          id: ability.id,
          cost: {
            ...(ability.cost.mana !== undefined ? { mana: parseManaCost(ability.cost.mana) } : {}),
            ...(ability.cost.tap !== undefined ? { tap: ability.cost.tap } : {}),
            ...(ability.cost.sacrificeSelf !== undefined
              ? { sacrificeSelf: ability.cost.sacrificeSelf }
              : {}),
          },
          ...(ability.sorceryOnly !== undefined ? { sorceryOnly: ability.sorceryOnly } : {}),
          ...(targets.length > 0 ? { targets } : {}),
          effects,
        };
      }
      return {
        kind: 'loyalty',
        id: ability.id,
        cost: ability.cost,
        ...(targets.length > 0 ? { targets } : {}),
        effects,
      };
    }

    case 'static':
      checkKind(script, `${path}.affects`, ability.affects.kind, effectSelectorKinds);
      checkKind(script, `${path}.change`, ability.change.kind, effectChangeKinds);
      if (ability.duration !== undefined) {
        checkKind(script, `${path}.duration`, ability.duration.kind, effectDurationKinds);
      }
      return {
        kind: 'static',
        affects: ability.affects as never,
        change: ability.change as never,
        ...(ability.duration !== undefined ? { duration: ability.duration as never } : {}),
      };

    case 'mana':
      return {
        kind: 'mana',
        id: ability.id,
        ...(ability.requiresTap !== undefined ? { requiresTap: ability.requiresTap } : {}),
        modes: ability.modes.map((mode) =>
          mode.map((production) => ({
            type: production.type,
            amount: production.amount,
            ...(production.snow !== undefined ? { snow: production.snow } : {}),
            ...(production.restriction !== undefined
              ? { restriction: production.restriction }
              : {}),
          })),
        ),
      };

    case 'replacement':
      checkKind(script, `${path}.applies`, ability.applies.kind, eventMatcherKinds);
      checkKind(script, `${path}.change`, ability.change.kind, replacementChangeKinds);
      return {
        kind: 'replacement',
        id: ability.id,
        applies: ability.applies as never,
        change: ability.change as never,
        ...(ability.selfReplacement !== undefined
          ? { selfReplacement: ability.selfReplacement }
          : {}),
      };
  }
};

/**
 * Convert one op, argument by argument, against the table in `ops-spec.ts`.
 *
 * Three things are checked here that the schema cannot: that the op has the arguments it
 * needs, that it has no arguments it does not, and that every `$target` it mentions was
 * actually declared by the ability — a typo in a target name would otherwise be a spell
 * that silently does nothing.
 */
const opFrom = (
  script: CardScript,
  raw: Record<string, unknown>,
  declared: ReadonlySet<string>,
  path: string,
): EffectOp => {
  const name = raw.op;
  if (typeof name !== 'string' || !isKnownOp(name)) {
    throw new ScriptError(script.name, path, `no such effect op: ${String(name)}`);
  }

  const spec = opSpecs[name];
  const converted: Record<string, unknown> = { op: name };

  for (const [written, value] of Object.entries(raw)) {
    if (written === 'op') continue;
    const key = spec.aliases?.find(([script]) => script === written)?.[1] ?? written;
    const kind = spec.args[key];
    if (kind === undefined) {
      throw new ScriptError(script.name, path, `op "${name}" takes no argument "${written}"`);
    }
    converted[key] = convertArg(script, value, kind, declared, `${path}.${written}`);
  }

  for (const required of spec.required) {
    if (converted[required] === undefined) {
      const written = spec.aliases?.find(([, engine]) => engine === required)?.[0] ?? required;
      throw new ScriptError(script.name, path, `op "${name}" needs "${written}"`);
    }
  }

  return converted as unknown as EffectOp;
};

const convertArg = (
  script: CardScript,
  value: unknown,
  kind: ArgKind,
  declared: ReadonlySet<string>,
  path: string,
): unknown => {
  switch (kind) {
    case 'raw':
      return value;

    case 'effects': {
      if (!Array.isArray(value)) {
        throw new ScriptError(script.name, path, 'expected a list of effects');
      }
      return value.map((each, index) =>
        opFrom(script, each as Record<string, unknown>, declared, `${path}[${index}]`),
      );
    }

    case 'filter':
      return parseWith(script, filterSchema, value, path) as Filter;

    case 'condition':
      return parseWith(script, conditionSchema, value, path) as Condition;

    case 'quantityOrAll':
      return value === 'all' ? 'all' : (parseWith(script, quantitySchema, value, path) as Quantity);

    case 'quantity':
      return parseWith(script, quantitySchema, value, path) as Quantity;

    case 'target':
    case 'object':
    case 'player': {
      checkReference(script, value, declared, path);
      const schema = kind === 'target' ? targetRef : kind === 'object' ? objectRef : playerRef;
      return parseWith(script, schema, value, path);
    }
  }
};

/** A `$name` has to be a target the ability declared, or it points at nothing. */
const checkReference = (
  script: CardScript,
  value: unknown,
  declared: ReadonlySet<string>,
  path: string,
): void => {
  if (typeof value !== 'string' || !value.startsWith('$') || value === '$each') return;
  const id = value.slice(1);
  if (!declared.has(id)) {
    throw new ScriptError(script.name, path, `"$${id}" is not a target this ability declares`);
  }
};

const parseWith = (
  script: CardScript,
  schema: {
    readonly safeParse: (value: unknown) => {
      success: boolean;
      data?: unknown;
      error?: { issues: readonly { message: string }[] };
    };
  },
  value: unknown,
  path: string,
): unknown => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ScriptError(script.name, path, parsed.error?.issues[0]?.message ?? 'is not valid');
  }
  return parsed.data;
};

const checkKind = (
  script: CardScript,
  path: string,
  kind: string,
  known: readonly string[],
): void => {
  if (!known.includes(kind)) {
    throw new ScriptError(
      script.name,
      path,
      `the engine has no "${kind}" — one of: ${known.join(', ')}`,
    );
  }
};
