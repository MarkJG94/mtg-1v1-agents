import type { GameEvent, ObjectId, PlayerId, Step, ZoneName } from '@mtg/shared';
import { characteristics } from '../characteristics.js';
import type { CardDefinition } from '../definition.js';
import { beginDraft, finishDraft, getObj, obj } from '../draft.js';
import { advance, step as engineStep, initialState } from '../game.js';
import { Rng } from '../rng.js';
import type {
  Action,
  Characteristics,
  Decision,
  DecisionAnswer,
  GameConfig,
  GameObject,
  GameState,
  TargetRef,
} from '../state.js';
import { createObject } from '../zones.js';
import { randomAnswer } from './random.js';

type ZoneSpec = Exclude<ZoneName, 'stack'>;

interface PlacedCard {
  player: PlayerId;
  zone: ZoneSpec;
  name: string;
  tapped: boolean;
  sick: boolean;
  counters: Record<string, number>;
  attachedTo: string | null;
  damage: number;
}

export interface CardOptions {
  tapped?: boolean;
  /** Summoning sick (default false for battlefield cards in scenarios). */
  sick?: boolean;
  counters?: Record<string, number>;
  attachedTo?: string;
  damage?: number;
}

/** Fluent builder for engine tests: places cards, starts at a chosen step with priority, and drives decisions by name. */
export class ScenarioBuilder {
  private cards: PlacedCard[] = [];
  private current: PlayerId = 'A';
  private lives: Record<PlayerId, number> = { A: 20, B: 20 };
  private turnNumber = 3;
  private active: PlayerId = 'A';
  private startStep: Step = 'main1';
  private seed: string | number = 'scenario';
  private configOverrides: Partial<GameConfig> = {};

  constructor(private readonly definitions: Record<string, CardDefinition>) {}

  player(p: PlayerId): this {
    this.current = p;
    return this;
  }

  private place(zone: ZoneSpec, names: (string | [string, CardOptions])[]): this {
    for (const n of names) {
      const [name, opts] = typeof n === 'string' ? [n, {}] : n;
      this.cards.push({
        player: this.current,
        zone,
        name,
        tapped: opts.tapped ?? false,
        sick: opts.sick ?? false,
        counters: opts.counters ?? {},
        attachedTo: opts.attachedTo ?? null,
        damage: opts.damage ?? 0,
      });
    }
    return this;
  }

  hand(...names: (string | [string, CardOptions])[]): this {
    return this.place('hand', names);
  }
  battlefield(...names: (string | [string, CardOptions])[]): this {
    return this.place('battlefield', names);
  }
  graveyard(...names: string[]): this {
    return this.place('graveyard', names);
  }
  exile(...names: string[]): this {
    return this.place('exile', names);
  }
  /** Library cards, top first. */
  library(...names: string[]): this {
    return this.place('library', names);
  }
  life(n: number): this {
    this.lives[this.current] = n;
    return this;
  }
  turn(n: number): this {
    this.turnNumber = n;
    return this;
  }
  activePlayer(p: PlayerId): this {
    this.active = p;
    return this;
  }
  step(s: Step): this {
    this.startStep = s;
    return this;
  }
  withSeed(seed: string | number): this {
    this.seed = seed;
    return this;
  }
  config(c: Partial<GameConfig>): this {
    this.configOverrides = { ...this.configOverrides, ...c };
    return this;
  }

  private defIdFor(name: string): string {
    if (this.definitions[name]) return name;
    for (const [id, def] of Object.entries(this.definitions)) if (def.name === name) return id;
    throw new Error(`No card definition named ${name}`);
  }

  start(): Scenario {
    const base = initialState({
      definitions: this.definitions,
      seed: this.seed,
      config: { mulligans: false, ...this.configOverrides },
      onPlay: this.active,
    });
    const d = beginDraft(base);
    d.started = true;
    d.turn = this.turnNumber;
    d.activePlayer = this.active;
    d.step = this.startStep;
    d.players.A.life = this.lives.A;
    d.players.B.life = this.lives.B;
    const ids = new Map<PlacedCard, ObjectId>();
    for (const c of this.cards) {
      const id = createObject(d, this.defIdFor(c.name), c.player, c.zone);
      ids.set(c, id);
      const o = obj(d, id);
      o.enteredThisTurn = false;
      if (c.zone === 'battlefield') {
        o.tapped = c.tapped;
        o.sick = c.sick;
        o.damage = c.damage;
        for (const [k, v] of Object.entries(c.counters)) o.counters[k] = v;
        const def = this.definitions[this.defIdFor(c.name)]!;
        if (def.loyalty !== undefined && o.counters.loyalty === undefined)
          o.counters.loyalty = def.loyalty;
      }
    }
    for (const c of this.cards) {
      if (!c.attachedTo) continue;
      const host = this.cards.find((x) => x.name === c.attachedTo && x.zone === 'battlefield');
      if (!host) throw new Error(`attachedTo: no ${c.attachedTo} on the battlefield`);
      const id = ids.get(c)!;
      const hostId = ids.get(host)!;
      obj(d, id).attachedTo = hostId;
      obj(d, hostId).attachments.push(id);
    }
    // Priority to the active player at the chosen step; turn-based actions of the step are not replayed.
    d.priority = this.active;
    if (this.startStep === 'declareAttackers')
      d.frames.push({ k: 'declareAttackers', stage: 'declare' });
    advance(d);
    const { state, events } = finishDraft(d);
    return new Scenario(state, events, this.definitions);
  }
}

