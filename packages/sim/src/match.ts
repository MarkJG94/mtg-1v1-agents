import type { PlayAgent, SideboardPlan } from '@mtg/agents';
import type { CardDefinition, DecisionResponse, GameState } from '@mtg/engine';
import type { PlayerView } from '@mtg/engine/view';
import {
  type DeckChange,
  type DeckSlot,
  type GameEvent,
  type GameEventLog,
  type GameResult,
  isHiddenZone,
  type OracleId,
  opponentOf,
  type PlayerId,
  playerIds,
} from '@mtg/shared';
import { cardCount, cardsIn, type Deck, deckBoard } from './deck.js';
import { eventLogOf } from './event-log.js';
import { playGame } from './game.js';

/**
 * A best-of-three match between two decks (docs/05 "The cycle"; roadmap 5.1).
 *
 * **Who plays first** is chosen, not assigned (CR 103.1): in the first game by the player
 * the cycle names — it alternates from match to match — and after that by the loser of
 * the previous game, or, if that game was a draw, by whoever chose in it. The chooser's
 * own agent answers, so a deck whose record says it wins more on the draw can take it.
 *
 * **A drawn game counts for neither player**, and the match stops at two wins or three
 * games, whichever comes first: the player with more wins takes the match, and level
 * wins after three games is a drawn match.
 *
 * **Sideboarding** happens once, between games 2 and 3, and only if there is a game 3
 * (docs/04). Each player's hook is shown what the opponent has been seen to play so far
 * and returns the deck for the last game; the swap has to keep the same seventy-five and
 * the same sixty, or the match refuses it. The deck each player registered is what the
 * next match starts from — a sideboarded deck lasts one game.
 *
 * **A ban** takes effect when the game in progress ends (docs/05, roadmap 5.5): after
 * every game the match asks `afterGame`, and if that legalises a deck the match goes on
 * with it — the games already played still count, and sideboarding for game 3 starts
 * from the legalised deck. The match is asynchronous because legalisation is: it searches
 * the card pool, which scripts cards on demand.
 */

export interface SideboardContext {
  /** The deck registered for the match. */
  readonly deck: Deck;
  /** What the opponent has been seen to play in this match, summed over its games. */
  readonly opponentSeen: readonly DeckSlot[];
  /** The games so far, from which the hook can tell how the match is going. */
  readonly games: readonly MatchGame[];
  readonly player: PlayerId;
}

export interface MatchPlayer {
  readonly deck: Deck;
  readonly agent: PlayAgent;
  /** Between games 2 and 3. Without one, the player keeps its deck. */
  readonly sideboard?: (context: SideboardContext) => SideboardPlan;
}

export interface MatchOptions {
  readonly players: Readonly<Record<PlayerId, MatchPlayer>>;
  readonly definitions: ReadonlyMap<OracleId, CardDefinition>;
  /** Game seeds are `${seed}:game-${n}`, so a match is a pure function of its seed. */
  readonly seed: string;
  /** Who chooses who plays first in game 1. */
  readonly firstChooser: PlayerId;
  readonly turnCap: number;
  /** Each player's deck generation, for the logs (docs/05); 0 if not given. */
  readonly generations?: Readonly<Record<PlayerId, number>>;
  /** Scores each decision's position for the log's `decision` events (see `playGame`). */
  readonly score?: (view: PlayerView) => number;
  /** Handed each game's event log as it finishes; the match keeps none of them. */
  readonly onGame?: (log: GameEventLog) => void;
  /**
   * Asked after every game whether the decks have to change before the next: a ban that
   * takes effect "at the end of the game currently in progress" (docs/05), whose match
   * goes on with the legalised decks. See `banEnforcer`.
   */
  readonly afterGame?: AfterGame;
  /** A viewer of the games as they are played (docs/07); nothing is sent unless it is watching. */
  readonly live?: LiveGames;
}

/** A game starting, as a live viewer is told of it (docs/07 `gameStart`). */
export interface LiveGameStart {
  readonly seed: string;
  /** From 1 within the match. */
  readonly game: number;
  /** Who chooses to play or draw (CR 103.1); the choice is an event of the game. */
  readonly chooser: PlayerId;
  /** The sixty each player plays this game, which game 3's sideboarding may have changed. */
  readonly decks: Readonly<Record<PlayerId, readonly DeckSlot[]>>;
  readonly generations: Readonly<Record<PlayerId, number>>;
  /** Where it is, when the cycle and the run say. */
  readonly cycle?: number;
  readonly match?: number;
}

