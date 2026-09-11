import type {
  CardType,
  Color,
  GameEndReason,
  ObjectId,
  PlayerId,
  Step,
  Supertype,
  ZoneName,
} from '@mtg/shared';
import type {
  AbilityDef,
  CardDefinition,
  Effect,
  Filter,
  Keyword,
  ProtectionFrom,
  StaticEffectDef,
  TargetSpec,
  TriggerDef,
} from './definition.js';
import type { ManaCost, ManaPool } from './mana/cost.js';
import type { RngState } from './rng.js';

export interface ObjectRef {
  id: ObjectId;
  /** Zone-change counter at the time of reference; a mismatch means "new object" (CR 400.7). */
  instance: number;
}

export type TargetRef =
  | { kind: 'object'; id: ObjectId; instance: number }
  | { kind: 'player'; player: PlayerId }
  | { kind: 'stack'; stackId: number };

export interface PlayerState {
  life: number;
  poison: number;
  pool: ManaPool;
  landsPlayedThisTurn: number;
  maxHandSize: number;
  lifeGainedThisTurn: number;
  lifeLostThisTurn: number;
  spellsCastThisTurn: number;
  drawnThisTurn: number;
  attemptedDrawFromEmpty: boolean;
  mulligans: number;
  /** Set once the player has lost; the game ends immediately in a 2-player game. */
  lost: boolean;
}

export interface Zones {
  library: ObjectId[];
  hand: ObjectId[];
  battlefield: ObjectId[];
  graveyard: ObjectId[];
  exile: ObjectId[];
  command: ObjectId[];
}

export interface GameObject {
  id: ObjectId;
  instance: number;
  definitionId: string;
  owner: PlayerId;
  /** Effective controller (after control-changing effects). */
  controller: PlayerId;
  /** Controller absent any control-changing effect: whoever put it onto the battlefield. */
  defaultController: PlayerId;
  zone: ZoneName;
  timestamp: number;
  tapped: boolean;
  counters: Record<string, number>;
  damage: number;
  /** Damage this turn came from a deathtouch source (SBA 704.5h). */
  deathtouched: boolean;
  attachedTo: ObjectId | null;
  attachments: ObjectId[];
  isToken: boolean;
  /** Copiable values override when this object is a copy (layer 1). */
  copyOf: string | null;
  /** True until the controller has controlled it continuously since their most recent turn began. */
  sick: boolean;
  enteredThisTurn: boolean;
  regenerationShields: number;
  loyaltyActivationsThisTurn: number;
  abilityActivationsThisTurn: Record<number, number>;
  /** Snapshot taken when the object last left the battlefield (CR 113.7a / 603.10). */
  lki: Characteristics | null;
  /** Colour/type/name choices made as it entered. */
  chosen: Record<string, string>;
  /** X chosen when cast; retained on the battlefield for "enters with X counters". */
  x: number;
  /** For spells: whether cast (vs. put on stack by other means). */
  wasCast: boolean;
  /** Per-turn damage prevention shields granted by prevention effects. */
  preventionShield: number;
}

export interface Characteristics {
  name: string;
  manaCost: ManaCost;
  manaValue: number;
  colors: Color[];
  supertypes: Supertype[];
  types: CardType[];
  subtypes: string[];
  power: number;
  toughness: number;
  loyalty: number | null;
  abilities: AbilityDef[];
  keywords: Set<Keyword | 'protection' | 'ward'>;
  protections: ProtectionFrom[];
  wardCosts: number;
  /** Rule-modifying flags gathered from static abilities. */
  flags: CharacteristicFlags;
  /** Controller after layer 2. */
  controller: PlayerId;
}

export interface CharacteristicFlags {
  cantAttack: boolean;
  cantBlock: boolean;
  cantBeBlocked: boolean;
  cantBeBlockedBy: Filter[];
  doesntUntap: boolean;
  mustAttack: boolean;
  noAbilities: boolean;
}

export type StackItemKind = 'spell' | 'ability' | 'trigger';

export interface StackItem {
  stackId: number;
  kind: StackItemKind;
  controller: PlayerId;
  /** The spell object (for spells) or the ability's source. */
  source: ObjectRef;
  /** Index into the source's abilities (activated/triggered), or -1 for a spell. */
  abilityIndex: number;
  effects: Effect[];
  targetSpecs: TargetSpec[];
  targets: Record<string, TargetRef[]>;
  x: number;
  modeLabels: string[];
  /** Copy of the source's characteristics when the trigger/ability was created (LKI). */
  sourceLki: Characteristics | null;
  /** Objects/players bound when a trigger fired (`triggerObject`, `triggerPlayer`, `damage`). */
  bindings: Record<string, TargetRef | number | TargetRef[]>;
  /** Intervening-if condition (rechecked on resolution). */
  condition: import('./definition.js').Condition | null;
  splitSecond: boolean;
  cantBeCountered: boolean;
  /** Set by "unless" cost payments and by copy effects. */
  isCopy: boolean;
  optional: boolean;
}

