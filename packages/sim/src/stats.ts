import { type CardDefinition, manaValue } from '@mtg/engine';
import {
  type AgentCounts,
  addCounts,
  type CardCounts,
  type Colour,
  type DeckCounts,
  emptyAgentCounts,
  emptyCardCounts,
  type GameEventLog,
  kindOfZone,
  type MatchupCounts,
  type ObjectId,
  type OracleId,
  opponentOf,
  ownerOfZone,
  type PlayerId,
  playerIds,
  type Tally,
} from '@mtg/shared';
import { sideboardCardFor } from './sideboard-cards.js';

/**
 * The statistics aggregator (docs/05 "Statistics"; roadmap 5.2): one game's event log
 * read into each player's counts, which add into a cycle's and roll up across cycles.
 *
 * It reads the log alone — no engine, no replay — replaying just enough of it to know
 * what was in each hand and on each battlefield when. The definitions it needs are the
 * cards' printed facts (a land or not, its cost and colours, the colours it makes),
 * passed in, since a log names cards by id and oracle id only.
 *
 * How each statistic is read, where docs/05 leaves a choice:
 *
 * - **Drawn** means in hand at any point *after the hand was kept* — the kept hand, then
 *   every draw and anything returned to hand. A hand mulliganed away does not count as
 *   drawn; it counts toward `mulliganBlame` instead.
 * - **Cast** includes playing a land, which is how a land is used.
 * - **Dead in hand**: a copy still in hand when the game ended.
 * - **Turn of first cast** is counted in the player's own turns, so a deck on the draw is
 *   not charged a turn for it.
 * - **Impact** is the change in the caster's evaluator score from its last decision
 *   before casting to its first decision after the spell resolved — the scores are the
 *   `decision` events `playGame` records when asked to.
 * - **Screw and flood** count lands on the battlefield at the end of the player's fourth
 *   and eighth turns, and only games that got that far are in the denominator.
 * - **Colour screw**: at the end of one of its turns the player held a spell it had the
 *   lands to pay for, but not in the colours it needed.
 */

/** What the aggregator needs to know about a card. */
export interface CardFacts {
  readonly land: boolean;
  readonly manaValue: number;
  readonly costColours: readonly Colour[];
  /** Colours it can make, for a land. */
  readonly produces: readonly Colour[];
}

export const cardFactsFor = (definition: CardDefinition): CardFacts => {
  const card = sideboardCardFor(definition);
  return {
    land: card.land,
    manaValue: manaValue(definition.manaCost),
    costColours: card.costColours,
    produces: card.produces,
  };
};

interface Seat {
  hand: Set<ObjectId>;
  /** Draws since the last deal, before the hand is kept: the hand a mulligan deals. */
  redeal: ObjectId[];
  kept: boolean;
  seen: Set<OracleId>;
  mulliganed: Set<OracleId>;
  cast: Set<OracleId>;
  firstCastTurn: Map<OracleId, number>;
  lands: Set<ObjectId>;
  turns: number;
  landsAtEndOfTurn: Map<number, number>;
  colourScrewed: boolean;
  lastScore: number | undefined;
  /** Spells that have resolved, waiting for the caster's next score. */
  resolved: { oracleId: OracleId; before: number }[];
  impact: Map<OracleId, { sum: number; count: number }>;
}

const newSeat = (): Seat => ({
  hand: new Set(),
  redeal: [],
  kept: false,
  seen: new Set(),
  mulliganed: new Set(),
  cast: new Set(),
  firstCastTurn: new Map(),
  lands: new Set(),
  turns: 0,
  landsAtEndOfTurn: new Map(),
  colourScrewed: false,
  lastScore: undefined,
  resolved: [],
  impact: new Map(),
});

const SCREW_TURN = 4;
const SCREW_BELOW = 3;
const FLOOD_TURN = 8;
const FLOOD_ABOVE = 7;

export class UnknownCardError extends Error {
  constructor(oracleId: OracleId) {
    super(`the aggregator was not told about ${oracleId}`);
    this.name = 'UnknownCardError';
  }
}

