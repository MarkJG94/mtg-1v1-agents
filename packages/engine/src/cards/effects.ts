import {
  type CounterKind,
  type EventTarget,
  type ObjectId,
  type PlayerId,
  playerZone,
  type ZoneId,
} from '@mtg/shared';
import { addEffect, characteristicsOf, keywordsOfObject } from '../characteristics.js';
import type { EventEmitter } from '../events/emitter.js';
import { runBatch, runEvent } from '../events/perform.js';
import type { RulesEvent } from '../events/rules-event.js';
import { playerLosesGame, playerWinsGame } from '../game-end.js';
import type { EffectDuration } from '../layers.js';
import { addMana as addManaToPool } from '../mana/pool.js';
import { addReplacement } from '../replacement.js';
import { rngFromState } from '../rng.js';
import { counterObject } from '../stack.js';
import type { GameState } from '../state/game-state.js';
import { withCounters } from '../state/object.js';
import {
  createObject,
  objectsIn,
  setZone,
  updateObject,
  updatePlayer,
  updateState,
} from '../state/update.js';
import { keywords as keywordSet } from '../targeting.js';
import { addDelayedTrigger } from '../triggers.js';
import { abilityById } from './definition.js';
import {
  definitionFor,
  type EffectContext,
  evaluateQuantity,
  holds,
  objectsMatching,
  resolveObjects,
  resolvePlayers,
  resolveTargets,
} from './evaluate.js';
import type { Destination, EffectOp, OpDuration, TokenSpec } from './ops.js';

/**
 * The effect ops, implemented once each (docs/03 "Effect ops").
 *
 * Every op that changes the game builds `RulesEvent`s and hands them to `runBatch`, so a
 * replacement effect sees them before they happen (ADR 0004). That is why a card that
 * says "deals 3 damage" works with a prevention shield, a redirection and a doubler
 * without knowing any of them exist. Ops whose subject has left simply do nothing, which
 * is what the rules say about a spell that no longer has anything to act on.
 *
 * Damage inside one op is dealt as one batch, so a fight kills both creatures rather than
 * letting the first one die before it hits back (CR 510.2).
 */

export class EffectsPausedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EffectsPausedError';
  }
}

/**
 * Run a list of ops in order.
 *
 * One limit, and it is loud rather than silent: if an op's events stop mid-flight because
 * a player must choose between two applicable replacement effects (CR 616.1), the ops
 * after it cannot run, because there is nowhere yet to put the rest of the list while the
 * game waits. It throws instead of dropping them. Making the effect list resumable is the
 * same piece of work as the ops that need a choice of their own — search, scry, "you may"
 * — and lands with them; see the roadmap note for 2.1.
 */
export const applyEffects = (
  state: GameState,
  emitter: EventEmitter,
  context: EffectContext,
  effects: readonly EffectOp[],
): GameState => {
  let current = state;
  for (const [index, effect] of effects.entries()) {
    if (current.pendingReplacement !== null && index > 0) {
      throw new EffectsPausedError(
        `effect ${index} of this ability cannot run: the one before it is waiting on a ` +
          'replacement choice, and resumable effects are not built yet',
      );
    }
    if (current.result !== null) return current;
    current = applyOp(current, emitter, context, effect);
  }
  return current;
};

