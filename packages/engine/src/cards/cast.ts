import {
  type EventTarget,
  isMainPhase,
  type ObjectId,
  type PlayerId,
  playerZone,
} from '@mtg/shared';
import type { EventEmitter } from '../events/emitter.js';
import { runEvent } from '../events/perform.js';
import {
  activateManaAbility,
  canActivateManaAbility,
  type ManaAbility,
  type ManaProduction,
} from '../mana/ability.js';
import type { ManaCost } from '../mana/cost.js';
import { canPayFromSources, payCost } from '../mana/payment.js';
import { addMana, type ManaPool } from '../mana/pool.js';
import { potentialManaFor } from '../mana/potential.js';
import { isStackEmpty, putActivatedAbilityOnStack, putOnStack } from '../stack.js';
import type { GameState } from '../state/game-state.js';
import { getObject, updateObject, updatePlayer } from '../state/update.js';
import { canBeTargeted } from '../targeting.js';
import {
  type ActivatedAbilityDef,
  bindTargets,
  type CardDefinition,
  hasType,
  isPermanentCard,
  isSorcerySpeed,
  spellAbilityOf,
  type TargetSpec,
} from './definition.js';
import { type EffectContext, matchesFilter } from './evaluate.js';
import { manaAbilitiesOf } from './registry.js';

/**
 * Casting a spell and activating an ability, with the card saying what is legal (CR 601).
 *
 * Until definitions existed, `putOnStack` was handed everything it needed to know by the
 * caller and paid no costs. This is the rest of CR 601.2: check the timing, check the
 * targets against what the ability actually asks for, pay, and only then put it on the
 * stack. Nothing here decides *what* a spell does — that is resolution's job.
 *
 * Paying is deterministic rather than a decision. The solver finds a way to pay from the
 * pool, and when the pool is short, mana sources are tapped in object order until it is
 * not. A player who wants to spend particular lands can tap them first and cast after;
 * making the choice a decision is a refinement, not a correctness fix, in exactly the way
 * combat damage assignment already is (docs/02).
 */

export class IllegalCastError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalCastError';
  }
}

export interface CastOptions {
  readonly targets?: readonly EventTarget[];
  /** The value chosen for {X} (CR 601.2b). */
  readonly x?: number;
  /** Tap mana sources to cover what the pool cannot. On by default. */
  readonly autoTap?: boolean;
}

export const castSpell = (
  state: GameState,
  emitter: EventEmitter,
  player: PlayerId,
  id: ObjectId,
  options: CastOptions = {},
): GameState => {
  const object = getObject(state, id);
  const definition = state.definitions.get(object.definitionId);
  if (definition === undefined) {
    throw new IllegalCastError(`object ${id} has no card script, so it cannot be cast`);
  }
  if (hasType(definition, 'land')) {
    throw new IllegalCastError('a land is played, not cast (CR 305.1)');
  }
  if (isSorcerySpeed(definition) && !atSorcerySpeed(state, player)) {
    throw new IllegalCastError(
      `${definition.name} can only be cast in your own main phase with an empty stack`,
    );
  }

  const targets = options.targets ?? [];
  const x = options.x ?? 0;
  checkTargets(state, player, id, definition, spellAbilityOf(definition)?.targets ?? [], targets);

  const paid = payFor(state, emitter, player, definition.manaCost, x, options.autoTap !== false);

  return putOnStack(paid, emitter, player, id, {
    resolvesTo: isPermanentCard(definition) ? 'battlefield' : playerZone(object.owner, 'graveyard'),
    splitSecond: definition.splitSecond ?? false,
    targets,
    colours: definition.colours,
    x,
  });
};

export interface ActivateOptions extends CastOptions {
  readonly targets?: readonly EventTarget[];
}

