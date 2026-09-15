import {
  asOracleId,
  type EventTarget,
  type ObjectId,
  type PlayerId,
  playerIds,
  playerZone,
  type Step,
  type ZoneId,
} from '@mtg/shared';
import { addEffect } from '../characteristics.js';
import type { BlockDeclaration } from '../combat.js';
import type { DecisionResponse } from '../decision.js';
import { createEventEmitter, type EventEmitter } from '../events/emitter.js';
import type { ContinuousEffect } from '../layers.js';
import type { LoyaltyAbility } from '../planeswalker.js';
import { addReplacement, type ReplacementEffect } from '../replacement.js';
import { stateFromSeed } from '../rng.js';
import { putOnStack } from '../stack.js';
import {
  type CreateGameStateOptions,
  createGameState,
  type GameState,
} from '../state/game-state.js';
import { createObject, getObject, objectsIn, updateObject } from '../state/update.js';
import { type Keywords, keywords } from '../targeting.js';
import type { TriggeredAbility } from '../triggers.js';
import { applyDecision, startGame } from '../turn/turn.js';

/**
 * The scenario builder (docs/09 "Engine unit tests").
 *
 * Every test in the engine used to start with thirty lines of its own board setup, and
 * they had all drifted apart. This is the shared one: describe a board, start it, drive
 * decisions explicitly, and assert.
 *
 * docs/09 sketches it over card names — `.hand('Lightning Bolt')` — which needs card
 * definitions, so that arrives in roadmap 2.1. Until then a permanent is described by
 * what the engine can actually read off it (power, toughness, keywords, loyalty), and
 * `name` is a label: it makes a test readable and lets `ref()` find the object again,
 * and the legend rule is the one rule that reads it. Nothing here hard-codes a real
 * card's name, which the roadmap's working agreement forbids in any case.
 *
 * Decisions are always driven explicitly. A test that let an agent choose would be
 * testing the agent.
 */

export interface PermanentSpec {
  /** A label for readability and for `ref()`; also what the legend rule compares. */
  readonly name?: string;
  readonly power?: number;
  readonly toughness?: number;
  /** Present makes it a planeswalker; it enters with this many loyalty counters. */
  readonly loyalty?: number;
  readonly keywords?: Partial<Keywords>;
  readonly tapped?: boolean;
  /** Defaults to false, so a scenario's creatures can attack the turn it starts. */
  readonly summoningSick?: boolean;
  readonly damage?: number;
  readonly deathtouched?: boolean;
  readonly counters?: Readonly<Record<string, number>>;
  readonly legendary?: boolean;
  readonly token?: boolean;
  readonly attachment?: 'aura' | 'equipment';
  readonly attachedTo?: string;
  readonly triggers?: readonly TriggeredAbility[];
  readonly loyaltyAbilities?: readonly LoyaltyAbility[];
  readonly colours?: readonly ('W' | 'U' | 'B' | 'R' | 'G')[];
}

export interface ScenarioOptions extends Partial<CreateGameStateOptions> {
  /** Seed for the game's generator; the same seed always builds the same game. */
  readonly seed?: string;
  /** Collect the event log as the scenario runs. */
  readonly recordEvents?: boolean;
}

const definition = asOracleId('scenario-card');

/**
 * A board under construction. Every method returns `this`, so a scenario reads as one
 * sentence; `start()` freezes it into a running game.
 */
export class Scenario {
  private state: GameState;
  private readonly emitter: EventEmitter;
  private readonly labels = new Map<string, ObjectId>();
  private readonly log: string[] = [];
  private current: PlayerId;

  constructor(options: ScenarioOptions = {}) {
    this.state = createGameState({
      rng: stateFromSeed(options.seed ?? 'scenario'),
      onPlay: 'A',
      ...options,
    });
    this.emitter = createEventEmitter(
      options.recordEvents ? { onEvent: (event) => this.log.push(event.type) } : {},
    );
    this.current = this.state.config.playerOnPlay;
  }

  /** Everything after this call belongs to `player`, until the next `player()`. */
  player(player: PlayerId): this {
    this.current = player;
    return this;
  }

  battlefield(...specs: readonly PermanentSpec[]): this {
    for (const spec of specs) this.put(spec, 'battlefield');
    return this;
  }

  hand(...specs: readonly PermanentSpec[]): this {
    for (const spec of specs) this.put(spec, playerZone(this.current, 'hand'));
    return this;
  }

  graveyard(...specs: readonly PermanentSpec[]): this {
    for (const spec of specs) this.put(spec, playerZone(this.current, 'graveyard'));
    return this;
  }

  /** `count` anonymous cards in the library, which is all most tests need of one. */
  library(count: number, ...specs: readonly PermanentSpec[]): this {
    for (let i = 0; i < count; i += 1) this.put({}, playerZone(this.current, 'library'));
    for (const spec of specs) this.put(spec, playerZone(this.current, 'library'));
    return this;
  }

  life(amount: number): this {
    this.state = {
      ...this.state,
      players: {
        ...this.state.players,
        [this.current]: { ...this.state.players[this.current], life: amount },
      },
    };
    return this;
  }

  effect(spec: Omit<ContinuousEffect, 'id' | 'timestamp' | 'layer'>): this {
    this.state = addEffect(this.state, spec).state;
    return this;
  }

  replacement(spec: Omit<ReplacementEffect, 'id'>): this {
    this.state = addReplacement(this.state, spec).state;
    return this;
  }

