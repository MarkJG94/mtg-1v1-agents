import {
  applyEvent,
  type Board,
  type EventTarget,
  emptyBoard,
  type GameEndReason,
  type GameEvent,
  type ObjectId,
  type PlayerId,
} from '@mtg/shared';

/**
 * The event ticker's play-by-play (docs/08 "Game viewer"): a game's events as a person
 * would tell them — "A casts Lightning Bolt targeting Goblin Guide", "B responds with
 * Counterspell" — with the steps, taps and rules machinery a board shows on its own left
 * out. Each line keeps the index of the event it tells, so the ticker can say where the
 * transport is and a click can take it there.
 */

export interface TickerLine {
  /** The event this line tells: the transport is past it once `position > index`. */
  readonly index: number;
  readonly turn: number;
  readonly kind: 'turn' | 'action' | 'event' | 'end';
  readonly player: PlayerId | null;
  readonly text: string;
  /**
   * The deciding player's evaluation of the position as they made the decision this line
   * is the outcome of (docs/05's `impact`), when the log recorded one: positive is good
   * for them.
   */
  readonly score?: number;
}

/** What the narrator needs to know of the game's objects. */
export interface Names {
  /** An object as a person would call it: a card's name, a token's, "Bolt's ability". */
  name(id: ObjectId): string;
  /** Whose an object is, if known. */
  owner(id: ObjectId): PlayerId | null;
}

export interface NarrateOptions {
  /** Whether a player's hidden cards — what they draw — may be named. */
  readonly reveal: (player: PlayerId) => boolean;
}

const stepNames: Record<string, string> = {
  untap: 'untap',
  upkeep: 'upkeep',
  draw: 'draw step',
  precombatMain: 'first main phase',
  beginCombat: 'beginning of combat',
  declareAttackers: 'declare attackers',
  declareBlockers: 'declare blockers',
  firstStrikeDamage: 'first-strike damage',
  combatDamage: 'combat damage',
  endCombat: 'end of combat',
  postcombatMain: 'second main phase',
  end: 'end step',
  cleanup: 'cleanup',
};

export const stepName = (step: string | null): string =>
  step === null ? '' : (stepNames[step] ?? step);

const reasons: Record<GameEndReason, string> = {
  life: 'on life',
  decked: 'by decking',
  poison: 'on poison',
  effect: 'by an effect',
  concede: 'by concession',
  turnCap: 'the turn cap',
  loop: 'an unbreakable loop',
  decisionCap: 'the decision cap',
};

/**
 * Turns events into ticker lines, one at a time, as they arrive. It folds its own board
 * to tell a response from a cast onto an empty stack, and holds two things over from one
 * event to the next: a decision's score until the action it led to, and an activation
 * until it is known whether it went on the stack (a mana ability does not, and is a tap
 * the board already shows rather than a line).
 */
export class Narrator {
  private board: Board = emptyBoard;
  private index = 0;
  private readonly scores = new Map<PlayerId, number>();
  private pendingActivation: {
    line: Omit<TickerLine, 'index' | 'score'>;
    index: number;
  } | null = null;
  readonly lines: TickerLine[] = [];

  constructor(
    private readonly names: Names,
    private readonly options: NarrateOptions,
  ) {}

  push(events: readonly GameEvent[]): void {
    for (const event of events) {
      this.tell(event);
      this.board = applyEvent(this.board, event);
      this.index += 1;
    }
  }

  private add(line: Omit<TickerLine, 'index' | 'score'>, index = this.index): void {
    const score = line.player === null ? undefined : this.takeScore(line.player, line.kind);
    this.lines.push({ ...line, index, ...(score === undefined ? {} : { score }) });
  }

  private takeScore(player: PlayerId, kind: TickerLine['kind']): number | undefined {
    if (kind !== 'action') return undefined;
    const score = this.scores.get(player);
    this.scores.delete(player);
    return score;
  }

  private target(target: EventTarget): string {
    return target.kind === 'player' ? target.player : this.names.name(target.object);
  }

  private targeting(targets: readonly EventTarget[]): string {
    return targets.length === 0
      ? ''
      : ` targeting ${targets.map((target) => this.target(target)).join(' and ')}`;
  }