/** Activate one of a permanent's activated abilities (CR 602). */
export const activateAbility = (
  state: GameState,
  emitter: EventEmitter,
  player: PlayerId,
  id: ObjectId,
  abilityId: string,
  options: ActivateOptions = {},
): GameState => {
  const object = getObject(state, id);
  const definition = state.definitions.get(object.definitionId);
  const ability = definition?.abilities.find(
    (each): each is ActivatedAbilityDef => each.kind === 'activated' && each.id === abilityId,
  );
  if (definition === undefined || ability === undefined) {
    throw new IllegalCastError(`object ${id} has no activated ability "${abilityId}"`);
  }
  if (object.zone !== 'battlefield') {
    throw new IllegalCastError(`object ${id} is in ${object.zone}, not on the battlefield`);
  }
  if (object.controller !== player) {
    throw new IllegalCastError(`${player} does not control object ${id}`);
  }
  if (ability.sorceryOnly === true && !atSorcerySpeed(state, player)) {
    throw new IllegalCastError('this ability can only be activated at sorcery speed');
  }
  if (ability.cost.tap === true && object.tapped) {
    throw new IllegalCastError(`object ${id} is already tapped, so it cannot pay {T}`);
  }

  const targets = options.targets ?? [];
  const x = options.x ?? 0;
  checkTargets(state, player, id, definition, ability.targets ?? [], targets);

  let current = state;
  if (ability.cost.mana !== undefined) {
    current = payFor(current, emitter, player, ability.cost.mana, x, options.autoTap !== false);
  }
  if (ability.cost.tap === true) {
    current = updateObject(current, id, { tapped: true });
    emitter.emit(current, { type: 'tap', object: id });
  }
  if (ability.cost.sacrificeSelf === true) {
    // Costs are paid as the ability is activated, before it goes on the stack (CR 601.2h
    // through 602.2b), so the source is already gone when the ability resolves — which is
    // why "it deals 1 damage" works from a creature that has sacrificed itself.
    current = runEvent(current, emitter, {
      kind: 'moveZone',
      object: id,
      from: 'battlefield',
      to: playerZone(object.owner, 'graveyard'),
      cause: 'sacrifice',
      destruction: false,
    });
  }

  return putActivatedAbilityOnStack(current, emitter, {
    abilityId: ability.id,
    source: id,
    controller: player,
    definitionId: object.definitionId,
    targets,
  });
};

// --- Internals ---

const atSorcerySpeed = (state: GameState, player: PlayerId): boolean =>
  state.activePlayer === player && isMainPhase(state.step) && isStackEmpty(state);

/**
 * CR 601.2c: the right number of legal targets, chosen as the spell is cast. "Up to"
 * allows fewer, including none; anything else demands exactly what it asks for.
 *
 * Three things have to hold, and each is a different rule. The count is CR 601.2c. Each
 * target has to be something the ability actually asks for — "target creature" cannot be
 * aimed at a player — which is the *target requirement* in the same rule, checked against
 * the spec that asked for it. And it has to be targetable at all: shroud, protection and
 * the rest, which is CR 115.
 */
const checkTargets = (
  state: GameState,
  player: PlayerId,
  source: ObjectId,
  definition: CardDefinition,
  specs: readonly TargetSpec[],
  chosen: readonly EventTarget[],
): void => {
  const wanted = specs.reduce((total, spec) => total + (spec.count ?? 1), 0);
  const optional = specs.every((spec) => spec.upTo === true);

  if (chosen.length > wanted || (!optional && chosen.length !== wanted)) {
    throw new IllegalCastError(
      `${definition.name} takes ${wanted} target(s), but ${chosen.length} were chosen`,
    );
  }

  // The same binding resolution uses, so the target checked against a requirement is the
  // one the effects will be handed under that name.
  const context: EffectContext = { source, controller: player, targets: {}, x: 0 };
  const bound = bindTargets(specs, chosen);
  for (const spec of specs) {
    for (const target of bound[spec.id] ?? []) {
      if (!matchesFilter(state, context, spec.filter, target)) {
        throw new IllegalCastError(
          `illegal target for ${definition.name}: it is not what "${spec.id}" asks for`,
        );
      }
    }
  }

  const card = { controller: player, colours: definition.colours };
  for (const target of chosen) {
    const legality = canBeTargeted(state, target, card);
    if (!legality.legal) {
      throw new IllegalCastError(`illegal target for ${definition.name}: ${legality.reason}`);
    }
  }
};

/**
 * Pay a cost from the pool, tapping mana sources in object order to cover the shortfall.
 *
 * A source that offers a choice — a dual land — makes the mode that leaves the cost
 * payable from the pool and the sources still untapped, by the same exact search
 * `legalActions` asked before offering the spell (docs/09: an action offered is never
 * refused). Among modes that do, the one that pays most of the cost at once is taken.
 * Deterministic either way, so a replay pays identically.
 *
 * Mana is spent before life: a phyrexian symbol (CR 107.4f) takes 2 life only when the pool
 * and the lands cannot make its colour, and the life is lost as paying it (CR 119.4).
 */