export interface CastOptions {
  /** Targets per target group, each a card name, 'A'/'B' for players, or `{ spell: name }` for a spell on the stack. */
  targets?: (string | string[])[];
  x?: number;
  mode?: number;
  alternative?: boolean;
  /** Answers for `chooseObjects` decisions raised while paying costs (sacrifice/discard), by card name. */
  choose?: string[];
}

/** A running scenario. Every driver method returns `this`; inspect `state` or use the accessors. */
export class Scenario {
  events: GameEvent[];
  readonly rng = Rng.from('scenario');

  constructor(
    public state: GameState,
    events: GameEvent[],
    private readonly definitions: Record<string, CardDefinition>,
  ) {
    this.events = events;
  }

  get decision(): Decision {
    if (!this.state.pendingDecision)
      throw new Error(`no pending decision (result: ${JSON.stringify(this.state.result)})`);
    return this.state.pendingDecision;
  }

  answer(answer: DecisionAnswer): this {
    const r = engineStep(this.state, answer);
    this.state = r.state;
    this.events.push(...r.events);
    return this;
  }

  // ---- lookup helpers ----------------------------------------------------------------------

  private nameOf(id: ObjectId): string {
    const o = this.state.objects[id];
    if (!o) return '?';
    return (
      (
        this.state.definitions[o.copyOf ?? o.definitionId] ??
        this.definitions[o.copyOf ?? o.definitionId]
      )?.name ?? o.definitionId
    );
  }

  /** All object ids with this name (optionally restricted to an owner/zone), in id order. */
  findAll(name: string, opts: { player?: PlayerId; zone?: ZoneName } = {}): ObjectId[] {
    const out: ObjectId[] = [];
    for (const o of Object.values(this.state.objects)) {
      if (this.nameOf(o.id) !== name) continue;
      if (
        opts.player &&
        o.owner !== opts.player &&
        !(opts.zone === 'battlefield' && o.controller === opts.player)
      )
        continue;
      if (opts.zone && o.zone !== opts.zone) continue;
      out.push(o.id);
    }
    return out.sort((a, b) => a - b);
  }

  /** The n-th (0-based) object with this name. */
  find(name: string, index = 0, opts: { player?: PlayerId; zone?: ZoneName } = {}): ObjectId {
    const all = this.findAll(name, opts);
    const id = all[index];
    if (id === undefined) throw new Error(`No object named ${name} (index ${index})`);
    return id;
  }

  object(name: string, index = 0): GameObject {
    return getObj(this.state, this.find(name, index));
  }

  chars(name: string, index = 0): Characteristics {
    return characteristics(this.state, this.find(name, index));
  }

  zoneOf(name: string, index = 0): ZoneName {
    return this.object(name, index).zone;
  }

  zone(player: PlayerId, zone: Exclude<ZoneName, 'stack'>): string[] {
    return this.state.zones[player][zone].map((id) => this.nameOf(id));
  }

  life(player: PlayerId): number {
    return this.state.players[player].life;
  }

  get stackNames(): string[] {
    return this.state.stack.map((s) =>
      s.kind === 'spell' ? this.nameOf(s.source.id) : `${this.nameOf(s.source.id)}:${s.kind}`,
    );
  }

  private targetRef(t: string): TargetRef {
    if (t === 'A' || t === 'B') return { kind: 'player', player: t };
    if (t.startsWith('spell:')) {
      const name = t.slice(6);
      const item = this.state.stack.find(
        (s) => s.kind === 'spell' && this.nameOf(s.source.id) === name,
      );
      if (!item) throw new Error(`no spell ${name} on the stack`);
      return { kind: 'stack', stackId: item.stackId };
    }
    if (t.startsWith('ability:')) {
      const name = t.slice(8);
      const item = this.state.stack.find(
        (s) => s.kind !== 'spell' && this.nameOf(s.source.id) === name,
      );
      if (!item) throw new Error(`no ability of ${name} on the stack`);
      return { kind: 'stack', stackId: item.stackId };
    }
    const m = /^(.*)#(\d+)$/.exec(t);
    const id = m ? this.find(m[1]!, Number(m[2])) : this.find(t);
    return { kind: 'object', id, instance: getObj(this.state, id).instance };
  }

