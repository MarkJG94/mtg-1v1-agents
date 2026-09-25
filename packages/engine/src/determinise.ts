import {
  allZoneIds,
  asOracleId,
  isHiddenZone,
  type ObjectId,
  type OracleId,
  opponentOf,
  type PlayerId,
  playerZone,
  type ZoneId,
} from '@mtg/shared';
import type { CardDefinition } from './cards/definition.js';
import { nullEventEmitter } from './events/emitter.js';
import type { Rng } from './rng.js';
import type { GameState } from './state/game-state.js';
import type { GameObject } from './state/object.js';
import { ObjectStore } from './state/object-store.js';
import { createObject } from './state/update.js';
import { applyDecision } from './turn/turn.js';
import { canSee, viewFor } from './view/project.js';
import type { Simulator, World, WorldStatus } from './view/simulator.js';

/**
 * Determinisation (roadmap 4.3, ADR 0012): the game as one player knows it, with
 * everything they cannot see filled in by a sample.
 *
 * The search has to run the rules forward, and the rules need a whole `GameState` —
 * spell targets, "until end of turn" effects, timestamps, delayed triggers — far more
 * than a view carries. So rather than rebuilding a state from the view, which would lose
 * all of that, this starts from the true state and **replaces what is hidden**:
 *
 * - every card in a zone the viewer cannot see is removed, and the zone refilled with the
 *   same number of cards, numbered afresh from above every id the viewer can see;
 * - the opponent's hand is drawn, with replacement, from cards the viewer has seen the
 *   opponent own in public zones — what they have shown is the best guess at what they
 *   hold — or is made of unknown cards if nothing has been shown;
 * - libraries, the viewer's own included (CR 401.2), are unknown cards;
 * - definitions are cut down to the cards the viewer can see, so the world cannot say
 *   what else is in either deck;
 * - the generator is the sampler's, so the world's future shuffles are not the game's;
 * - the loop detector's position hashes, which were taken of the whole truth, are dropped.
 *
 * An unknown card has an oracle id with no definition behind it, which the engine already
 * treats as a card it cannot cast or play (docs/03: no script, not playable).
 *
 * The guarantee is the view's, one level down: **two states that differ only in what the
 * viewer cannot see give the same world from the same generator.** `determinise.test.ts`
 * holds it with the same renumber-and-rename variant the view's test uses, so a leak
 * nobody thought to look for still fails it.
 */

/** A card whose identity the viewer does not know. Deliberately has no definition. */
export const unknownCard: OracleId = asOracleId('unknown-card');

export const determinise = (state: GameState, viewer: PlayerId, rng: Rng): GameState => {
  const them = opponentOf(viewer);
  const hidden = allZoneIds.filter(
    (zone) => isHiddenZone(zone) && zone !== playerZone(viewer, 'hand'),
  );

  // What survives: every object the viewer can see, exactly as it is.
  const visible: [ObjectId, GameObject][] = [];
  let highest = 0;
  for (const [id, object] of state.objects) {
    if (!canSee(viewer, object)) continue;
    visible.push([id, object]);
    highest = Math.max(highest, id);
  }

  const definitions = new Map<OracleId, CardDefinition>();
  for (const [, object] of visible) {
    const definition = state.definitions.get(object.definitionId);
    if (definition !== undefined) definitions.set(object.definitionId, definition);
  }

  // What the opponent has shown: their own non-token cards in zones both players see, in
  // id order so the sample does not depend on how the engine happened to store them.
  const shown = visible
    .filter(([, object]) => object.owner === them && !object.token)
    .map(([, object]) => object.definitionId);

  const zones = { ...state.zones } as Record<ZoneId, readonly ObjectId[]>;
  for (const zone of hidden) zones[zone] = [];

  let world: GameState = {
    ...state,
    version: 0,
    rng: rng.fork('world').save(),
    objects: ObjectStore.from(visible),
    zones,
    definitions,
    nextObjectId: highest + 1,
    statesThisTurn: [],
  };

  for (const zone of hidden) {
    const owner: PlayerId = zone.startsWith(`${viewer}:`) ? viewer : them;
    const guessable = zone === playerZone(them, 'hand') && shown.length > 0;
    for (let i = 0; i < state.zones[zone].length; i += 1) {
      const definitionId = guessable ? rng.pick(shown) : unknownCard;
      world = createObject(world, { definitionId, owner, zone }).state;
    }
  }

  return world;
};

/**
 * The simulator handed to a searching agent with each decision (ADR 0012). It holds the
 * true state only to determinise it; nothing it returns can be read for more than the
 * viewer already knows.
 */
export const simulatorFor = (state: GameState, viewer: PlayerId): Simulator => {
  const emitter = nullEventEmitter();
  const asState = (world: World): GameState => world as unknown as GameState;
  const asWorld = (game: GameState): World => game as unknown as World;

  return {
    viewer,
    sample: (rng) => asWorld(determinise(state, viewer, rng)),
    decision: (world) => {
      const game = asState(world);
      return game.result === null ? game.pendingDecision : null;
    },
    apply: (world, response) => asWorld(applyDecision(asState(world), emitter, response)),
    view: (world, player) => viewFor(asState(world), player),
    status: (world): WorldStatus => {
      const game = asState(world);
      const stack = game.zones.stack;
      const top = stack[stack.length - 1];
      return {
        turn: game.turn,
        step: game.step,
        activePlayer: game.activePlayer,
        stackSize: stack.length,
        topOfStack: top === undefined ? null : (game.objects.get(top)?.controller ?? null),
        result: game.result,
      };
    },
  };
};
