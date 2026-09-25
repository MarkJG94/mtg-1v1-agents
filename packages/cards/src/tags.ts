import type {
  CardAbility,
  CardDefinition,
  EffectOp,
  Filter,
  ObjectSelector,
  TargetSelector,
  TargetSpec,
} from '@mtg/engine';
import { type CardKind, type CardTags, cardKinds } from '@mtg/shared';

/**
 * What a card is and what it answers, read off its script (docs/04 "Sideboarding agent";
 * roadmap 4.6).
 *
 * The sideboarding agent needs a prior for a card it has never seen played in a matchup,
 * and docs/04 describes it: tags "inferred from the script: e.g. a `destroy` op with a
 * `creature` filter tags `vs: creatures`", matched against what the opponent has been
 * seen to play. Two lists, then:
 *
 * - **`is`** — what the card is: its card types, and the roles its ops give it (burn, a
 *   counterspell, lifegain, a card that uses the graveyard). This is what an opponent's
 *   observed deck is described by.
 * - **`vs`** — what the card answers: the kinds of thing its removal-shaped ops —
 *   destroy, exile, bounce, damage, fight, gain control, counter, a toughness-lowering pump
 *   — can be pointed at, as the filters of its targets or its "each" say. A filter that
 *   limits itself to the controller's own things answers nothing.
 *
 * Read from the definition rather than the text, so it is as good as the script and no
 * better, and it never names a card: the tags of Doom Blade come from "destroy target
 * creature", not from knowing what Doom Blade is.
 */

export const cardTags = (definition: CardDefinition): CardTags => {
  const is = new Set<CardKind>();
  const vs = new Set<CardKind>();

  for (const type of definition.types) {
    if (isKind(type)) is.add(type);
  }
  if (!definition.types.includes('land')) is.add('spell');
  // Split second answers counterspells: nothing can be cast in response (CR 702.61a).
  if (definition.splitSecond === true) vs.add('counterspell');

  for (const ability of definition.abilities) {
    const context = { targets: targetsOf(ability), each: null as Filter | null };
    for (const op of effectsOf(ability)) walk(op, context, is, vs);
  }

  return { is: sorted(is), vs: sorted(vs) };
};

interface Context {
  readonly targets: readonly TargetSpec[];
  /** The filter the enclosing `forEach` runs over, which `$each` refers to. */
  readonly each: Filter | null;
}

const walk = (op: EffectOp, context: Context, is: Set<CardKind>, vs: Set<CardKind>): void => {
  switch (op.op) {
    case 'sequence':
      for (const inner of op.effects) walk(inner, context, is, vs);
      return;
    case 'forEach':
      for (const inner of op.effects) walk(inner, { ...context, each: op.of }, is, vs);
      return;
    case 'if':
      for (const inner of [...op.thenDo, ...(op.otherwise ?? [])]) walk(inner, context, is, vs);
      return;

    case 'damage': {
      const kinds = kindsOfTarget(op.to, context);
      for (const kind of kinds.objects) vs.add(kind);
      if (kinds.player) is.add('burn');
      return;
    }
    case 'destroy':
    case 'exile':
    case 'bounce':
    case 'gainControl':
      for (const kind of kindsOfObject(op.object, context)) vs.add(kind);
      if (op.op === 'exile' && fromGraveyard(op.object, context)) vs.add('graveyard');
      return;
    case 'fight':
      for (const kind of kindsOfObject(op.second, context)) vs.add(kind);
      return;
    case 'pump':
      // Only a pump that takes toughness away is an answer ("-3/-3 until end of turn").
      if (typeof op.toughness === 'number' && op.toughness < 0) {
        for (const kind of kindsOfObject(op.object, context)) vs.add(kind);
      }
      return;
    case 'counter':
      is.add('counterspell');
      vs.add('spell');
      return;
    case 'gainLife':
      is.add('lifegain');
      // Life is what burn takes away, so gaining it is the answer to burn.
      vs.add('burn');
      return;
    case 'moveZone':
      if (fromGraveyard(op.object, context)) is.add('graveyard');
      return;
    default:
      return;
  }
};

// --- What a selector can point at ---