  // ---- drivers -------------------------------------------------------------------------------

  private priorityPlayer(): PlayerId {
    const dec = this.decision;
    if (dec.kind !== 'priority') throw new Error(`expected priority decision, got ${dec.kind}`);
    return dec.player;
  }

  private takeAction(pick: (a: Action) => boolean, what: string): this {
    const dec = this.decision;
    if (dec.kind !== 'priority') throw new Error(`expected priority decision, got ${dec.kind}`);
    const action = dec.actions.find(pick);
    if (!action)
      throw new Error(
        `${what} is not a legal action for ${dec.player}. Legal: ${dec.actions.map((a) => JSON.stringify(a)).join(', ')}`,
      );
    return this.answer({ kind: 'priority', action });
  }

  /** Answers follow-up decisions (targets, X, modes, cost choices) until priority returns. */
  private finishWith(opts: CastOptions): this {
    let guard = 0;
    while (this.state.pendingDecision && this.state.pendingDecision.kind !== 'priority') {
      if (++guard > 50) throw new Error('too many follow-up decisions');
      const dec = this.state.pendingDecision;
      switch (dec.kind) {
        case 'chooseTargets': {
          const groups = opts.targets ?? [];
          const targets: TargetRef[][] = dec.specs.map((_, i) => {
            const g = groups[i];
            if (g === undefined) return [];
            return (Array.isArray(g) ? g : [g]).map((t) => this.targetRef(t));
          });
          this.answer({ kind: 'chooseTargets', targets });
          break;
        }
        case 'chooseX':
          this.answer({ kind: 'chooseX', x: opts.x ?? dec.max });
          break;
        case 'chooseMode':
          this.answer({ kind: 'chooseMode', modes: [opts.mode ?? 0] });
          break;
        case 'chooseObjects': {
          const names = opts.choose ?? [];
          const objects =
            names.length > 0
              ? names.map((n) => this.targetRef(n)).map((r) => (r.kind === 'object' ? r.id : -1))
              : dec.options.slice(0, dec.min);
          this.answer({ kind: 'chooseObjects', objects });
          break;
        }
        default:
          this.answer(randomAnswer(this.state, dec, this.rng));
      }
    }
    return this;
  }

  cast(name: string, opts: CastOptions = {}): this {
    const player = this.priorityPlayer();
    const id = this.find(name, 0, { player, zone: 'hand' });
    this.takeAction(
      (a) =>
        a.kind === 'cast' &&
        a.object === id &&
        Boolean(a.alternative) === Boolean(opts.alternative),
      `cast ${name}`,
    );
    return this.finishWith(opts);
  }

  playLand(name: string): this {
    const player = this.priorityPlayer();
    const id = this.find(name, 0, { player, zone: 'hand' });
    return this.takeAction((a) => a.kind === 'playLand' && a.object === id, `play ${name}`);
  }

  activate(name: string, ability: number, opts: CastOptions = {}): this {
    const id = this.targetRef(name);
    if (id.kind !== 'object') throw new Error('activate needs an object');
    this.takeAction(
      (a) =>
        (a.kind === 'activate' || a.kind === 'loyalty') &&
        a.source === id.id &&
        a.ability === ability,
      `activate ${name}#${ability}`,
    );
    return this.finishWith(opts);
  }

  activateMana(name: string, ability = 0, option = 0): this {
    const id = this.targetRef(name);
    if (id.kind !== 'object') throw new Error('activateMana needs an object');
    this.takeAction(
      (a) => a.kind === 'activateMana' && a.source === id.id && a.ability === ability,
      `tap ${name}`,
    );
    if (this.state.pendingDecision?.kind === 'chooseOption')
      this.answer({ kind: 'chooseOption', option });
    return this;
  }

  /** The player with priority passes. */
  pass(): this {
    this.priorityPlayer();
    return this.answer({ kind: 'priority', action: { kind: 'pass' } });
  }

  /** Both players pass: resolves the top of the stack, or advances the step when the stack is empty. */
  passBoth(): this {
    return this.pass().pass();
  }