export type Layer = '1' | '2' | '3' | '4' | '5' | '6' | '7a' | '7b' | '7c' | '7d' | 'rules';

export type Duration =
  | { kind: 'untilEndOfTurn' }
  | { kind: 'permanent' }
  | { kind: 'untilYourNextTurn'; player: PlayerId; turnSeen: number }
  | { kind: 'untilSourceLeaves'; source: ObjectRef };

export interface ContinuousEffect {
  id: number;
  source: ObjectRef;
  controller: PlayerId;
  timestamp: number;
  effect: StaticEffectDef;
  /** Locked affected set for effects from resolved spells/abilities (CR 611.2c). */
  affected: ObjectRef[] | null;
  duration: Duration;
}

export interface DelayedTrigger {
  id: number;
  source: ObjectRef;
  sourceLki: Characteristics;
  controller: PlayerId;
  trigger: TriggerDef | { on: 'nextEndStep' } | { on: 'nextUpkeep' };
  effects: Effect[];
  bindings: Record<string, TargetRef | number | TargetRef[]>;
  createdTurn: number;
  createdInEndStep: boolean;
}

export interface TriggerInstance {
  controller: PlayerId;
  source: ObjectRef;
  abilityIndex: number;
  ability: Extract<AbilityDef, { kind: 'triggered' }> | null;
  effects: Effect[];
  targetSpecs: TargetSpec[];
  sourceLki: Characteristics;
  bindings: Record<string, TargetRef | number | TargetRef[]>;
  condition: import('./definition.js').Condition | null;
  optional: boolean;
  /** For delayed triggers: remove after it goes on the stack. */
  delayedId: number | null;
}

export interface AttackerState {
  attacker: ObjectId;
  defender: ObjectId | PlayerId;
  blockers: ObjectId[];
  /** Damage assignment order chosen by the attacker's controller (CR 509.2). */
  blockerOrder: ObjectId[];
  blocked: boolean;
  removedFromCombat: boolean;
}

export interface CombatState {
  attackers: AttackerState[];
  /** blocker → attackers it blocks (one in v1). */
  blockers: Record<ObjectId, ObjectId[]>;
  firstStrikeStepHappened: boolean;
  /** Creatures that already dealt first-strike damage this combat. */
  dealtFirstStrike: ObjectId[];
}

export type Decision =
  | { kind: 'mulligan'; player: PlayerId; hand: ObjectId[]; mulligans: number }
  | { kind: 'bottomCards'; player: PlayerId; hand: ObjectId[]; count: number }
  | { kind: 'priority'; player: PlayerId; actions: Action[] }
  | {
      kind: 'chooseTargets';
      player: PlayerId;
      specs: TargetSpec[];
      candidates: TargetRef[][];
      /** Why targets are being chosen (cast/activate/trigger/effect). */
      reason: string;
    }
  | { kind: 'chooseMode'; player: PlayerId; modes: string[]; min: number; max: number }
  | { kind: 'chooseX'; player: PlayerId; max: number }
  | { kind: 'payMana'; player: PlayerId; cost: string; options: ManaPayment[] }
  | {
      kind: 'declareAttackers';
      player: PlayerId;
      candidates: { attacker: ObjectId; defenders: (ObjectId | PlayerId)[] }[];
      required: ObjectId[];
    }
  | {
      kind: 'declareBlockers';
      player: PlayerId;
      candidates: { blocker: ObjectId; attackers: ObjectId[] }[];
      menace: ObjectId[];
    }
  | { kind: 'orderBlockers'; player: PlayerId; attacker: ObjectId; blockers: ObjectId[] }
  | {
      kind: 'assignDamage';
      player: PlayerId;
      attacker: ObjectId;
      amount: number;
      recipients: { id: ObjectId | PlayerId; lethal: number }[];
      trample: boolean;
      defender: ObjectId | PlayerId;
    }
  | {
      kind: 'orderTriggers';
      player: PlayerId;
      triggers: { index: number; source: ObjectId; text: string }[];
    }
  | {
      kind: 'chooseObjects';
      player: PlayerId;
      reason: string;
      options: ObjectId[];
      min: number;
      max: number;
    }
  | {
      kind: 'chooseCardsFromLibrary';
      player: PlayerId;
      options: ObjectId[];
      min: number;
      max: number;
      reason: string;
    }
  | { kind: 'scry'; player: PlayerId; cards: ObjectId[] }
  | { kind: 'yesNo'; player: PlayerId; question: string; source: ObjectId }
  | { kind: 'chooseOption'; player: PlayerId; options: string[]; source: ObjectId }
  | { kind: 'chooseReplacement'; player: PlayerId; options: string[] }
  | { kind: 'distributeCounters'; player: PlayerId; total: number; recipients: ObjectId[] }
  | { kind: 'chooseColor'; player: PlayerId; source: ObjectId }
  | { kind: 'declareAttackersOptional'; player: PlayerId };