  private tell(event: GameEvent): void {
    const name = (id: ObjectId) => this.names.name(id);
    const turn = event.turn;
    const pending = this.pendingActivation;
    if (pending !== null) {
      this.pendingActivation = null;
      if (event.type === 'putOnStack') this.add(pending.line, pending.index);
    }

    switch (event.type) {
      case 'gameStart':
        this.add({
          turn,
          kind: 'event',
          player: null,
          text:
            event.chosenBy === null
              ? `${event.onPlay} is on the play`
              : event.chosenBy === event.onPlay
                ? `${event.chosenBy} chooses to play first`
                : `${event.chosenBy} chooses to draw, so ${event.onPlay} plays first`,
        });
        return;
      case 'mulligan':
        this.add({
          turn,
          kind: 'action',
          player: event.player,
          text: `${event.player} mulligans to ${event.toHandSize}`,
        });
        return;
      case 'keep':
        this.add({
          turn,
          kind: 'action',
          player: event.player,
          text:
            event.bottomed.length === 0
              ? `${event.player} keeps ${event.handSize}`
              : `${event.player} keeps ${event.handSize}, putting ${event.bottomed.length} on the bottom`,
        });
        return;
      case 'turnStart':
        this.add({
          turn,
          kind: 'turn',
          player: event.activePlayer,
          text: `Turn ${turn} — ${event.activePlayer}`,
        });
        return;
      case 'draw':
        // Dealing the opening hands, and again for each mulligan, is told by the keep.
        if (turn === 0) return;
        this.add({
          turn,
          kind: 'event',
          player: event.player,
          text: this.options.reveal(event.player)
            ? `${event.player} draws ${name(event.object)}`
            : `${event.player} draws a card`,
        });
        return;
      case 'playLand':
        this.add({
          turn,
          kind: 'action',
          player: event.player,
          text: `${event.player} plays ${name(event.object)}`,
        });
        return;
      case 'cast': {
        // A cast is logged before the spell goes on the stack, so the stack is what it
        // answers.
        const responding = this.board.zones.stack.length > 0;
        const x = event.x === undefined ? '' : ` with X = ${event.x}`;
        this.add({
          turn,
          kind: 'action',
          player: event.player,
          text: `${event.player} ${responding ? 'responds with' : 'casts'} ${name(event.object)}${x}${this.targeting(event.targets)}`,
        });
        return;
      }
      case 'activate':
        // Told once it goes on the stack, with the decision's score then: a mana ability
        // never does, and leaves the score for the spell it paid for.
        this.pendingActivation = {
          index: this.index,
          line: {
            turn,
            kind: 'action',
            player: event.player,
            text: `${event.player} activates ${name(event.source)}${this.targeting(event.targets)}`,
          },
        };
        return;
      case 'trigger':
        this.add({
          turn,
          kind: 'event',
          player: event.controller,
          text: `${name(event.source)} triggers`,
        });
        return;
      case 'resolve':
        this.add({ turn, kind: 'event', player: null, text: `${name(event.object)} resolves` });
        return;
      case 'counter':
        this.add({
          turn,
          kind: 'event',
          player: null,
          text: `${name(event.object)} is countered by ${name(event.by)}`,
        });
        return;
      case 'fizzle':
        this.add({
          turn,
          kind: 'event',
          player: null,
          text: `${name(event.object)} does nothing: its targets are gone`,
        });
        return;
      case 'moveZone': {
        const text = this.moved(event);
        if (text !== null) this.add({ turn, kind: 'event', player: null, text });
        return;
      }
      case 'counterChange': {
        const delta = event.to - event.from;
        if (delta === 0) return;
        const counters = Math.abs(delta) === 1 ? 'counter' : 'counters';
        this.add({
          turn,
          kind: 'event',
          player: null,
          text:
            event.counter === 'loyalty'
              ? `${name(event.object)}: loyalty ${event.from} → ${event.to}`
              : `${name(event.object)} ${delta > 0 ? 'gets' : 'loses'} ${Math.abs(delta)} ${event.counter} ${counters}`,
        });
        return;
      }
      case 'damage':
        this.add({
          turn,
          kind: 'event',
          player: null,
          text: `${name(event.source)} deals ${event.amount} damage to ${this.target(event.target)}`,
        });
        return;
      case 'lifeChange':
        // Damage has its own line; a gain or a loss of life has this one.
        if (event.reason === 'damage') return;
        this.add({
          turn,
          kind: 'event',
          player: event.player,
          text: `${event.player} ${event.to > event.from ? 'gains' : 'loses'} ${Math.abs(event.to - event.from)} life (${event.to})`,
        });
        return;
      case 'poisonChange':
        this.add({
          turn,
          kind: 'event',
          player: event.player,
          text: `${event.player} gets ${event.to - event.from} poison (${event.to})`,
        });
        return;
      case 'attack':
        this.add({
          turn,
          kind: 'action',
          player: this.names.owner(event.attacker),
          text: `${name(event.attacker)} attacks ${this.target(event.defender)}`,
        });
        return;
      case 'block':
        this.add({
          turn,
          kind: 'action',
          player: this.names.owner(event.blocker),
          text: `${name(event.blocker)} blocks ${event.blocking.map(name).join(' and ')}`,
        });
        return;
      case 'sba':
        if (event.kind === 'legendRule') {
          this.add({
            turn,
            kind: 'event',
            player: null,
            text: `the legend rule: ${event.objects.map(name).join(', ')}`,
          });
        }
        return;
      case 'decision':
        if (event.score !== undefined) this.scores.set(event.player, event.score);
        return;
      case 'gameEnd':
        this.add({
          turn,
          kind: 'end',
          player: event.winner,
          text:
            event.winner === null
              ? `A draw: ${reasons[event.reason]}`
              : `${event.winner} wins ${reasons[event.reason]}`,
        });
        return;
      default:
        return;
    }
  }

  /** A zone change worth a line; the rest are told by the event that caused them. */
  private moved(event: Extract<GameEvent, { type: 'moveZone' }>): string | null {
    const name = this.names.name(event.object);
    const owner = this.names.owner(event.object);
    switch (event.cause) {
      case 'destroy':
        return `${name} is destroyed`;
      case 'sacrifice':
        return `${owner ?? 'Its owner'} sacrifices ${name}`;
      case 'discard':
        return `${owner ?? 'Its owner'} discards ${name}`;
      case 'mill':
        return `${name} is milled`;
      case 'exile':
        return `${name} is exiled`;
      case 'return':
        return event.to.endsWith(':hand')
          ? `${name} returns to ${owner ?? 'its owner'}’s hand`
          : `${name} returns to the battlefield`;
      case 'tutor':
        return `${owner ?? 'Its owner'} searches out ${name}`;
      case 'tokenCreated':
        return `${owner ?? 'A player'} creates ${name}`;
      case 'stateBasedAction':
        return event.from === 'battlefield' && event.to.endsWith(':graveyard')
          ? `${name} dies`
          : null;
      case 'effect':
        return event.to === 'exile'
          ? `${name} is exiled`
          : event.to.endsWith(':graveyard') && event.from === 'battlefield'
            ? `${name} is put into the graveyard`
            : null;
      default:
        return null;
    }
  }
}
