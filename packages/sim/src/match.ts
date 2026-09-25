import type { PlayAgent, SideboardPlan } from '@mtg/agents';
import type { CardDefinition, DecisionResponse, GameState } from '@mtg/engine';
import {
  type DeckSlot,
  type GameResult,
  isHiddenZone,
  type OracleId,
  opponentOf,
  type PlayerId,
  playerIds,
} from '@mtg/shared';
import { cardCount, cardsIn, type Deck, deckBoard } from './deck.js';
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
}

export class IllegalSideboardError extends Error {
  constructor(player: PlayerId, why: string) {
    super(`${player}'s sideboard plan is not a legal swap: ${why}`);
    this.name = 'IllegalSideboardError';
  }
}

const WINS_NEEDED = 2;
const MOST_GAMES = 3;

export const playMatch = (options: MatchOptions): MatchResult => {
  const games: MatchGame[] = [];
  const wins: Record<PlayerId, number> = { A: 0, B: 0 };
  const sideboarding: Record<PlayerId, SideboardPlan | null> = { A: null, B: null };
  const seen: Record<PlayerId, Map<OracleId, number>> = { A: new Map(), B: new Map() };
  const decks: Record<PlayerId, Deck> = {
    A: options.players.A.deck,
    B: options.players.B.deck,
  };
  let chooser = options.firstChooser;

  while (games.length < MOST_GAMES && wins.A < WINS_NEEDED && wins.B < WINS_NEEDED) {
    if (games.length === MOST_GAMES - 1) {
      for (const player of playerIds) {
        const hook = options.players[player].sideboard;
        if (hook === undefined) continue;
        const plan = hook({
          deck: options.players[player].deck,
          opponentSeen: slotsOf(seen[opponentOf(player)]),
          // A copy: the match goes on adding games, and what the hook was shown must not.
          games: [...games],
          player,
        });
        checkSwap(player, options.players[player].deck, plan);
        sideboarding[player] = plan;
        decks[player] = { main: plan.main, side: plan.side };
      }
    }

    const seed = `${options.seed}:game-${games.length + 1}`;
    const board = deckBoard({
      decks,
      definitions: options.definitions,
      seed,
      chooser,
      turnCap: options.turnCap,
    });
    const played = playGame(
      board,
      { A: options.players.A.agent, B: options.players.B.agent },
      seed,
    );
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
  }

  const winner = wins.A > wins.B ? 'A' : wins.B > wins.A ? 'B' : null;
  return { games, wins, winner, sideboarding };
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