const applyOp = (
  state: GameState,
  emitter: EventEmitter,
  context: EffectContext,
  effect: EffectOp,
): GameState => {
  const amountOf = (quantity: Parameters<typeof evaluateQuantity>[2]): number =>
    Math.max(0, Math.trunc(evaluateQuantity(state, context, quantity)));

  switch (effect.op) {
    // --- Damage and life ---

    case 'damage': {
      const from = effect.from ?? { kind: 'source' as const };
      const source = resolveObjects(state, context, from)[0] ?? context.source;
      const amount = amountOf(effect.amount);
      const targets = resolveTargets(state, context, effect.to);
      if (amount <= 0 || targets.length === 0) return state;
      return runBatch(
        state,
        emitter,
        { kind: 'plain' },
        targets.map((target) => damageEvent(state, context, source, target, amount)),
      );
    }

    case 'gainLife':
    case 'loseLife': {
      const amount = amountOf(effect.amount);
      if (amount <= 0) return state;
      return runBatch(
        state,
        emitter,
        { kind: 'plain' },
        resolvePlayers(state, context, effect.player).map((player) => ({
          kind: effect.op,
          player,
          amount,
        })),
      );
    }

    case 'poison': {
      const amount = amountOf(effect.amount);
      if (amount <= 0) return state;
      return runBatch(
        state,
        emitter,
        { kind: 'plain' },
        resolvePlayers(state, context, effect.player).map((player) => ({
          kind: 'poison' as const,
          player,
          amount,
        })),
      );
    }

    /** CR 701.13: each deals damage equal to its power to the other, at the same time. */
    case 'fight': {
      const first = resolveObjects(state, context, effect.first)[0];
      const second = resolveObjects(state, context, effect.second)[0];
      if (first === undefined || second === undefined) return state;

      const events: RulesEvent[] = [];
      for (const [dealer, receiver] of [
        [first, second],
        [second, first],
      ] as const) {
        const power = characteristicsOf(state, dealer).power ?? 0;
        if (power > 0) {
          events.push(
            damageEvent(state, context, dealer, { kind: 'object', object: receiver }, power),
          );
        }
      }
      return events.length === 0 ? state : runBatch(state, emitter, { kind: 'plain' }, events);
    }

    // --- Cards and zones ---

    case 'draw': {
      const count = amountOf(effect.count);
      const events: RulesEvent[] = [];
      for (const player of resolvePlayers(state, context, effect.player)) {
        for (let i = 0; i < count; i += 1) events.push({ kind: 'draw', player });
      }
      return events.length === 0 ? state : runBatch(state, emitter, { kind: 'plain' }, events);
    }

    case 'mill': {
      const count = amountOf(effect.count);
      const events: RulesEvent[] = [];
      for (const player of resolvePlayers(state, context, effect.player)) {
        const library = playerZone(player, 'library');
        for (const object of objectsIn(state, library).slice(0, count)) {
          events.push({
            kind: 'moveZone',
            object,
            from: library,
            to: playerZone(player, 'graveyard'),
            cause: 'effect',
            destruction: false,
          });
        }
      }
      return events.length === 0 ? state : runBatch(state, emitter, { kind: 'plain' }, events);
    }

    /**
     * At random, so nobody has to be asked (CR 701.9c). A discard the player chooses is
     * one of the ops that waits for resumable effects.
     */
    case 'discardAtRandom': {
      const count = amountOf(effect.count);
      if (count <= 0) return state;

      const rng = rngFromState(state.rng);
      const events: RulesEvent[] = [];
      for (const player of resolvePlayers(state, context, effect.player)) {
        const hand = playerZone(player, 'hand');
        for (const object of rng.shuffled(objectsIn(state, hand)).slice(0, count)) {
          events.push({
            kind: 'moveZone',
            object,
            from: hand,
            to: playerZone(player, 'graveyard'),
            cause: 'discard',
            destruction: false,
          });
        }
      }
      const drawn = updateState(state, { rng: rng.save() });
      return events.length === 0 ? drawn : runBatch(drawn, emitter, { kind: 'plain' }, events);
    }

    case 'destroy':
      return moveObjects(
        state,
        emitter,
        context,
        effect.object,
        { kind: 'graveyard' },
        {
          cause: 'destroy',
          destruction: true,
        },
      );

    case 'exile':
      return moveObjects(
        state,
        emitter,
        context,
        effect.object,
        { kind: 'exile' },
        {
          cause: 'effect',
          destruction: false,
        },
      );

    case 'bounce':
      return moveObjects(
        state,
        emitter,
        context,
        effect.object,
        { kind: 'hand' },
        {
          cause: 'effect',
          destruction: false,
        },
      );

    case 'sacrifice':
      return moveObjects(
        state,
        emitter,
        context,
        effect.object,
        { kind: 'graveyard' },
        {
          cause: 'sacrifice',
          destruction: false,
        },
      );

    case 'moveZone':
      return moveObjects(state, emitter, context, effect.object, effect.to, {
        cause: 'effect',
        destruction: false,
      });

    case 'shuffle': {
      let current = state;
      for (const player of resolvePlayers(state, context, effect.player)) {
        const zone = playerZone(player, 'library');
        const rng = rngFromState(current.rng);
        const shuffled = rng.shuffled(objectsIn(current, zone));
        current = updateState(setZone(current, zone, shuffled), { rng: rng.save() });
      }
      return current;
    }

    case 'createToken': {
      const count = effect.count === undefined ? 1 : amountOf(effect.count);
      let current = state;
      for (const player of resolvePlayers(state, context, effect.controller)) {
        for (let i = 0; i < count; i += 1) {
          current = createToken(current, emitter, context, player, effect.token);
        }
      }
      return current;
    }

    // --- Permanents ---

    case 'tap':
    case 'untap': {
      let current = state;
      for (const object of resolveObjects(state, context, effect.object)) {
        current = updateObject(current, object, { tapped: effect.op === 'tap' });
      }
      return current;
    }

    case 'addCounters': {
      const amount = amountOf(effect.amount);
      if (amount <= 0) return state;
      return runBatch(
        state,
        emitter,
        { kind: 'plain' },
        resolveObjects(state, context, effect.object).map((object) => ({
          kind: 'addCounters' as const,
          object,
          counter: effect.counter as CounterKind,
          amount,
        })),
      );
    }

    /** Removing counters is not something a replacement effect watches for, so it is direct. */
    case 'removeCounters': {
      const amount = amountOf(effect.amount);
      let current = state;
      for (const id of resolveObjects(state, context, effect.object)) {
        const object = current.objects.get(id);
        if (object === undefined) continue;
        const left = Math.max(0, (object.counters[effect.counter] ?? 0) - amount);
        const { counters } = withCounters(object, effect.counter, left);
        current = updateObject(current, id, { counters });
      }
      return current;
    }

    case 'attach': {
      const attachment = resolveObjects(state, context, effect.attachment)[0];
      const to = resolveObjects(state, context, effect.to)[0];
      if (attachment === undefined || to === undefined) return state;
      return attachTo(state, attachment, to);
    }

    // --- Continuous effects ---

    case 'pump':
      return withEffectOnEach(state, context, effect.object, effect.duration, {
        kind: 'modifyPowerToughness',
        power: evaluateQuantity(state, context, effect.power),
        toughness: evaluateQuantity(state, context, effect.toughness),
      });

    case 'setPowerToughness':
      return withEffectOnEach(state, context, effect.object, effect.duration, {
        kind: 'setPowerToughness',
        power: amountOf(effect.power),
        toughness: amountOf(effect.toughness),
      });

    case 'switchPowerToughness':
      return withEffectOnEach(state, context, effect.object, effect.duration, {
        kind: 'switchPowerToughness',
      });

    case 'grantKeyword':
      return withEffectOnEach(state, context, effect.object, effect.duration, {
        kind: 'addKeyword',
        keyword: effect.keyword,
      });

    case 'removeAbilities':
      return withEffectOnEach(state, context, effect.object, effect.duration, {
        kind: 'removeAllAbilities',
      });

    case 'becomesCreature':
      return withEffectOnEach(state, context, effect.object, effect.duration, {
        kind: 'becomesCreature',
        power: amountOf(effect.power),
        toughness: amountOf(effect.toughness),
      });

    case 'setColours':
      return withEffectOnEach(state, context, effect.object, effect.duration, {
        kind: 'setColours',
        colours: effect.colours,
      });

    case 'gainControl': {
      const player = resolvePlayers(state, context, effect.player)[0];
      if (player === undefined) return state;
      return withEffectOnEach(state, context, effect.object, effect.duration ?? 'permanent', {
        kind: 'changeControl',
        controller: player,
      });
    }

    // --- Replacement and prevention ---

    case 'preventDamage': {
      const amount = effect.amount === 'all' ? ('all' as const) : amountOf(effect.amount);
      let current = state;
      for (const target of resolveTargets(state, context, effect.to)) {
        current = addReplacement(current, {
          source: context.source,
          controller: context.controller,
          applies:
            target.kind === 'player'
              ? { kind: 'damageToPlayer', player: target.player }
              : { kind: 'damageToObject', object: target.object },
          change: { kind: 'preventDamage', amount },
          duration: durationOf(effect.duration ?? 'untilEndOfTurn'),
        }).state;
      }
      return current;
    }

    /** CR 701.15: a shield over destruction specifically, good for one use. */
    case 'regenerate': {
      let current = state;
      for (const object of resolveObjects(state, context, effect.object)) {
        current = addReplacement(current, {
          source: context.source,
          controller: context.controller,
          applies: {
            kind: 'movesToZone',
            object,
            to: playerZone(ownerOf(current, object), 'graveyard'),
            destructionOnly: true,
          },
          change: { kind: 'regenerate' },
          duration: { kind: 'untilEndOfTurn' },
          uses: 1,
        }).state;
      }
      return current;
    }

    // --- The stack and the turn ---

    case 'counter': {
      let current = state;
      for (const object of resolveObjects(state, context, effect.object)) {
        if (current.objects.get(object)?.zone !== 'stack') continue;
        current = counterObject(current, emitter, object, context.source);
      }
      return current;
    }

    case 'addMana': {
      let current = state;
      for (const player of resolvePlayers(state, context, effect.player)) {
        for (const production of effect.produce) {
          current = updatePlayer(current, player, {
            manaPool: addManaToPool(
              current.players[player].manaPool,
              production.type,
              production.amount,
              {
                ...(production.snow !== undefined ? { snow: production.snow } : {}),
                ...(production.restriction !== undefined
                  ? { restriction: production.restriction }
                  : {}),
              },
            ),
          });
        }
      }
      return current;
    }

    /** CR 500.7. Inlined rather than calling the turn module, which would be a cycle. */
    case 'extraTurn': {
      const owed = resolvePlayers(state, context, effect.player);
      return owed.length === 0
        ? state
        : updateState(state, { extraTurns: [...state.extraTurns, ...owed] });
    }

    case 'winGame': {
      let current = state;
      for (const player of resolvePlayers(state, context, effect.player)) {
        current = playerWinsGame(current, emitter, player);
      }
      return current;
    }

    case 'loseGame': {
      let current = state;
      for (const player of resolvePlayers(state, context, effect.player)) {
        current = playerLosesGame(current, emitter, player);
      }
      return current;
    }

    case 'delayedTrigger': {
      const definition = definitionFor(state, context.source);
      const ability =
        definition === undefined ? undefined : abilityById(definition, effect.ability);
      if (ability === undefined || ability.kind !== 'triggered') return state;
      return addDelayedTrigger(state, {
        abilityId: ability.id,
        source: context.source,
        controller: context.controller,
        when: ability.when,
        once: effect.once ?? true,
      });
    }

    // --- Control flow ---

    case 'sequence':
      return applyEffects(state, emitter, context, effect.effects);

    case 'forEach': {
      let current = state;
      for (const object of objectsMatching(state, context, effect.of)) {
        current = applyEffects(current, emitter, { ...context, each: object }, effect.effects);
      }
      return current;
    }

    case 'if':
      return holds(state, context, effect.condition)
        ? applyEffects(state, emitter, context, effect.then)
        : applyEffects(state, emitter, context, effect.otherwise ?? []);
  }
};

