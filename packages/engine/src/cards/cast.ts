import {
  type EventTarget,
  isMainPhase,
  type ObjectId,
  type PlayerId,
  playerZone,
} from '@mtg/shared';
import type { EventEmitter } from '../events/emitter.js';
import { runEvent } from '../events/perform.js';
import { activateManaAbility, type ManaAbility, type ManaProduction } from '../mana/ability.js';
import type { ManaCost } from '../mana/cost.js';
import { payCost } from '../mana/payment.js';
import { addMana, type ManaPool } from '../mana/pool.js';
import { isStackEmpty, putActivatedAbilityOnStack, putOnStack } from '../stack.js';
import type { GameState } from '../state/game-state.js';
import { getObject, updateObject, updatePlayer } from '../state/update.js';
import { canBeTargeted } from '../targeting.js';
import {
  type ActivatedAbilityDef,
  type CardDefinition,
  hasType,
  isPermanentCard,
  isSorcerySpeed,
  spellAbilityOf,
  type TargetSpec,
} from './definition.js';
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
  checkTargets(state, player, definition, spellAbilityOf(definition)?.targets ?? [], targets);

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
  checkTargets(state, player, definition, ability.targets ?? [], targets);

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
 */
const checkTargets = (
  state: GameState,
  player: PlayerId,
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

  const source = { controller: player, colours: definition.colours };
  for (const target of chosen) {
    const legality = canBeTargeted(state, target, source);
    if (!legality.legal) {
      throw new IllegalCastError(`illegal target for ${definition.name}: ${legality.reason}`);
    }
  }
};

/**
 * Pay a cost from the pool, tapping mana sources in object order to cover the shortfall.
 *
 * Each source is only tapped if it brings the cost closer to payable, and the modes of a
 * source that offers a choice — a dual land — are tried in order, taking the first that
 * lets the whole cost be paid. Deterministic either way, so a replay pays identically.
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

  if (autoTap && payCost(current.players[player].manaPool, cost, { xValue: x }) === null) {
    for (const ability of untappedSources(current, player)) {
      const attempt = tapForMana(current, emitter, player, ability, cost, x);
      if (attempt === null) continue;
      current = attempt;
      if (payCost(current.players[player].manaPool, cost, { xValue: x }) !== null) break;
    }
  }

  const payment = payCost(current.players[player].manaPool, cost, { xValue: x });
  if (payment === null) {
    throw new IllegalCastError(`${player} cannot pay for this spell from their mana pool`);
  }

  return updatePlayer(current, player, { manaPool: payment.remaining });
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
  ability: ManaAbility,
  cost: ManaCost,
  x: number,
): GameState | null => {
  if (ability.modes.length === 0) return null;

  const pool = state.players[player].manaPool;
  let best = 0;
  let bestShortfall = Number.POSITIVE_INFINITY;

  for (const [index, mode] of ability.modes.entries()) {
    const remaining = shortfall(poolWith(pool, mode), cost, x);
    if (remaining < bestShortfall) {
      best = index;
      bestShortfall = remaining;
    }
  }

  return activateManaAbility(state, emitter, player, ability, best);
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