/** One game's counts for each player. */
export const countsOfGame = (
  log: GameEventLog,
  facts: ReadonlyMap<OracleId, CardFacts>,
): Record<PlayerId, AgentCounts> => {
  const objects = new Map(log.objects.map((object) => [object.id, object]));
  const oracleOf = (id: ObjectId): OracleId | undefined => objects.get(id)?.oracleId;
  const factsOf = (id: ObjectId): CardFacts | undefined => {
    const oracleId = oracleOf(id);
    return oracleId === undefined ? undefined : facts.get(oracleId);
  };
  const seats: Record<PlayerId, Seat> = { A: newSeat(), B: newSeat() };
  const castBy = new Map<ObjectId, { player: PlayerId; before: number | undefined }>();
  let started = false;
  let onPlay: PlayerId = 'A';
  let active: PlayerId | null = null;

  const see = (seat: Seat, id: ObjectId) => {
    seat.hand.add(id);
    const oracleId = oracleOf(id);
    if (seat.kept && oracleId !== undefined) seat.seen.add(oracleId);
  };

  const endTurn = (player: PlayerId) => {
    const seat = seats[player];
    seat.landsAtEndOfTurn.set(seat.turns, seat.lands.size);
    const made = new Set<Colour>();
    for (const land of seat.lands)
      for (const colour of factsOf(land)?.produces ?? []) made.add(colour);
    for (const id of seat.hand) {
      const card = factsOf(id);
      if (card === undefined || card.land || card.manaValue > seat.lands.size) continue;
      if (card.costColours.some((colour) => !made.has(colour))) seat.colourScrewed = true;
    }
  };

  const castNow = (player: PlayerId, id: ObjectId) => {
    const seat = seats[player];
    seat.hand.delete(id);
    const oracleId = oracleOf(id);
    if (oracleId === undefined) return;
    seat.cast.add(oracleId);
    if (!seat.firstCastTurn.has(oracleId)) seat.firstCastTurn.set(oracleId, seat.turns);
  };

  for (const event of log.events) {
    switch (event.type) {
      case 'gameStart':
        started = true;
        onPlay = event.onPlay;
        for (const player of playerIds) seats[player].hand = new Set(event.decks[player].hand);
        break;
      case 'draw':
        // The first deal is in `gameStart`; draws before it are that deal.
        if (!started) break;
        if (seats[event.player].kept) see(seats[event.player], event.object);
        else seats[event.player].redeal.push(event.object);
        break;
      case 'mulligan': {
        const seat = seats[event.player];
        for (const id of seat.hand) {
          const oracleId = oracleOf(id);
          if (oracleId !== undefined) seat.mulliganed.add(oracleId);
        }
        seat.hand = new Set(seat.redeal);
        seat.redeal = [];
        break;
      }
      case 'keep': {
        const seat = seats[event.player];
        for (const id of event.bottomed) seat.hand.delete(id);
        seat.kept = true;
        for (const id of seat.hand) see(seat, id);
        break;
      }
      case 'turnStart':
        if (active !== null) endTurn(active);
        active = event.activePlayer;
        seats[active].turns += 1;
        break;
      case 'cast':
        castNow(event.player, event.object);
        castBy.set(event.object, { player: event.player, before: seats[event.player].lastScore });
        break;
      case 'playLand':
        castNow(event.player, event.object);
        break;
      case 'resolve': {
        const caster = castBy.get(event.object);
        const oracleId = oracleOf(event.object);
        if (caster?.before !== undefined && oracleId !== undefined) {
          seats[caster.player].resolved.push({ oracleId, before: caster.before });
        }
        break;
      }
      case 'decision': {
        const seat = seats[event.player];
        if (event.score === undefined) break;
        for (const { oracleId, before } of seat.resolved) {
          const entry = seat.impact.get(oracleId) ?? { sum: 0, count: 0 };
          seat.impact.set(oracleId, {
            sum: entry.sum + event.score - before,
            count: entry.count + 1,
          });
        }
        seat.resolved = [];
        seat.lastScore = event.score;
        break;
      }
      case 'moveZone': {
        const from = ownerOfZone(event.from);
        if (from !== null && kindOfZone(event.from) === 'hand')
          seats[from].hand.delete(event.object);
        const to = ownerOfZone(event.to);
        if (to !== null && kindOfZone(event.to) === 'hand') see(seats[to], event.object);
        const owner = objects.get(event.object)?.owner;
        if (owner !== undefined && factsOf(event.object)?.land === true) {
          if (event.to === 'battlefield') seats[owner].lands.add(event.object);
          if (event.from === 'battlefield') seats[owner].lands.delete(event.object);
        }
        break;
      }
      case 'gameEnd':
        if (active !== null) endTurn(active);
        active = null;
        break;
      default:
        break;
    }
  }

  const counts = {} as Record<PlayerId, AgentCounts>;
  for (const player of playerIds) {
    const seat = seats[player];
    const won = log.result.winner === player;
    const tally = (t: Tally): Tally => ({ games: t.games + 1, wins: t.wins + (won ? 1 : 0) });
    const landsAt = (turn: number) => seat.landsAtEndOfTurn.get(turn);

    const screw = landsAt(SCREW_TURN);
    const flood = landsAt(FLOOD_TURN);
    const deck: DeckCounts = {
      games: 1,
      wins: won ? 1 : 0,
      turns: log.result.turns,
      onPlay: onPlay === player ? tally({ games: 0, wins: 0 }) : { games: 0, wins: 0 },
      onDraw: onPlay === player ? { games: 0, wins: 0 } : tally({ games: 0, wins: 0 }),
      screwed: screw !== undefined && screw < SCREW_BELOW ? 1 : 0,
      screwChances: screw === undefined ? 0 : 1,
      flooded: flood !== undefined && flood > FLOOD_ABOVE ? 1 : 0,
      floodChances: flood === undefined ? 0 : 1,
      colourScrewed: seat.colourScrewed ? 1 : 0,
    };

    const inHandAtEnd = new Set<OracleId>();
    for (const id of seat.hand) {
      const oracleId = oracleOf(id);
      if (oracleId !== undefined) inHandAtEnd.add(oracleId);
    }

    const cards: Record<OracleId, CardCounts> = {};
    const matchup: Record<OracleId, MatchupCounts> = {};
    for (const slot of log.players[player].main) {
      if (!facts.has(slot.oracleId)) throw new UnknownCardError(slot.oracleId);
      const drawn = seat.seen.has(slot.oracleId);
      const cast = drawn && seat.cast.has(slot.oracleId);
      const first = seat.firstCastTurn.get(slot.oracleId);
      const impact = seat.impact.get(slot.oracleId);
      const none: Tally = { games: 0, wins: 0 };
      cards[slot.oracleId] = {
        ...emptyCardCounts,
        games: 1,
        drawn: drawn ? tally(none) : none,
        notDrawn: drawn ? none : tally(none),
        cast: cast ? 1 : 0,
        deadInHand: inHandAtEnd.has(slot.oracleId) ? 1 : 0,
        firstCastTurns: cast && first !== undefined ? first : 0,
        firstCasts: cast && first !== undefined ? 1 : 0,
        impact: impact?.sum ?? 0,
        impacts: impact?.count ?? 0,
        mulliganed: seat.mulliganed.has(slot.oracleId) ? 1 : 0,
      };
      matchup[slot.oracleId] = {
        drawn: drawn ? tally(none) : none,
        notDrawn: drawn ? none : tally(none),
      };
    }
    const opponent = log.players[opponentOf(player)].deckGeneration;
    counts[player] = { deck, cards, matchups: { [opponent]: matchup } };
  }
  return counts;
};

/** A cycle's counts, game by game: add each game's as it finishes and drop its log. */
export class StatsAccumulator {
  private counts: Record<PlayerId, AgentCounts> = { A: emptyAgentCounts, B: emptyAgentCounts };

  constructor(private readonly facts: ReadonlyMap<OracleId, CardFacts>) {}

  add(log: GameEventLog): void {
    const game = countsOfGame(log, this.facts);
    for (const player of playerIds)
      this.counts[player] = addCounts(this.counts[player], game[player]);
  }

  get totals(): Readonly<Record<PlayerId, AgentCounts>> {
    return this.counts;
  }
}