// --- Helpers ---

const ownerOf = (state: GameState, object: ObjectId): PlayerId =>
  state.objects.get(object)?.owner ?? 'A';

/**
 * Damage carries the keywords of whatever is dealing it, which is how a source with
 * deathtouch or lifelink behaves the same whether it is attacking or being pointed.
 */
const damageEvent = (
  state: GameState,
  context: EffectContext,
  source: ObjectId,
  target: EventTarget,
  amount: number,
): RulesEvent => {
  const traits = state.objects.has(source) ? keywordsOfObject(state, source) : keywordSet();
  return {
    kind: 'damage',
    source,
    controller: context.controller,
    target,
    amount,
    combat: false,
    deathtouch: traits.deathtouch,
    lifelink: traits.lifelink,
  };
};

const zoneOfDestination = (
  state: GameState,
  object: ObjectId,
  destination: Destination,
): ZoneId => {
  const owner = ownerOf(state, object);
  switch (destination.kind) {
    case 'graveyard':
      return playerZone(owner, 'graveyard');
    case 'hand':
      return playerZone(owner, 'hand');
    case 'exile':
      return 'exile';
    case 'battlefield':
      return 'battlefield';
    case 'libraryTop':
    case 'libraryBottom':
      return playerZone(owner, 'library');
  }
};