  /** The object built under this label. Throws rather than returning undefined. */
  ref(name: string): ObjectId {
    const id = this.labels.get(name);
    if (id === undefined) {
      throw new ScenarioError(`no object labelled "${name}" in this scenario`);
    }
    return id;
  }

  /** `ref` as a damage or attack target. */
  target(name: string): EventTarget {
    return { kind: 'object', object: this.ref(name) };
  }

  // --- Running ---

  /** Begin turn 1 and run to the first decision. Setup and mulligans are skipped. */
  start(): this {
    this.state = startGame(this.state, this.emitter);
    return this;
  }

  /** Answer the pending decision. */
  decide(response: DecisionResponse): this {
    this.state = applyDecision(this.state, this.emitter, response);
    return this;
  }

  pass(times = 1): this {
    for (let i = 0; i < times; i += 1) {
      this.decide({ kind: 'priority', action: { kind: 'pass' } });
    }
    return this;
  }

  /** Pass priority until `step` begins and a decision is pending. */
  to(step: Step, limit = 500): this {
    for (let i = 0; i < limit; i += 1) {
      if (this.state.step === step && this.state.pendingDecision !== null) return this;
      if (this.state.result !== null) {
        throw new ScenarioError(`the game ended before reaching ${step}`);
      }
      this.pass();
    }
    throw new ScenarioError(`did not reach ${step} within ${limit} decisions`);
  }

  /** Put a card from the current player's hand on the stack, by label. */
  cast(name: string, options: Parameters<typeof putOnStack>[4] = {}): this {
    this.state = putOnStack(this.state, this.emitter, this.current, this.ref(name), options);
    return this;
  }

  attack(
    ...attacks: readonly (string | { readonly attacker: string; readonly at: string })[]
  ): this {
    return this.decide({
      kind: 'declareAttackers',
      attackers: attacks.map((attack) =>
        typeof attack === 'string'
          ? { attacker: this.ref(attack), defender: this.defaultDefender() }
          : { attacker: this.ref(attack.attacker), defender: this.target(attack.at) },
      ),
    });
  }

  block(...blocks: readonly { readonly blocker: string; readonly blocking: string }[]): this {
    const declarations: BlockDeclaration[] = blocks.map((block) => ({
      blocker: this.ref(block.blocker),
      blocking: [this.ref(block.blocking)],
    }));
    return this.decide({ kind: 'declareBlockers', blocks: declarations });
  }

  // --- Reading ---

  get(): GameState {
    return this.state;
  }

  object(name: string) {
    return getObject(this.state, this.ref(name));
  }

  zoneOf(name: string): ZoneId {
    return this.object(name).zone;
  }

  lifeOf(player: PlayerId): number {
    return this.state.players[player].life;
  }

  events(): readonly string[] {
    return this.log;
  }

  // --- Internals ---

  private defaultDefender(): EventTarget {
    const defending = playerIds.find((player) => player !== this.state.activePlayer);
    if (defending === undefined) throw new ScenarioError('no defending player');
    return { kind: 'player', player: defending };
  }

  private put(spec: PermanentSpec, zone: ZoneId): ObjectId {
    const created = createObject(this.state, {
      definitionId: definition,
      owner: this.current,
      zone,
      keywords: keywords(spec.keywords ?? {}),
      ...(spec.name !== undefined ? { name: spec.name } : {}),
      ...(spec.power !== undefined ? { power: spec.power } : {}),
      ...(spec.toughness !== undefined ? { toughness: spec.toughness } : {}),
      ...(spec.loyalty !== undefined ? { loyalty: spec.loyalty } : {}),
      ...(spec.legendary !== undefined ? { legendary: spec.legendary } : {}),
      ...(spec.token !== undefined ? { token: spec.token } : {}),
      ...(spec.attachment !== undefined ? { attachment: spec.attachment } : {}),
      ...(spec.triggers !== undefined ? { triggers: spec.triggers } : {}),
      ...(spec.loyaltyAbilities !== undefined ? { loyaltyAbilities: spec.loyaltyAbilities } : {}),
      ...(spec.colours !== undefined ? { colours: spec.colours } : {}),
    });

    // A planeswalker put straight onto the battlefield never resolved off the stack, so
    // it has to be given the loyalty counters entering would have brought (CR 306.5b).
    const counters =
      spec.counters ??
      (zone === 'battlefield' && spec.loyalty !== undefined ? { loyalty: spec.loyalty } : {});

    this.state = updateObject(created.state, created.object.id, {
      tapped: spec.tapped ?? false,
      summoningSick: spec.summoningSick ?? false,
      damage: spec.damage ?? 0,
      deathtouched: spec.deathtouched ?? false,
      counters,
      ...(spec.attachedTo !== undefined ? { attachedTo: this.ref(spec.attachedTo) } : {}),
    });

    if (spec.name !== undefined) {
      if (this.labels.has(spec.name)) {
        // Two permanents can legitimately share a name — that is the legend rule — so
        // suffix rather than refuse, and say what the labels are.
        let n = 2;
        while (this.labels.has(`${spec.name} ${n}`)) n += 1;
        this.labels.set(`${spec.name} ${n}`, created.object.id);
      } else {
        this.labels.set(spec.name, created.object.id);
      }
    }

    return created.object.id;
  }
}

export class ScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScenarioError';
  }
}

/** Start a scenario: `game().player('A').battlefield({ power: 2, toughness: 2 }).start()`. */
export const game = (options: ScenarioOptions = {}): Scenario => new Scenario(options);

/** Every object a player has in a zone, for assertions. */
export const zone = (state: GameState, zoneId: ZoneId): readonly ObjectId[] =>
  objectsIn(state, zoneId);
