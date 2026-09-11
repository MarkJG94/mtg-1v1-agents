import type { CardType, Color, Supertype, ZoneName } from '@mtg/shared';

/**
 * Engine-ready card definition. Card scripts (packages/cards) are loaded into this shape;
 * the engine never sees YAML or Scryfall data.
 */
export interface CardDefinition {
  /** Oracle id in production, any unique string in tests. */
  id: string;
  name: string;
  manaCost?: string;
  /** Explicit colours (colour indicators, devoid). Derived from the mana cost when absent. */
  colors?: Color[];
  supertypes?: Supertype[];
  types: CardType[];
  subtypes?: string[];
  power?: number | Quantity;
  toughness?: number | Quantity;
  loyalty?: number;
  abilities?: AbilityDef[];
  /** Token definitions are cards with `token: true`; they have no mana cost by default. */
  token?: boolean;
}

export type Keyword =
  | 'flying'
  | 'first strike'
  | 'double strike'
  | 'deathtouch'
  | 'haste'
  | 'hexproof'
  | 'indestructible'
  | 'lifelink'
  | 'menace'
  | 'reach'
  | 'trample'
  | 'vigilance'
  | 'defender'
  | 'flash'
  | 'shroud'
  | 'split second'
  | 'cant be countered'
  | 'flying';

export type ProtectionFrom =
  | { color: Color }
  | { type: CardType }
  | { everything: true }
  | { colored: true }
  | { filter: Filter };

export type KeywordAbility =
  | { kind: 'keyword'; keyword: Keyword }
  | { kind: 'keyword'; keyword: 'protection'; from: ProtectionFrom }
  | { kind: 'keyword'; keyword: 'ward'; cost: CostDef };

export interface TargetSpec {
  id: string;
  filter: Filter;
  /** Number of targets: exact, `upTo`, or `any` (0+). Default 1. */
  count?: number | { upTo: number } | 'any';
  /** "up to N target creatures" allowing zero when true. */
  optional?: boolean;
}

export type Timing = 'instant' | 'sorcery';

export type AbilityDef =
  | KeywordAbility
  | {
      kind: 'spell';
      targets?: TargetSpec[];
      effects: Effect[];
      modes?: ModeDef[];
      /** Additional cost paid on cast (sacrifice, discard, life). */
      additionalCost?: CostDef;
      /** Alternative cost; when present the caster chooses. */
      alternativeCost?: CostDef;
    }
  | {
      kind: 'activated';
      cost: CostDef;
      targets?: TargetSpec[];
      effects: Effect[];
      timing?: Timing;
      /** Activate only from this zone (default battlefield). */
      zone?: ZoneName;
      oncePerTurn?: boolean;
      condition?: Condition;
    }
  | {
      kind: 'mana';
      cost: CostDef;
      /** Mana produced, e.g. "{G}", "{C}{C}"; `choice` lists options ("{G}" or "{U}"). */
      produces?: string;
      choice?: string[];
      /** Any one colour. */
      anyColor?: boolean;
      condition?: Condition;
    }
  | {
      kind: 'triggered';
      trigger: TriggerDef;
      /** Intervening-if clause, checked on trigger and on resolution. */
      condition?: Condition;
      targets?: TargetSpec[];
      effects: Effect[];
      optional?: boolean;
      oncePerTurn?: boolean;
    }
  | {
      kind: 'static';
      effect: StaticEffectDef;
      /** Further parts of the same effect applying in other layers (CR 613.6), sharing the affected set. */
      also?: StaticEffectDef[];
      condition?: Condition;
    }
  | {
      kind: 'loyalty';
      cost: number;
      targets?: TargetSpec[];
      effects: Effect[];
    }
  | {
      kind: 'replacement';
      replaces: ReplacementDef;
      condition?: Condition;
    };

export interface ModeDef {
  label: string;
  targets?: TargetSpec[];
  effects: Effect[];
}

export type CostDef = {
  mana?: string;
  tap?: boolean;
  untap?: boolean;
  life?: number;
  sacrifice?: Filter | 'self';
  discard?: number | { filter?: Filter; count: number };
  exileFromGraveyard?: { filter?: Filter; count: number };
  removeCounters?: { counter: string; count: number };
  tapOther?: { filter: Filter; count: number };
  /** "{X}" in the cost: chooser picks X. */
  x?: boolean;
};