const kindsOfTarget = (
  to: TargetSelector,
  context: Context,
): { readonly objects: readonly CardKind[]; readonly player: boolean } => {
  switch (to.kind) {
    case 'player':
      return { objects: [], player: to.player.kind !== 'you' };
    case 'object':
      return { objects: kindsOfObject(to.object, context), player: false };
    case 'chosen': {
      const filter = context.targets.find((target) => target.id === to.id)?.filter;
      if (filter === undefined) return { objects: [], player: false };
      const reach = reachOf(filter);
      return { objects: reach.objects, player: reach.player };
    }
  }
};

const kindsOfObject = (selector: ObjectSelector, context: Context): readonly CardKind[] => {
  const filter = filterOf(selector, context);
  return filter === null ? [] : reachOf(filter).objects;
};

const filterOf = (selector: ObjectSelector, context: Context): Filter | null => {
  if (selector.kind === 'target') {
    return context.targets.find((target) => target.id === selector.id)?.filter ?? null;
  }
  if (selector.kind === 'each') return context.each;
  return null;
};

const fromGraveyard = (selector: ObjectSelector, context: Context): boolean => {
  const filter = filterOf(selector, context);
  return filter !== null && mentionsGraveyard(filter);
};

/**
 * What a filter can match: the kinds of object, and whether a player. `and` keeps what
 * every part allows (so "creature an opponent controls" is still a creature), `or` what
 * any part does, and a filter that confines itself to the controller's own things matches
 * nothing an opponent has.
 */
const reachOf = (filter: Filter): { objects: readonly CardKind[]; player: boolean } => {
  switch (filter.kind) {
    case 'any':
      return { objects: ['creature', 'planeswalker'], player: true };
    case 'player':
      return { objects: [], player: true };
    case 'creature':
      return { objects: ['creature'], player: false };
    case 'planeswalker':
      return { objects: ['planeswalker'], player: false };
    case 'permanent':
      return {
        objects: ['creature', 'artifact', 'enchantment', 'planeswalker', 'land'],
        player: false,
      };
    case 'spell':
      return { objects: ['spell'], player: false };
    case 'type':
      return { objects: isKind(filter.type) ? [filter.type] : [], player: false };
    case 'controlledBy':
      return filter.player === 'you'
        ? { objects: [], player: false }
        : { objects: everything, player: true };
    case 'and': {
      let objects: readonly CardKind[] = everything;
      let player = true;
      for (const part of filter.filters) {
        const reach = reachOf(part);
        objects = objects.filter((kind) => reach.objects.includes(kind));
        player &&= reach.player;
      }
      return { objects, player };
    }
    case 'or': {
      const objects = new Set<CardKind>();
      let player = false;
      for (const part of filter.filters) {
        const reach = reachOf(part);
        for (const kind of reach.objects) objects.add(kind);
        player ||= reach.player;
      }
      return { objects: [...objects], player };
    }
    case 'not': {
      // "Noncreature", "nonartifact": everything but the kinds the inner filter names.
      // Any other negation — "nonblack", "untapped" — narrows without excluding a kind.
      const inner = filter.filter;
      if (inner.kind === 'creature' || inner.kind === 'planeswalker' || inner.kind === 'type') {
        const excluded = reachOf(inner).objects;
        return { objects: everything.filter((kind) => !excluded.includes(kind)), player: true };
      }
      return { objects: everything, player: true };
    }
    // Everything else narrows without saying what kind of thing: a colour, a keyword,
    // "tapped", "not black". Alone it matches anything; inside an `and` it keeps what the
    // other parts allow.
    default:
      return { objects: everything, player: true };
  }
};

const everything: readonly CardKind[] = [
  'creature',
  'artifact',
  'enchantment',
  'planeswalker',
  'land',
  'spell',
];

const mentionsGraveyard = (filter: Filter): boolean => {
  if (filter.kind === 'inZone') return filter.zone.endsWith(':graveyard');
  if (filter.kind === 'and' || filter.kind === 'or') return filter.filters.some(mentionsGraveyard);
  return false;
};

// --- Plumbing ---

const isKind = (value: string): value is CardKind =>
  (cardKinds as readonly string[]).includes(value);

const targetsOf = (ability: CardAbility): readonly TargetSpec[] =>
  'targets' in ability ? (ability.targets ?? []) : [];

const effectsOf = (ability: CardAbility): readonly EffectOp[] =>
  'effects' in ability ? (ability.effects ?? []) : [];

const sorted = (kinds: ReadonlySet<CardKind>): CardKind[] =>
  cardKinds.filter((kind) => kinds.has(kind));