/** A game over, as a live viewer is told of it (docs/07 `gameEnd`). */
export interface LiveGameEnd {
  readonly seed: string;
  readonly onPlay: PlayerId;
  readonly result: GameResult | null;
}

/**
 * Someone watching the games as they are played. `watching` is asked as each game starts,
 * and a game nobody is watching as it starts is not streamed at all — the simulation never
 * waits for a viewer, and pays nothing for one that is not there.
 */
export interface LiveGames {
  watching(): boolean;
  started(game: LiveGameStart): void;
  event(event: GameEvent): void;
  ended(game: LiveGameEnd): void;
}

/** Called with the game that just ended and the decks registered for the match. */
export type AfterGame = (context: {
  readonly gameId: string;
  readonly decks: Readonly<Record<PlayerId, Deck>>;
}) => Promise<DeckUpdate | null>;

/** New registered decks, the definitions any new card in them needs, and why. */
export interface DeckUpdate {
  readonly decks: Readonly<Record<PlayerId, Deck>>;
  readonly definitions: ReadonlyMap<OracleId, CardDefinition>;
  readonly changes: Readonly<Record<PlayerId, readonly DeckChange[]>>;
}

/** Changes forced on the decks between two games, and after which. */
export interface Legalisation {
  readonly afterGameId: string;
  readonly changes: Readonly<Record<PlayerId, readonly DeckChange[]>>;
}

export interface MatchGame {
  readonly seed: string;
  readonly chooser: PlayerId;
  /** Who took the first turn, as the chooser decided. */
  readonly onPlay: PlayerId;
  /** `null` only if the game was stopped without one, which `playGame` does not do. */
  readonly result: GameResult | null;
  /** The main decks the game was played with, which differ from the registered ones in game 3. */
  readonly decks: Readonly<Record<PlayerId, readonly DeckSlot[]>>;
  /** Every decision, so the game can be replayed from its seed. */
  readonly decisions: readonly DecisionResponse[];
}

export interface MatchResult {
  readonly games: readonly MatchGame[];
  readonly wins: Readonly<Record<PlayerId, number>>;
  /** `null` for a drawn match. */
  readonly winner: PlayerId | null;
  /** What each player sided in for game 3, if there was one and it had a hook. */
  readonly sideboarding: Readonly<Record<PlayerId, SideboardPlan | null>>;
  /** The decks registered at the end: the ones it started with, unless a ban changed them. */
  readonly decks: Readonly<Record<PlayerId, Deck>>;
  readonly legalisations: readonly Legalisation[];
  /**
   * What each player showed the other, summed over the match's games: its cards that ended
   * a game somewhere public (docs/04 "Opponent modelling").
   */
  readonly shown: Readonly<Record<PlayerId, readonly DeckSlot[]>>;
}

export class IllegalSideboardError extends Error {
  constructor(player: PlayerId, why: string) {
    super(`${player}'s sideboard plan is not a legal swap: ${why}`);
    this.name = 'IllegalSideboardError';
  }
}

const WINS_NEEDED = 2;
const MOST_GAMES = 3;