export type TriggerDef =
  | { on: 'etb'; filter?: Filter | 'self' }
  | { on: 'ltb'; filter?: Filter | 'self' }
  | { on: 'dies'; filter?: Filter | 'self' }
  | { on: 'cast'; filter?: Filter; who?: PlayerSel }
  | { on: 'attacks'; filter?: Filter | 'self' }
  | { on: 'blocks'; filter?: Filter | 'self' }
  | { on: 'becomesBlocked'; filter?: Filter | 'self' }
  | { on: 'dealsDamage'; filter?: Filter | 'self'; combat?: boolean; toPlayer?: boolean }
  | { on: 'dealtDamage'; filter?: Filter | 'self' }
  | { on: 'upkeep'; who?: PlayerSel }
  | { on: 'draw'; who?: PlayerSel }
  | { on: 'endStep'; who?: PlayerSel }
  | { on: 'beginCombat'; who?: PlayerSel }
  | { on: 'landfall'; who?: PlayerSel }
  | { on: 'counterPlaced'; filter?: Filter | 'self' }
  | { on: 'sacrificed'; filter?: Filter | 'self' }
  | { on: 'tapped'; filter?: Filter | 'self' }
  | { on: 'lifeGain'; who?: PlayerSel }
  | { on: 'discard'; who?: PlayerSel };

export type PlayerSel = 'you' | 'opponent' | 'any';

/** Which objects a static effect applies to: a filter, the source itself, or what the source is attached to. */
export type Affects = Filter | 'self' | 'attached';

export type StaticEffectDef =
  | {
      type: 'pt';
      affects: Affects;
      power: Quantity;
      toughness: Quantity;
    }
  | { type: 'setPT'; affects: Affects; power: Quantity; toughness: Quantity; cda?: boolean }
  | { type: 'switchPT'; affects: Affects }
  | { type: 'addAbility'; affects: Affects; ability: AbilityDef }
  | { type: 'loseAbility'; affects: Affects; keyword: Keyword | 'all' }
  | { type: 'addType'; affects: Affects; types?: CardType[]; subtypes?: string[] }
  | { type: 'setTypes'; affects: Affects; types: CardType[]; subtypes?: string[] }
  | { type: 'removeType'; affects: Affects; types?: CardType[]; subtypes?: string[] }
  | { type: 'setColor'; affects: Affects; colors: Color[] }
  | { type: 'addColor'; affects: Affects; colors: Color[] }
  | { type: 'control'; affects: Affects; controller: 'you' }
  | { type: 'cantAttack'; affects: Affects }
  | { type: 'cantBlock'; affects: Affects }
  | { type: 'cantBeBlocked'; affects: Affects }
  | { type: 'cantBeBlockedBy'; affects: Affects; by: Filter }
  | { type: 'doesntUntap'; affects: Affects }
  | { type: 'mustAttack'; affects: Affects }
  | { type: 'costReduction'; affects: Filter; amount: Quantity }
  | { type: 'costIncrease'; affects: Filter; amount: Quantity }
  | { type: 'cantCast'; affects: Filter; who?: PlayerSel }
  | { type: 'cantActivate'; affects: Filter; abilities: 'all' | 'nonMana' }
  | { type: 'maxHandSize'; player: PlayerSel; size: number | 'unlimited' }
  | { type: 'extraLandDrop'; player: PlayerSel; count: number }
  | { type: 'playerCantGainLife'; player: PlayerSel }
  | { type: 'noMaxLoyaltyActivations'; affects: Affects }
  /** Prevention shield created by an effect ("prevent all damage that would be dealt to X this turn"). */
  | {
      type: 'preventDamage';
      affects: Affects | 'you';
      amount: 'all' | number;
      combat?: boolean;
      noncombat?: boolean;
    }
  /** Regeneration shield or similar rule effects on the affected object. */
  | { type: 'cantBeTargeted'; affects: Affects; by?: 'opponents' | 'any' };

export type ReplacementDef =
  | {
      event: 'etb';
      filter: Filter | 'self';
      tapped?: true;
      withCounters?: { counter: string; count: Quantity };
      unlessPay?: { life: number };
    }
  | {
      event: 'dies';
      filter: Filter | 'self';
      instead: 'exile' | 'libraryBottom' | 'libraryTop' | 'hand';
    }
  | {
      event: 'damage';
      to: Filter | 'self' | 'you';
      prevent: 'all' | Quantity;
      combat?: boolean;
      noncombat?: boolean;
      from?: Filter;
    }
  | { event: 'damage'; to: Filter | 'self' | 'you'; double?: true; extra?: Quantity }
  | { event: 'draw'; who: PlayerSel; skip?: true; instead?: Effect[] }
  | { event: 'lifeGain'; who: PlayerSel; multiplier: number }
  | { event: 'counterPlaced'; filter: Filter | 'self'; extra: number }
  | { event: 'tokenCreated'; who: PlayerSel; extra: number };

export type DurationDef =
  | 'untilEndOfTurn'
  | 'permanent'
  | 'untilYourNextTurn'
  | 'whileSourceOnBattlefield'
  | 'untilSourceLeaves';