const payFor = (
  state: GameState,
  emitter: EventEmitter,
  player: PlayerId,
  cost: ManaCost,
  x: number,
  autoTap: boolean,
): GameState => {
  let current = state;
  const life = state.players[player].life;
  const paid = (withLife: boolean) =>
    payCost(current.players[player].manaPool, cost, withLife ? { xValue: x, life } : { xValue: x });

  if (autoTap && paid(false) === null) {
    const sources = untappedSources(current, player);
    const manaOnly =
      !cost.symbols.some((symbol) => symbol.options.some((option) => option.kind === 'life')) ||
      canPayFromSources(
        current.players[player].manaPool,
        potentialManaFor(current, player, sources),
        cost,
        { xValue: x },
      );
    const withLife = manaOnly ? undefined : life;
    for (const [index, ability] of sources.entries()) {
      if (paid(!manaOnly) !== null) break;
      // Another of this permanent's abilities may have tapped it already.
      if (!canActivateManaAbility(current, player, ability)) continue;
      // Every ability that taps this permanent is one choice among them (CR 602.5a).
      const sameTap = (other: ManaAbility) =>
        ability.requiresTap && other.requiresTap && other.source === ability.source;
      const later = sources.slice(index + 1);
      const choices = [ability, ...later.filter(sameTap)];
      const rest = later.filter((other) => !sameTap(other));
      const attempt = tapForMana(current, emitter, player, choices, cost, x, rest, withLife);
      if (attempt === null) continue;
      current = attempt;
    }
  }

  const payment = paid(false) ?? paid(true);
  if (payment === null) {
    throw new IllegalCastError(`${player} cannot pay for this spell from their mana pool`);
  }

  current = updatePlayer(current, player, { manaPool: payment.remaining });
  if (payment.life > 0) {
    current = runEvent(current, emitter, { kind: 'loseLife', player, amount: payment.life });
  }
  return current;
};

const untappedSources = (state: GameState, player: PlayerId): readonly ManaAbility[] =>
  manaAbilitiesOf(state, player).filter((ability) => {
    const source = state.objects.get(ability.source);
    return source !== undefined && !(ability.requiresTap && source.tapped);
  });

/**
 * Activate a source, choosing the mode that gets closest to paying the cost.
 *
 * "Closest" rather than "pays it outright": a cost with two of the same pip — `{1}{B}{B}`
 * — is never completed by the first land tapped, so a rule that only accepted a mode
 * finishing the whole cost would take the first mode every time and never produce the
 * second black. What counts is progress: how many of the cost's symbols the pool could
 * still not cover.
 *
 * Which mode that is has to be worked out *before* anything is activated — a mode tried
 * and rejected would otherwise leave a tap in the event log that never happened, which
 * would be a lie in the replay.
 */
const tapForMana = (
  state: GameState,
  emitter: EventEmitter,
  player: PlayerId,
  choices: readonly ManaAbility[],
  cost: ManaCost,
  x: number,
  rest: readonly ManaAbility[],
  /** Life the payment may take, when mana alone cannot pay (phyrexian symbols). */
  life?: number,
): GameState | null => {
  const pool = state.players[player].manaPool;
  // Every mode of every ability that could tap the source: most of the cost paid first,
  // the printed order breaking a tie.
  const ranked = choices
    .flatMap((ability, order) =>
      ability.modes.map((mode, index) => ({
        ability,
        index,
        order,
        mode,
        shortfall: shortfall(poolWith(pool, mode), cost, x),
      })),
    )
    .sort((a, b) => a.shortfall - b.shortfall || a.order - b.order || a.index - b.index);
  let chosen = ranked[0];
  if (chosen === undefined) return null;
  if (ranked.length > 1) {
    // The first that leaves the cost payable by what is still untapped. Picking by
    // shortfall alone tapped a red-or-green land for red beside a Mountain, and the green
    // the spell needed was then nowhere.
    const potential = potentialManaFor(state, player, rest);
    const keeps = ranked.find((option) =>
      canPayFromSources(
        poolWith(pool, option.mode),
        potential,
        cost,
        life === undefined ? { xValue: x } : { xValue: x, life },
      ),
    );
    if (keeps !== undefined) chosen = keeps;
  }

  return activateManaAbility(state, emitter, player, chosen.ability, chosen.index);
};

/**
 * How many of a cost's symbols this pool still could not pay, counting the generic part
 * as one symbol per mana owed. Exact enough to choose between a dual land's two halves,
 * which is all it is for — `payCost` is still what decides whether the cost is paid.
 */
const shortfall = (pool: ManaPool, cost: ManaCost, x: number): number => {
  const available = [...pool];
  let unpaid = 0;

  // Coloured and hybrid symbols first: they are the constrained ones, and a unit spent on
  // generic mana that could have paid a pip is the mistake worth avoiding.
  for (const symbol of cost.symbols) {
    const index = available.findIndex(
      (unit) => payCost([unit], { generic: 0, variable: 0, symbols: [symbol] }) !== null,
    );
    if (index === -1) unpaid += 1;
    else available.splice(index, 1);
  }

  const generic = cost.generic + cost.variable * x;
  return unpaid + Math.max(0, generic - available.length);
};

/** The pool a mode would leave behind, for deciding whether to use it. */
const poolWith = (pool: ManaPool, produced: readonly ManaProduction[]): ManaPool => {
  let next = pool;
  for (const production of produced) {
    next = addMana(next, production.type, production.amount, {
      snow: production.snow ?? false,
      ...(production.restriction === undefined ? {} : { restriction: production.restriction }),
    });
  }
  return next;
};