  /** Passes until the stack is empty and a player has priority. Non-priority decisions are answered by `auto`. */
  resolveAll(auto: (dec: Decision) => DecisionAnswer = (dec) => this.defaultAnswer(dec)): this {
    let guard = 0;
    while (this.state.stack.length > 0 && !this.state.result) {
      if (++guard > 200) throw new Error('resolveAll did not converge');
      const dec = this.decision;
      if (dec.kind === 'priority') this.pass();
      else this.answer(auto(dec));
    }
    while (
      this.state.pendingDecision &&
      this.state.pendingDecision.kind !== 'priority' &&
      !this.state.result
    ) {
      this.answer(auto(this.decision));
    }
    return this;
  }

  /** Reasonable default answers for decisions raised while advancing: no attacks, no blocks, first options. */
  defaultAnswer(dec: Decision): DecisionAnswer {
    switch (dec.kind) {
      case 'declareAttackers':
        return {
          kind: 'declareAttackers',
          attacks: dec.required.map((a) => ({
            attacker: a,
            defender: dec.candidates.find((c) => c.attacker === a)!.defenders[0]!,
          })),
        };
      case 'declareBlockers':
        return { kind: 'declareBlockers', blocks: [] };
      case 'yesNo':
        return { kind: 'yesNo', yes: true };
      case 'chooseObjects':
        return { kind: 'chooseObjects', objects: dec.options.slice(0, dec.min) };
      case 'chooseCardsFromLibrary':
        return { kind: 'chooseCardsFromLibrary', cards: dec.options.slice(0, dec.max) };
      case 'mulligan':
        return { kind: 'mulligan', keep: true };
      default:
        return randomAnswer(this.state, dec, this.rng);
    }
  }

  /** Advances (both players passing, default answers) until the given step of the given turn is reached with priority. */
  toStep(step: Step, opts: { turn?: number; player?: PlayerId } = {}): this {
    let guard = 0;
    for (;;) {
      if (++guard > 2000) throw new Error(`toStep(${step}) did not converge`);
      if (this.state.result) throw new Error(`game ended: ${JSON.stringify(this.state.result)}`);
      const dec = this.decision;
      const atStep =
        this.state.step === step &&
        (opts.turn === undefined || this.state.turn === opts.turn) &&
        (opts.player === undefined || this.state.activePlayer === opts.player);
      if (dec.kind === 'priority') {
        if (atStep && this.state.stack.length === 0 && dec.player === this.state.activePlayer)
          return this;
        this.pass();
      } else if (atStep) {
        return this;
      } else this.answer(this.defaultAnswer(dec));
    }
  }

  /** Advances to the next turn's first main phase. */
  nextTurn(): this {
    const t = this.state.turn + 1;
    return this.toStep('main1', { turn: t });
  }

  /** Moves to the declare attackers step of the current turn and declares the given attacks. */
  attack(attacks: (string | [string, string])[]): this {
    this.toStep('declareAttackers');
    const dec = this.decision;
    if (dec.kind === 'priority')
      throw new Error('no attackers decision (no creatures can attack?)');
    if (dec.kind !== 'declareAttackers')
      throw new Error(`expected declareAttackers, got ${dec.kind}`);
    const list = attacks.map((a) => {
      const [name, def] = typeof a === 'string' ? [a, undefined] : a;
      const attacker = this.targetRef(name);
      if (attacker.kind !== 'object') throw new Error('bad attacker');
      const cand = dec.candidates.find((c) => c.attacker === attacker.id);
      if (!cand) throw new Error(`${name} cannot attack`);
      const defender =
        def === undefined ? cand.defenders[0]! : def === 'A' || def === 'B' ? def : this.find(def);
      return { attacker: attacker.id, defender };
    });
    return this.answer({ kind: 'declareAttackers', attacks: list });
  }

  /** Advances to declare blockers and declares blocks as [blocker, attacker] pairs. */
  block(blocks: [string, string][]): this {
    this.toStep('declareBlockers');
    const dec = this.decision;
    if (dec.kind !== 'declareBlockers')
      throw new Error(`expected declareBlockers, got ${dec.kind}`);
    const list = blocks.map(([b, a]) => {
      const blocker = this.targetRef(b);
      const attacker = this.targetRef(a);
      if (blocker.kind !== 'object' || attacker.kind !== 'object') throw new Error('bad block');
      return { blocker: blocker.id, attacker: attacker.id };
    });
    return this.answer({ kind: 'declareBlockers', blocks: list });
  }

  /** Runs combat damage (answering ordering/assignment decisions with defaults) and returns at end of combat. */
  finishCombat(): this {
    return this.toStep('endCombat');
  }
}

export function scenario(definitions: Record<string, CardDefinition>): ScenarioBuilder {
  return new ScenarioBuilder(definitions);
}