/** Object references usable inside effects. `$id` refers to a target or bound name. */
export type Ref = string;

export type PlayerRef = 'controller' | 'opponent' | 'activePlayer' | 'each' | Ref;

export type Quantity =
  | number
  | 'x'
  | { count: Filter; zone?: ZoneName | 'any'; per?: never }
  | { countTypes: 'inAllGraveyards' }
  | { add: Quantity[] }
  | { sub: [Quantity, Quantity] }
  | { mul: [Quantity, Quantity] }
  | { max: Quantity[] }
  | { min: Quantity[] }
  | { negate: Quantity }
  | { lifeTotal: PlayerRef }
  | { cardsInHand: PlayerRef }
  | { cardsInGraveyard: PlayerRef }
  | { power: Ref }
  | { toughness: Ref }
  | { manaValue: Ref }
  | { counters: Ref; counter: string }
  | { devotion: Color[]; player?: PlayerRef }
  | { lands: PlayerRef }
  | { damageDealt: true }
  | { bound: string };

export type Condition =
  | { compare: Quantity; op: '<' | '<=' | '=' | '>=' | '>' | '!='; to: Quantity }
  | { controls: Filter; player?: PlayerRef; count?: number }
  | { exists: Filter; zone?: ZoneName | 'any'; count?: number }
  | { isYourTurn: true }
  | { isTapped: Ref }
  | { isAttacking: Ref }
  | { hasKeyword: Ref; keyword: Keyword }
  | { matches: Ref; filter: Filter }
  | { onBattlefield: Ref }
  | { inZone: Ref; zone: ZoneName }
  | { landsPlayedThisTurn: { op: '<' | '>=' | '='; count: number } }
  | { step: string[] }
  | { not: Condition }
  | { and: Condition[] }
  | { or: Condition[] }
  | { lifeGainedThisTurn: PlayerRef }
  | { spellsCastThisTurn: { player?: PlayerRef; op: '>=' | '<'; count: number } };

export interface Filter {
  /** Object kinds this filter can match. `any` = creature | player | planeswalker. */
  type?: CardType | CardType[];
  notType?: CardType | CardType[];
  subtype?: string | string[];
  supertype?: Supertype | Supertype[];
  color?: Color | Color[];
  colorless?: boolean;
  multicolored?: boolean;
  controller?: 'you' | 'opponent' | 'any';
  owner?: 'you' | 'opponent' | 'any';
  zone?: ZoneName;
  tapped?: boolean;
  untapped?: boolean;
  mvLTE?: Quantity;
  mvGTE?: Quantity;
  mvEQ?: Quantity;
  powerGTE?: Quantity;
  powerLTE?: Quantity;
  toughnessGTE?: Quantity;
  toughnessLTE?: Quantity;
  hasKeyword?: Keyword;
  lacksKeyword?: Keyword;
  isToken?: boolean;
  nonToken?: boolean;
  name?: string;
  attacking?: boolean;
  blocking?: boolean;
  blocked?: boolean;
  /** Excludes the source object ("another creature"). */
  other?: boolean;
  /** Matches players. */
  player?: 'any' | 'you' | 'opponent';
  /** Matches spells on the stack (optionally only of the given types). */
  spell?: boolean;
  /** Matches abilities on the stack. */
  ability?: boolean;
  /** creature | player | planeswalker */
  any?: boolean;
  /** creature | planeswalker (damageable permanents) */
  anyPermanent?: boolean;
  attachedTo?: Filter;
  hasCounter?: string;
  damaged?: boolean;
  enteredThisTurn?: boolean;
  not?: Filter;
  and?: Filter[];
  or?: Filter[];
  /** Matches the source object itself. */
  self?: boolean;
}

export interface TokenDef {
  name: string;
  types: CardType[];
  subtypes?: string[];
  supertypes?: Supertype[];
  colors?: Color[];
  power?: number;
  toughness?: number;
  abilities?: AbilityDef[];
}

