import type {
  Keywords,
  PlayerView,
  PriorityAction,
  Rng,
  Simulator,
  VisibleObject,
} from '@mtg/engine/view';
import { asObjectId, asOracleId, type ObjectId, type PlayerId } from '@mtg/shared';

/**
 * Hand-built views for the agents package's own tests.
 *
 * This package cannot import the engine (ADR 0009), and that includes its tests — so it
 * cannot build a game and project it. These builders make a `PlayerView` directly, as
 * plain data, which is all a view is. `@mtg/sim` is where agents meet real games.
 */

export const plainKeywords: Keywords = {
  shroud: false,
  hexproof: false,
  protectionFrom: [],
  ward: null,
  flying: false,
  reach: false,
  menace: false,
  vigilance: false,
  haste: false,
  defender: false,
  firstStrike: false,
  doubleStrike: false,
  trample: false,
  deathtouch: false,
  lifelink: false,
  indestructible: false,
};

let nextId = 1;

export interface CardSpec {
  readonly owner?: PlayerId;
  readonly zone?: 'hand' | 'battlefield' | 'graveyard';
  readonly types?: VisibleObject['types'];
  readonly power?: number;
  readonly toughness?: number;
  readonly manaValue?: number;
  readonly costColours?: VisibleObject['costColours'];
  readonly producesMana?: VisibleObject['producesMana'];
  readonly keywords?: Partial<Keywords>;
  readonly tapped?: boolean;
  readonly sick?: boolean;
  readonly damage?: number;
  readonly loyalty?: number | null;
}

export const card = (spec: CardSpec = {}): VisibleObject => {
  const id = asObjectId(nextId++);
  const owner = spec.owner ?? 'A';
  const creature = spec.power !== undefined;
  return {
    id,
    oracleId: asOracleId(`test-${id}`),
    zone:
      spec.zone === 'hand'
        ? `${owner}:hand`
        : spec.zone === 'graveyard'
          ? `${owner}:graveyard`
          : 'battlefield',
    owner,
    controller: owner,
    name: null,
    isCreature: creature,
    power: spec.power ?? null,
    toughness: spec.toughness ?? (creature ? 1 : null),
    colours: [],
    keywords: { ...plainKeywords, ...spec.keywords },
    legendary: false,
    types: spec.types ?? (creature ? ['creature'] : []),
    manaValue: spec.manaValue ?? 0,
    costColours: spec.costColours ?? [],
    producesMana: spec.producesMana ?? [],
    tapped: spec.tapped ?? false,
    damage: spec.damage ?? 0,
    counters: {},
    loyalty: spec.loyalty ?? null,
    summoningSick: spec.sick ?? false,
    token: false,
    attachedTo: null,
    attachments: [],
  } as VisibleObject;
};

export const land = (spec: CardSpec = {}): VisibleObject =>
  card({ types: ['land'], producesMana: ['G'], ...spec });

export const creature = (power: number, toughness: number, spec: CardSpec = {}): VisibleObject =>
  card({ power, toughness, ...spec });

export interface ViewSpec {
  readonly viewer?: PlayerId;
  readonly mine?: readonly VisibleObject[];
  readonly theirs?: readonly VisibleObject[];
  readonly hand?: readonly VisibleObject[];
  readonly myLife?: number;
  readonly theirLife?: number;
  readonly theirHandSize?: number;
  readonly myLibrary?: number;
  readonly step?: PlayerView['step'];
  readonly result?: PlayerView['result'];
}

/** A view from A's seat: `mine` and `theirs` are battlefields, `hand` is A's hand. */
export const viewOf = (spec: ViewSpec = {}): PlayerView => {
  const mine = (spec.mine ?? []).map((o) => ({
    ...o,
    owner: 'A' as const,
    controller: 'A' as const,
  }));
  const theirs = (spec.theirs ?? []).map((o) => ({
    ...o,
    owner: 'B' as const,
    controller: 'B' as const,
  }));
  const hand = (spec.hand ?? []).map((o) => ({
    ...o,
    owner: 'A' as const,
    controller: 'A' as const,
    zone: 'A:hand' as const,
  }));
  const objects = new Map<ObjectId, VisibleObject>();
  for (const object of [...mine, ...theirs, ...hand]) objects.set(object.id, object);

  const side = (player: PlayerId, battlefield: readonly VisibleObject[], life: number) => ({
    player,
    life,
    poison: 0,
    handSize: 0,
    librarySize: 30,
    graveyard: [],
    battlefield: battlefield.map((o) => o.id),
    landsPlayedThisTurn: 0,
    maxLandsPerTurn: 1,
    manaPool: {},
  });

  return {
    viewer: 'A',
    turn: 3,
    step: spec.step ?? 'precombatMain',
    activePlayer: 'A',
    priority: 'A',
    you: {
      ...side('A', mine, spec.myLife ?? 20),
      hand: hand.map((o) => o.id),
      handSize: hand.length,
      librarySize: spec.myLibrary ?? 30,
    },
    opponent: { ...side('B', theirs, spec.theirLife ?? 20), handSize: spec.theirHandSize ?? 0 },
    objects,
    battlefield: [...mine, ...theirs].map((o) => o.id),
    stack: [],
    exile: [],
    combat: null,
    result: spec.result ?? null,
  };
};

/**
 * A stand-in generator whose every choice is scripted: `nextBoolean` answers from `yes`,
 * and `pick` takes the first item. Enough to drive the random agent through one exact
 * path; a real seeded generator is what `@mtg/sim`'s tests use.
 */
export const scriptedRng = (yes = true): Rng => {
  const rng: Rng = {
    nextUint32: () => 0,
    nextFloat: () => 0,
    nextInt: () => 0,
    nextIntBetween: (min) => min,
    nextBoolean: () => yes,
    pick: <T>(items: readonly T[]): T => {
      const first = items[0];
      if (first === undefined) throw new Error('pick from an empty list');
      return first;
    },
    pickWeightedIndex: () => 0,
    shuffled: <T>(items: readonly T[]): T[] => [...items],
    fork: () => rng,
    save: () => [0, 0, 0, 0] as const,
  };
  return rng;
};

type Cast = Extract<PriorityAction, { kind: 'cast' }>;

/** A cast action as the engine would offer it; the cost is the engine's business, not an agent's. */
export const cast = (object: ObjectId, targets: Cast['targets'] = []): PriorityAction => ({
  kind: 'cast',
  object,
  cost: { generic: 0, variable: 0, symbols: [] },
  targets,
});

/**
 * A simulator for agents that never search. Any use of it is a test that thought it was
 * testing greedy or random and was not, so it throws rather than answering.
 */
export const noSimulator: Simulator = {
  viewer: 'A',
  sample: () => {
    throw new Error('this agent was not expected to search');
  },
  decision: () => {
    throw new Error('this agent was not expected to search');
  },
  apply: () => {
    throw new Error('this agent was not expected to search');
  },
  view: () => {
    throw new Error('this agent was not expected to search');
  },
  status: () => {
    throw new Error('this agent was not expected to search');
  },
};
