import {
  allZoneIds,
  isHiddenZone,
  kindOfZone,
  type ObjectId,
  opponentOf,
  ownerOfZone,
  type PlayerId,
  playerZone,
  type ZoneId,
} from '@mtg/shared';
import type { CardDefinition } from '../cards/definition.js';
import { characteristicsOf } from '../characteristics.js';
import type { CombatState } from '../combat.js';
import { costColours, manaValue } from '../mana/cost.js';
import { type ManaType, manaPoolCounts } from '../mana/pool.js';
import type { GameState } from '../state/game-state.js';
import type { GameObject } from '../state/object.js';
import type {
  CombatView,
  OpponentSideView,
  OwnSideView,
  PlayerView,
  VisibleObject,
} from './player-view.js';

/**
 * Building a `PlayerView` from the whole truth (docs/04).
 *
 * This is the only place in the system that decides what one player knows, which is the
 * point of having it: the rule lives once, in a function with tests, rather than in every
 * agent that happens to remember it.
 *
 * The rule itself is the engine's own, not a second opinion. A zone is hidden when
 * `isHiddenZone` says so (CR 400.2), so a hidden zone added later is hidden here without
 * anyone remembering to come back — and the one place that reads through a hidden zone,
 * the viewer's own hand, says exactly why.
 */

export const viewFor = (state: GameState, viewer: PlayerId): PlayerView => {
  const them = opponentOf(viewer);
  const objects = new Map<ObjectId, VisibleObject>();

  // Zone by zone rather than object by object: whether a zone can be seen is one question,
  // where asking it of every card in both libraries was most of what a view cost the
  // search (4.8). Every object is in exactly one zone (the fuzzer asserts it), and sorting
  // by id keeps the order the object table has.
  const ids: ObjectId[] = [];
  for (const zone of allZoneIds) {
    if (canSeeZone(viewer, zone)) for (const id of state.zones[zone]) ids.push(id);
  }
  ids.sort((a, b) => a - b);
  for (const id of ids) {
    const object = state.objects.get(id);
    if (object !== undefined) objects.set(id, visible(state, object));
  }

  return {
    viewer,
    turn: state.turn,
    step: state.step,
    activePlayer: state.activePlayer,
    priority: state.priority,
    you: ownSide(state, viewer),
    opponent: side(state, them),
    objects,
    battlefield: [...state.zones.battlefield],
    stack: [...state.zones.stack],
    exile: [...state.zones.exile],
    combat: state.combat === null ? null : combatView(state.combat),
    result: state.result,
  };
};

/**
 * Whether this player knows what a given object is.
 *
 * A card in a public zone is public to both (CR 400.2). A card in a hidden zone is known
 * only to whoever owns that zone — and a library is known to nobody, because its order is
 * the thing being hidden and knowing the contents is most of knowing the order
 * (CR 401.2). That last part is why this asks the zone's *kind* rather than only who owns
 * it: a player may look through their own hand, never their own library.
 */
export const canSee = (viewer: PlayerId, object: GameObject): boolean =>
  canSeeZone(viewer, object.zone);

/** Whether this player knows what the cards in a zone are; see `canSee`. */
export const canSeeZone = (viewer: PlayerId, zone: ZoneId): boolean => {
  if (!isHiddenZone(zone)) return true;
  if (kindOfZone(zone) === 'library') return false;
  return ownerOfZone(zone) === viewer;
};

const visible = (state: GameState, object: GameObject): VisibleObject => {
  const traits = characteristicsOf(state, object.id);
  const definition = state.definitions.get(object.definitionId);
  const facts = definition === undefined ? unknownFacts : printedFacts(definition);

  return {
    id: object.id,
    oracleId: object.definitionId,
    zone: object.zone,
    owner: object.owner,
    controller: traits.controller,

    name: traits.name,
    isCreature: traits.isCreature,
    power: traits.power,
    toughness: traits.toughness,
    colours: [...traits.colours],
    keywords: traits.keywords,
    legendary: traits.legendary,

    types: facts.types,
    manaValue: facts.manaValue,
    costColours: facts.costColours,
    producesMana: facts.producesMana,

    tapped: object.tapped,
    damage: object.damage,
    counters: { ...object.counters },
    // Loyalty lives in counters once the permanent is out (CR 306.5b); the printed value
    // on the object only says that it is a planeswalker at all.
    loyalty: object.loyalty === null ? null : (object.counters.loyalty ?? 0),
    summoningSick: object.summoningSick,
    token: object.token,
    attachedTo: object.attachedTo,
    attachments: [...object.attachments],
  };
};

/** What a view says about a card that comes from its definition alone. */
type PrintedFacts = Pick<VisibleObject, 'types' | 'manaValue' | 'costColours' | 'producesMana'>;

const unknownFacts: PrintedFacts = Object.freeze({
  types: Object.freeze([]),
  manaValue: 0,
  costColours: Object.freeze([]),
  producesMana: Object.freeze([]),
});

/**
 * Worked out once per definition rather than once per object per view: a definition never
 * changes, and the search makes a view at every position it scores, which made these
 * several per cent of a searched game (4.8). Frozen, because every view shares them.
 */
const printed = new WeakMap<CardDefinition, PrintedFacts>();

const printedFacts = (definition: CardDefinition): PrintedFacts => {
  let facts = printed.get(definition);
  if (facts === undefined) {
    facts = Object.freeze({
      types: Object.freeze([...definition.types]),
      manaValue: manaValue(definition.manaCost),
      costColours: Object.freeze([...costColours(definition.manaCost)]),
      producesMana: Object.freeze(manaTypesOf(definition)),
    });
    printed.set(definition, facts);
  }
  return facts;
};

/**
 * The mana types a card's own abilities could make, without saying how many or in what
 * combination. Enough for "can I cast this", which is what an evaluator asks; the exact
 * question is `canPayFromSources`, and that needs a state.
 */
const manaTypesOf = (definition: CardDefinition): readonly ManaType[] => {
  const types = new Set<ManaType>();
  for (const ability of definition.abilities) {
    if (ability.kind !== 'mana') continue;
    for (const mode of ability.modes) for (const produced of mode) types.add(produced.type);
  }
  return [...types];
};

const side = (state: GameState, player: PlayerId): OpponentSideView => {
  const it = state.players[player];
  return {
    player,
    life: it.life,
    poison: it.poison,
    handSize: state.zones[playerZone(player, 'hand')].length,
    librarySize: state.zones[playerZone(player, 'library')].length,
    graveyard: [...state.zones[playerZone(player, 'graveyard')]],
    battlefield: state.zones.battlefield.filter(
      (id) => characteristicsOf(state, id).controller === player,
    ),
    landsPlayedThisTurn: it.landsPlayedThisTurn,
    maxLandsPerTurn: it.maxLandsPerTurn,
    manaPool: manaPoolCounts(it.manaPool),
  };
};

const ownSide = (state: GameState, player: PlayerId): OwnSideView => ({
  ...side(state, player),
  hand: [...state.zones[playerZone(player, 'hand')]],
});

const combatView = (combat: CombatState): CombatView => ({
  attackers: combat.attackers.map((attacker) => ({
    attacker: attacker.attacker,
    defendingPlayer: attacker.defender.kind === 'player' ? attacker.defender.player : null,
    defendingPlaneswalker: attacker.defender.kind === 'object' ? attacker.defender.object : null,
    blockedBy: [...attacker.blockedBy],
    blocked: attacker.blocked,
  })),
  firstStrikeDone: combat.firstStrikeDone,
});