const moveObjects = (
  state: GameState,
  emitter: EventEmitter,
  context: EffectContext,
  selector: Parameters<typeof resolveObjects>[2],
  destination: Destination,
  how: { readonly cause: 'destroy' | 'sacrifice' | 'effect'; readonly destruction: boolean },
): GameState => {
  const events: RulesEvent[] = [];
  for (const object of resolveObjects(state, context, selector)) {
    const from = state.objects.get(object)?.zone;
    if (from === undefined) continue;
    const to = zoneOfDestination(state, object, destination);
    if (from === to) continue;

    if (to === 'battlefield') {
      events.push({
        kind: 'entersBattlefield',
        object,
        from,
        tapped: destination.kind === 'battlefield' && destination.tapped === true,
        counters: {},
      });
      continue;
    }
    events.push({
      kind: 'moveZone',
      object,
      from,
      to,
      cause: how.cause,
      destruction: how.destruction,
    });
  }
  return events.length === 0 ? state : runBatch(state, emitter, { kind: 'plain' }, events);
};

const durationOf = (duration: OpDuration): EffectDuration => {
  switch (duration) {
    case 'untilEndOfTurn':
      return { kind: 'untilEndOfTurn' };
    case 'permanent':
      return { kind: 'permanent' };
    case 'whileSourceOnBattlefield':
      return { kind: 'whileSourceOnBattlefield' };
  }
};