export type Effect =
  | { op: 'damage'; amount: Quantity; to: Ref | Ref[]; from?: Ref; divided?: boolean }
  | { op: 'gainLife'; amount: Quantity; player?: PlayerRef }
  | { op: 'loseLife'; amount: Quantity; player?: PlayerRef }
  | { op: 'setLife'; amount: Quantity; player?: PlayerRef }
  | { op: 'draw'; count: Quantity; player?: PlayerRef }
  | {
      op: 'discard';
      count: Quantity | 'hand';
      player?: PlayerRef;
      random?: boolean;
      filter?: Filter;
      chooser?: 'controller';
    }
  | { op: 'mill'; count: Quantity; player?: PlayerRef }
  | { op: 'counter'; target: Ref; unlessPay?: string }
  | { op: 'destroy'; target: Ref; noRegenerate?: boolean }
  /** Simultaneous versions for "destroy all"/"exile all"/"each creature" effects. */
  | { op: 'destroyAll'; filter: Filter; noRegenerate?: boolean }
  | { op: 'exileAll'; filter: Filter; zone?: ZoneName }
  | { op: 'bounceAll'; filter: Filter }
  | { op: 'sacrificeAll'; filter: Filter; player?: PlayerRef }
  | { op: 'damageEach'; filter: Filter; amount: Quantity; players?: PlayerSel }
  | { op: 'exile'; target: Ref }
  | {
      op: 'moveZone';
      target: Ref;
      to: 'hand' | 'graveyard' | 'libraryTop' | 'libraryBottom' | 'battlefield' | 'exile';
      tapped?: boolean;
      controller?: PlayerRef;
    }
  | { op: 'bounce'; target: Ref }
  | { op: 'sacrifice'; target?: Ref; filter?: Filter; count?: Quantity; player?: PlayerRef }
  | { op: 'tap'; target: Ref }
  | { op: 'untap'; target: Ref }
  | {
      op: 'createToken';
      token: TokenDef;
      count?: Quantity;
      player?: PlayerRef;
      tapped?: boolean;
      attacking?: boolean;
    }
  | { op: 'addCounters'; target: Ref; counter: string; count: Quantity }
  | { op: 'removeCounters'; target: Ref; counter: string; count: Quantity }
  | { op: 'pump'; target: Ref; power: Quantity; toughness: Quantity; duration?: DurationDef }
  | { op: 'grantAbility'; target: Ref; ability: AbilityDef; duration?: DurationDef }
  | { op: 'loseAbilities'; target: Ref; duration?: DurationDef }
  | { op: 'setPT'; target: Ref; power: Quantity; toughness: Quantity; duration?: DurationDef }
  | { op: 'gainControl'; target: Ref; duration?: DurationDef; player?: PlayerRef }
  | {
      op: 'search';
      player?: PlayerRef;
      filter?: Filter;
      count?: Quantity;
      to: 'hand' | 'battlefield' | 'libraryTop' | 'graveyard';
      tapped?: boolean;
      reveal?: boolean;
    }
  | { op: 'shuffle'; player?: PlayerRef }
  | { op: 'scry'; count: Quantity; player?: PlayerRef }
  | { op: 'surveil'; count: Quantity; player?: PlayerRef }
  | { op: 'addMana'; mana: string; player?: PlayerRef }
  | {
      op: 'preventDamage';
      target: Ref;
      amount: Quantity | 'all';
      duration?: DurationDef;
      combat?: boolean;
    }
  | { op: 'regenerate'; target: Ref }
  | { op: 'fight'; a: Ref; b: Ref }
  | { op: 'attach'; target: Ref; to: Ref }
  | { op: 'extraTurn'; player?: PlayerRef }
  | { op: 'sequence'; effects: Effect[] }
  | { op: 'forEach'; filter: Filter; zone?: ZoneName; as: string; effects: Effect[] }
  | { op: 'forEachPlayer'; as: string; effects: Effect[]; order?: 'apnap' }
  | { op: 'if'; condition: Condition; then: Effect[]; else?: Effect[] }
  | { op: 'may'; player?: PlayerRef; effects: Effect[] }
  | { op: 'unless'; player: PlayerRef; cost: CostDef; effects: Effect[] }
  | {
      op: 'delayedTrigger';
      trigger: TriggerDef | { on: 'nextEndStep' } | { on: 'nextUpkeep' };
      effects: Effect[];
      bind?: Ref[];
    }
  | { op: 'createEffect'; effect: StaticEffectDef; duration: DurationDef; target?: Ref }
  | { op: 'choose'; player?: PlayerRef; options: { label: string; effects: Effect[] }[] }
  | { op: 'winGame'; player?: PlayerRef }
  | { op: 'loseGame'; player?: PlayerRef }
  | { op: 'copySpell'; target: Ref; newTargets?: boolean }
  | { op: 'bind'; as: string; value: Quantity }
  | { op: 'transformTargetsTo'; target: Ref; newTarget: Ref }
  | { op: 'reveal'; target?: Ref; hand?: PlayerRef }
  | { op: 'putOnTopOfLibrary'; target: Ref }
  | { op: 'noop' };

export function keywordsOf(abilities: readonly AbilityDef[] | undefined): Keyword[] {
  const out: Keyword[] = [];
  if (!abilities) return out;
  for (const a of abilities) if (a.kind === 'keyword') out.push(a.keyword as Keyword);
  return out;
}