export interface ManaPayment {
  /** Sources to tap with the mana-ability index and produced mana. */
  taps: { source: ObjectId; ability: number; mana: string }[];
  /** Mana spent from the pool. */
  fromPool: string;
  lifePaid: number;
  description: string;
}

export type Action =
  | { kind: 'pass' }
  | { kind: 'playLand'; object: ObjectId }
  | { kind: 'cast'; object: ObjectId; alternative?: boolean; text: string }
  | { kind: 'activate'; source: ObjectId; ability: number; text: string }
  | { kind: 'activateMana'; source: ObjectId; ability: number; text: string }
  | { kind: 'loyalty'; source: ObjectId; ability: number; text: string };

export type DecisionAnswer =
  | { kind: 'mulligan'; keep: boolean }
  | { kind: 'bottomCards'; cards: ObjectId[] }
  | { kind: 'priority'; action: Action }
  | { kind: 'chooseTargets'; targets: TargetRef[][] }
  | { kind: 'chooseMode'; modes: number[] }
  | { kind: 'chooseX'; x: number }
  | { kind: 'payMana'; option: number }
  | { kind: 'declareAttackers'; attacks: { attacker: ObjectId; defender: ObjectId | PlayerId }[] }
  | { kind: 'declareBlockers'; blocks: { blocker: ObjectId; attacker: ObjectId }[] }
  | { kind: 'orderBlockers'; order: ObjectId[] }
  | { kind: 'assignDamage'; assignments: { id: ObjectId | PlayerId; amount: number }[] }
  | { kind: 'orderTriggers'; order: number[] }
  | { kind: 'chooseObjects'; objects: ObjectId[] }
  | { kind: 'chooseCardsFromLibrary'; cards: ObjectId[] }
  | { kind: 'scry'; top: ObjectId[]; bottom: ObjectId[] }
  | { kind: 'yesNo'; yes: boolean }
  | { kind: 'chooseOption'; option: number }
  | { kind: 'chooseReplacement'; option: number }
  | { kind: 'distributeCounters'; amounts: number[] }
  | { kind: 'chooseColor'; color: Color }
  | { kind: 'declareAttackersOptional'; attack: boolean };

export interface GameResult {
  winner: PlayerId | null;
  reason: GameEndReason;
}

export interface TurnFlags {
  /** Objects that entered this turn, for "enteredThisTurn" checks (cleared each turn). */
  extraTurns: PlayerId[];
  isExtraTurn: boolean;
  attackedThisTurn: ObjectId[];
  /** Repeated-state hashes within this turn for loop detection (only collected after many decisions). */
  stateHashes: string[];
  priorityDecisions: number;
}

export interface GameConfig {
  startingLife: number;
  startingHandSize: number;
  turnCap: number;
  decisionCap: number;
  mulligans: boolean;
  /** Skip the first draw for the starting player (CR 103.8a). */
  firstPlayerDraws: boolean;
}

export const DEFAULT_CONFIG: GameConfig = {
  startingLife: 20,
  startingHandSize: 7,
  turnCap: 40,
  decisionCap: 5000,
  mulligans: true,
  firstPlayerDraws: false,
};

/** Frames of the resumable interpreter (see frames.ts). */
export type Frame = import('./frames.js').Frame;

export interface GameState {
  rng: RngState;
  version: number;
  config: GameConfig;
  definitions: Record<string, CardDefinition>;
  turn: number;
  activePlayer: PlayerId;
  startingPlayer: PlayerId;
  step: Step;
  priority: PlayerId | null;
  passes: number;
  players: Record<PlayerId, PlayerState>;
  objects: Record<ObjectId, GameObject>;
  nextObjectId: number;
  nextStackId: number;
  nextEffectId: number;
  timestamp: number;
  zones: Record<PlayerId, Zones>;
  stack: StackItem[];
  effects: ContinuousEffect[];
  delayedTriggers: DelayedTrigger[];
  pendingTriggers: TriggerInstance[];
  combat: CombatState | null;
  pendingDecision: Decision | null;
  frames: Frame[];
  turnFlags: TurnFlags;
  result: GameResult | null;
  /** Whether the game has begun (mulligans done). */
  started: boolean;
  decisionCount: number;
  eventSeq: number;
  /** Objects that changed zones since SBAs were last checked (for triggers/SBA scheduling). */
  sbaPending: boolean;
}