/** One continuous effect per object the selector names (CR 613). */
const withEffectOnEach = (
  state: GameState,
  context: EffectContext,
  selector: Parameters<typeof resolveObjects>[2],
  duration: OpDuration | undefined,
  change: Parameters<typeof addEffect>[1]['change'],
): GameState => {
  let current = state;
  for (const object of resolveObjects(state, context, selector)) {
    current = addEffect(current, {
      source: context.source,
      affects: { kind: 'object', object },
      change,
      duration: durationOf(duration ?? 'untilEndOfTurn'),
    }).state;
  }
  return current;
};

const attachTo = (state: GameState, attachment: ObjectId, to: ObjectId): GameState => {
  const previous = state.objects.get(attachment)?.attachedTo ?? null;
  let current = state;
  if (previous !== null && current.objects.has(previous)) {
    const host = current.objects.get(previous);
    if (host !== undefined) {
      current = updateObject(current, previous, {
        attachments: host.attachments.filter((each) => each !== attachment),
      });
    }
  }
  const host = current.objects.get(to);
  if (host === undefined) return current;
  return updateObject(updateObject(current, attachment, { attachedTo: to }), to, {
    attachments: [...host.attachments, attachment],
  });
};

/**
 * A token is a card that was never printed: it has no definition to read, so everything
 * it is comes from the spec, and it ceases to exist if it ever leaves the battlefield
 * (CR 111.7), which the state-based actions already handle.
 */
const createToken = (
  state: GameState,
  emitter: EventEmitter,
  context: EffectContext,
  controller: PlayerId,
  token: TokenSpec,
): GameState => {
  // A token has no card of its own, so it borrows its maker's oracle id as a label and
  // takes every characteristic from the spec. `createObject` fills nothing in from a
  // definition here, because everything it would fill is stated below.
  const maker = state.objects.get(context.source);
  if (maker === undefined) return state;
  const created = createObject(state, {
    definitionId: maker.definitionId,
    owner: controller,
    controller,
    zone: 'battlefield',
    token: true,
    name: token.name,
    colours: token.colours ?? [],
    keywords: keywordSet(Object.fromEntries((token.keywords ?? []).map((each) => [each, true]))),
    ...(token.power !== undefined ? { power: token.power } : {}),
    ...(token.toughness !== undefined ? { toughness: token.toughness } : {}),
  });

  return runEvent(created.state, emitter, {
    kind: 'entersBattlefield',
    object: created.object.id,
    from: 'battlefield',
    tapped: false,
    counters: {},
  });
};
