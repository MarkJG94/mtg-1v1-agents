import {
  allZoneIds,
  asObjectId,
  asOracleId,
  isHiddenZone,
  type ObjectId,
  type OracleId,
  type PlayerId,
  playerZone,
  type ZoneId,
} from '@mtg/shared';
import type { CardDefinition } from '../cards/definition.js';
import { emptyManaCost } from '../mana/cost.js';
import { createRng } from '../rng.js';
import type { GameState } from '../state/game-state.js';

/**
 * The same game with every card `viewer` cannot see swapped for a different one — a
 * fresh id, a different name, and a card definition nothing else in the game uses — a
 * different generator, and nothing they can see touched at all.
 *
 * This is the definition of information hiding made into a fixture: whatever is built
 * for `viewer` from a state must come out the same from this one. The view's test uses
 * it (roadmap 4.1), and so does the determiniser's (ADR 0012). A list of fields to check
 * catches only the leaks somebody thought of; this catches an id, a name, a definition,
 * or something added next year, because all of them differ here.
 */
export const withTheUnseenReplaced = (state: GameState, viewer: PlayerId): GameState => {
  const hidden = allZoneIds.filter(
    (zone: ZoneId) => isHiddenZone(zone) && zone !== playerZone(viewer, 'hand'),
  );

  let objects = state.objects;
  const zones = { ...state.zones };
  const definitions = new Map<OracleId, CardDefinition>(state.definitions);
  let next = state.nextObjectId;

  for (const zone of hidden) {
    const fresh: ObjectId[] = [];
    for (const id of state.zones[zone]) {
      const object = objects.get(id);
      if (object === undefined) continue;
      objects = objects.without(id);
      next += 1;
      const renumbered = asObjectId(next);
      const oracleId = asOracleId(`unseen-${next}`);
      definitions.set(oracleId, {
        oracleId,
        name: `unseen-${next}`,
        manaCost: emptyManaCost,
        types: ['creature'],
        colours: [],
        power: next,
        toughness: next,
        abilities: [],
      });
      objects = objects.withObject(renumbered, {
        ...object,
        id: renumbered,
        definitionId: oracleId,
        name: `unseen-${next}`,
      });
      fresh.push(renumbered);
    }
    zones[zone] = fresh;
  }

  return {
    ...state,
    objects,
    zones,
    definitions,
    nextObjectId: next + 1,
    version: state.version + 1,
    // The generator is hidden too — it decides every future shuffle and draw — and so are
    // the loop detector's hashes, which were taken of whole positions, hidden cards and all.
    rng: createRng(`unseen:${state.rng.join(',')}`).save(),
    statesThisTurn: [...state.statesThisTurn, 0x5eed],
  };
};