export const playMatch = async (options: MatchOptions): Promise<MatchResult> => {
  const games: MatchGame[] = [];
  const wins: Record<PlayerId, number> = { A: 0, B: 0 };
  const sideboarding: Record<PlayerId, SideboardPlan | null> = { A: null, B: null };
  const seen: Record<PlayerId, Map<OracleId, number>> = { A: new Map(), B: new Map() };
  const registered: Record<PlayerId, Deck> = {
    A: options.players.A.deck,
    B: options.players.B.deck,
  };
  const decks: Record<PlayerId, Deck> = { ...registered };
  const definitions = new Map(options.definitions);
  const legalisations: Legalisation[] = [];
  let chooser = options.firstChooser;

  while (games.length < MOST_GAMES && wins.A < WINS_NEEDED && wins.B < WINS_NEEDED) {
    if (games.length === MOST_GAMES - 1) {
      for (const player of playerIds) {
        const hook = options.players[player].sideboard;
        if (hook === undefined) continue;
        const plan = hook({
          deck: registered[player],
          opponentSeen: slotsOf(seen[opponentOf(player)]),
          // A copy: the match goes on adding games, and what the hook was shown must not.
          games: [...games],
          player,
        });
        checkSwap(player, registered[player], plan);
        sideboarding[player] = plan;
        decks[player] = { main: plan.main, side: plan.side };
      }
    }

    const seed = `${options.seed}:game-${games.length + 1}`;
    const board = deckBoard({
      decks,
      definitions,
      seed,
      chooser,
      turnCap: options.turnCap,
    });
    const live = options.live?.watching() === true ? options.live : undefined;
    live?.started({
      seed,
      game: games.length + 1,
      chooser,
      decks: { A: decks.A.main, B: decks.B.main },
      generations: { A: options.generations?.A ?? 0, B: options.generations?.B ?? 0 },
    });
    const played = playGame(
      board,
      { A: options.players.A.agent, B: options.players.B.agent },
      seed,
      {
        ...(options.score === undefined ? {} : { score: options.score }),
        ...(live === undefined ? {} : { onEvent: (event: GameEvent) => live.event(event) }),
      },
    );
    live?.ended({ seed, onPlay: played.state.config.playerOnPlay, result: played.result });
    if (options.onGame !== undefined) {
      const logged = (player: PlayerId) => ({
        generation: options.generations?.[player] ?? 0,
        main: decks[player].main,
        side: decks[player].side,
      });
      options.onGame(
        eventLogOf({ gameId: seed, seed, played, players: { A: logged('A'), B: logged('B') } }),
      );
    }
    for (const player of playerIds) addSeen(seen[player], played.state, player);

    const result = played.result;
    games.push({
      seed,
      chooser,
      onPlay: played.state.config.playerOnPlay,
      result,
      decks: { A: decks.A.main, B: decks.B.main },
      decisions: played.decisions,
    });
    const winner = result?.winner ?? null;
    if (winner !== null) {
      wins[winner] += 1;
      // CR 103.1: the loser of the previous game chooses; after a draw, whoever chose.
      chooser = opponentOf(winner);
    }

    // docs/05: a ban takes effect when the game in progress ends, and the match goes on
    // with the legalised decks — the games already played still count.
    const update = await options.afterGame?.({ gameId: seed, decks: { ...registered } });
    if (update !== undefined && update !== null) {
      for (const player of playerIds) {
        registered[player] = update.decks[player];
        decks[player] = update.decks[player];
      }
      for (const [oracleId, definition] of update.definitions)
        definitions.set(oracleId, definition);
      legalisations.push({ afterGameId: seed, changes: update.changes });
    }
  }

  const winner = wins.A > wins.B ? 'A' : wins.B > wins.A ? 'B' : null;
  return {
    games,
    wins,
    winner,
    sideboarding,
    shown: { A: slotsOf(seen.A), B: slotsOf(seen.B) },
    decks: registered,
    legalisations,
  };
};

/** A swap keeps the seventy-five, and keeps sixty of them in the main deck. */
const checkSwap = (player: PlayerId, registered: Deck, plan: SideboardPlan): void => {
  if (cardCount(plan.main) !== cardCount(registered.main)) {
    throw new IllegalSideboardError(
      player,
      `the main deck has ${cardCount(plan.main)} cards, not ${cardCount(registered.main)}`,
    );
  }
  const before = cardsIn(registered);
  const after = cardsIn({ main: plan.main, side: plan.side });
  for (const oracleId of new Set([...before.keys(), ...after.keys()])) {
    if ((before.get(oracleId) ?? 0) !== (after.get(oracleId) ?? 0)) {
      throw new IllegalSideboardError(player, `it changes how many ${oracleId} the 75 holds`);
    }
  }
};

/**
 * The cards a player has shown in a finished game: whatever of theirs ended it somewhere
 * public — battlefield, graveyard, exile, the stack. Tokens were never cards in the deck.
 */
const addSeen = (into: Map<OracleId, number>, state: GameState, player: PlayerId): void => {
  for (const [, object] of state.objects) {
    if (object.owner !== player || object.token || isHiddenZone(object.zone)) continue;
    into.set(object.definitionId, (into.get(object.definitionId) ?? 0) + 1);
  }
};

const slotsOf = (counts: ReadonlyMap<OracleId, number>): DeckSlot[] =>
  [...counts]
    .map(([oracleId, count]) => ({ oracleId, count }))
    .sort((a, b) => a.oracleId.localeCompare(b.oracleId));
