import type { GameEvent, ObjectId, PlayerId } from '@mtg/shared';
import { opponentOf } from '@mtg/shared';
import { legalActions } from './actions.js';
import { characteristics, landDropsAllowed } from './characteristics.js';
import { runCombatDamage, runDeclareAttackers, runDeclareBlockers } from './combat.js';
import type { CardDefinition } from './definition.js';
import { beginDraft, type Draft, emit, finishDraft, getObj } from './draft.js';
import { runEffects } from './effects.js';
import type { Frame } from './frames.js';
import { emptyPool } from './mana/cost.js';
import { drawCards, shuffleLibrary } from './players.js';
import { nextInt, type RngState, seedRng } from './rng.js';
import { checkStateBasedActions, endGame } from './sba.js';
import {
  beginActivate,
  beginCast,
  enterBattlefield,
  expectAnswer,
  IllegalDecision,
  popFrame,
  pushFrame,
  runActivate,
  runActivateManaChoice,
  runCast,
  runEnterPay,
  runFinishSpell,
  runPutTriggers,
  runResolveTop,
  setDecision,
} from './stack.js';
import {
  type Action,
  DEFAULT_CONFIG,
  type DecisionAnswer,
  type GameConfig,
  type GameState,
  type PlayerState,
} from './state.js';
import { fireTrigger } from './triggers.js';
import { beginTurn, runFrameForTurn } from './turn.js';
import { createObject, moveObject } from './zones.js';

export interface GameSetup {
  definitions: Record<string, CardDefinition>;
  /** Definition ids of each player's library, in any order (it is shuffled). */
  decks: Record<PlayerId, string[]>;
  seed: string | number;
  config?: Partial<GameConfig>;
  /** Who plays first; random when omitted. */
  onPlay?: PlayerId;
}

function newPlayer(life: number): PlayerState {
  return {
    life,
    poison: 0,
    pool: emptyPool(),
    landsPlayedThisTurn: 0,
    maxHandSize: 7,
    lifeGainedThisTurn: 0,
    lifeLostThisTurn: 0,
    spellsCastThisTurn: 0,
    drawnThisTurn: 0,
    attemptedDrawFromEmpty: false,
    mulligans: 0,
    lost: false,
  };
}

/** Empty game state before any cards exist. Used by `createGame` and by the scenario builder. */
export function initialState(setup: Omit<GameSetup, 'decks'>): GameState {
  const config: GameConfig = { ...DEFAULT_CONFIG, ...(setup.config ?? {}) };
  let rng: RngState = seedRng(setup.seed);
  let onPlay = setup.onPlay;
  if (!onPlay) {
    const [coin, r] = nextInt(rng, 2);
    rng = r;
    onPlay = coin === 0 ? 'A' : 'B';
  }
  return {
    rng,
    version: 0,
    config,
    definitions: setup.definitions,
    turn: 0,
    activePlayer: onPlay,
    startingPlayer: onPlay,
    step: 'untap',
    priority: null,
    passes: 0,
    players: { A: newPlayer(config.startingLife), B: newPlayer(config.startingLife) },
    objects: {},
    nextObjectId: 1,
    nextStackId: 1,
    nextEffectId: 1,
    timestamp: 0,
    zones: {
      A: { library: [], hand: [], battlefield: [], graveyard: [], exile: [], command: [] },
      B: { library: [], hand: [], battlefield: [], graveyard: [], exile: [], command: [] },
    },
    stack: [],
    effects: [],
    delayedTriggers: [],
    pendingTriggers: [],
    combat: null,
    pendingDecision: null,
    frames: [],
    turnFlags: {
      extraTurns: [],
      isExtraTurn: false,
      attackedThisTurn: [],
      stateHashes: [],
      priorityDecisions: 0,
    },
    result: null,
    started: false,
    decisionCount: 0,
    eventSeq: 0,
    sbaPending: false,
  };
}

/** Creates a game: libraries shuffled, starting player chosen, mulligans pending. Call `step` to advance. */
export function createGame(setup: GameSetup): { state: GameState; events: GameEvent[] } {
  const base = initialState(setup);
  const config = base.config;
  const onPlay = base.startingPlayer;
  const d = beginDraft(base);
  emit(d, { type: 'gameStart', onPlay });
  for (const p of ['A', 'B'] as const) {
    for (const defId of setup.decks[p]) {
      if (!setup.definitions[defId]) throw new Error(`Unknown card definition ${defId}`);
      createObject(d, defId, p, 'library');
    }
    shuffleLibrary(d, p);
  }
  // Opening hands, then mulligan decisions starting with the player on the play (CR 103.4).
  for (const p of [onPlay, opponentOf(onPlay)]) drawCards(d, p, config.startingHandSize);
  if (config.mulligans) {
    pushFrame(d, { k: 'mulligan', player: opponentOf(onPlay), stage: 'ask' });
    pushFrame(d, { k: 'mulligan', player: onPlay, stage: 'ask' });
  }
  advance(d);
  return finishDraft(d);
}

function runMulligan(
  d: Draft,
  f: Extract<Frame, { k: 'mulligan' }>,
  answer: DecisionAnswer | null,
): void {
  const p = f.player;
  const ps = d.players[p];
  if (f.stage === 'ask') {
    if (ps.mulligans >= d.config.startingHandSize) {
      popFrame(d);
      return;
    }
    if (!answer) {
      setDecision(d, {
        kind: 'mulligan',
        player: p,
        hand: d.zones[p].hand.slice(),
        mulligans: ps.mulligans,
      });
      return;
    }
    const ans = expectAnswer(answer, 'mulligan');
    if (ans.keep) {
      if (ps.mulligans === 0) {
        emit(d, { type: 'keep', player: p, handSize: d.zones[p].hand.length, bottomed: 0 });
        popFrame(d);
        return;
      }
      d.frames[d.frames.length - 1] = { ...f, stage: 'bottom' };
      setDecision(d, {
        kind: 'bottomCards',
        player: p,
        hand: d.zones[p].hand.slice(),
        count: Math.min(ps.mulligans, d.zones[p].hand.length),
      });
      return;
    }
    // London mulligan: shuffle the hand back and draw seven again.
    for (const id of d.zones[p].hand.slice()) moveObject(d, id, 'library');
    shuffleLibrary(d, p);
    ps.mulligans++;
    drawCards(d, p, d.config.startingHandSize);
    emit(d, { type: 'mulligan', player: p, handSize: d.config.startingHandSize });
    if (ps.mulligans >= d.config.startingHandSize) {
      d.frames[d.frames.length - 1] = { ...f, stage: 'bottom' };
      setDecision(d, {
        kind: 'bottomCards',
        player: p,
        hand: d.zones[p].hand.slice(),
        count: d.zones[p].hand.length,
      });
      return;
    }
    setDecision(d, {
      kind: 'mulligan',
      player: p,
      hand: d.zones[p].hand.slice(),
      mulligans: ps.mulligans,
    });
    return;
  }
  const ans = expectAnswer(answer, 'bottomCards');
  const count = Math.min(ps.mulligans, d.zones[p].hand.length);
  if (
    ans.cards.length !== count ||
    new Set(ans.cards).size !== count ||
    ans.cards.some((c) => !d.zones[p].hand.includes(c))
  )
    throw new IllegalDecision('bad bottom choice');
  for (const id of ans.cards) moveObject(d, id, 'library', { libraryPosition: 'bottom' });
  emit(d, { type: 'keep', player: p, handSize: d.zones[p].hand.length, bottomed: count });
  popFrame(d);
}

function startGame(d: Draft): void {
  d.started = true;
  beginTurn(d, d.startingPlayer, false);
}

function runFrame(d: Draft, f: Frame, answer: DecisionAnswer | null): void {
  switch (f.k) {
    case 'resolveTop':
      runResolveTop(d);
      return;
    case 'effects':
      runEffects(d, f, answer);
      return;
    case 'cast':
      runCast(d, f, answer);
      return;
    case 'activate':
      runActivate(d, f, answer);
      return;
    case 'activateManaChoice':
      runActivateManaChoice(d, f, answer);
      return;
    case 'activateMana':
      popFrame(d);
      return;
    case 'putTriggers':
      runPutTriggers(d, f, answer);
      return;
    case 'declareAttackers':
      runDeclareAttackers(d, f, answer);
      return;
    case 'declareBlockers':
      runDeclareBlockers(d, f, answer);
      return;
    case 'combatDamage':
      runCombatDamage(d, f, answer);
      return;
    case 'mulligan':
      runMulligan(d, f, answer);
      return;
    case 'finishSpell':
      runFinishSpell(d, f);
      return;
    case 'enterPay':
      runEnterPay(d, f, answer);
      return;
    default:
      if (runFrameForTurn(d, f, answer)) return;
      throw new Error(`Unhandled frame ${(f as { k: string }).k}`);
  }
}

function stateHash(d: Draft): string {
  const parts: string[] = [d.step, String(d.priority), String(d.passes)];
  for (const p of ['A', 'B'] as const) {
    const ps = d.players[p];
    const z = d.zones[p];
    parts.push(
      `${ps.life}:${ps.poison}:${ps.pool.W}${ps.pool.U}${ps.pool.B}${ps.pool.R}${ps.pool.G}${ps.pool.C}`,
    );
    parts.push(
      z.hand.join(','),
      z.library.length.toString(),
      z.graveyard.join(','),
      z.exile.join(','),
    );
    parts.push(
      z.battlefield
        .map(
          (id) =>
            `${id}${getObj(d, id).tapped ? 't' : 'u'}${JSON.stringify(getObj(d, id).counters)}`,
        )
        .join(','),
    );
  }
  parts.push(d.stack.map((s) => s.stackId).join(','));
  return parts.join('|');
}

/** Runs the engine until a decision is needed or the game ends. */
export function advance(d: Draft): void {
  let guard = 0;
  while (!d.pendingDecision && !d.result) {
    if (++guard > 500_000)
      throw new Error(
        `engine loop guard tripped: step=${d.step} frames=${JSON.stringify(d.frames.slice(-3).map((f) => ({ ...f, ctx: undefined })))}`,
      );
    if (d.frames.length > 0) {
      runFrame(d, d.frames[d.frames.length - 1]!, null);
      continue;
    }
    if (!d.started) {
      startGame(d);
      continue;
    }
    // CR 117.5: SBAs, then triggers, then priority.
    let sbaRounds = 0;
    while (checkStateBasedActions(d)) if (++sbaRounds > 1000) throw new Error('SBA loop');
    if (d.result) break;
    if (d.pendingTriggers.length > 0) {
      pushFrame(d, { k: 'putTriggers', stage: 'order', player: null, items: [] });
      continue;
    }
    if (d.priority === null) d.priority = d.activePlayer;
    // Loop detection (CR 726): only worth hashing once a turn has seen an unusual number of decisions.
    if (++d.turnFlags.priorityDecisions > 60) {
      const hash = stateHash(d);
      d.turnFlags.stateHashes.push(hash);
      if (d.turnFlags.stateHashes.filter((h) => h === hash).length > 40) {
        endGame(d, null, 'loop');
        break;
      }
    }
    setDecision(d, { kind: 'priority', player: d.priority, actions: legalActions(d, d.priority) });
  }
}

function sameAction(a: Action, b: Action): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'pass':
      return true;
    case 'playLand':
      return a.object === (b as typeof a).object;
    case 'cast':
      return (
        a.object === (b as typeof a).object &&
        Boolean(a.alternative) === Boolean((b as typeof a).alternative)
      );
    case 'activate':
    case 'activateMana':
    case 'loyalty':
      return a.source === (b as typeof a).source && a.ability === (b as typeof a).ability;
  }
}

function playLand(d: Draft, player: PlayerId, id: ObjectId): void {
  if (d.players[player].landsPlayedThisTurn >= landDropsAllowed(d, player))
    throw new IllegalDecision('no land drop available');
  if (!characteristics(d, id).types.includes('land')) throw new IllegalDecision('not a land');
  d.players[player].landsPlayedThisTurn++;
  emit(d, { type: 'playLand', player, object: id });
  enterBattlefield(d, player, id, player, null, null, null);
}

function applyPriorityAnswer(d: Draft, player: PlayerId, answer: DecisionAnswer): void {
  const ans = expectAnswer(answer, 'priority');
  const dec = d.pendingDecision;
  if (dec?.kind !== 'priority' || dec.player !== player)
    throw new IllegalDecision('no priority decision pending');
  const action = ans.action;
  if (!dec.actions.some((a) => sameAction(a, action)))
    throw new IllegalDecision(`illegal action ${JSON.stringify(action)}`);
  d.pendingDecision = null;
  emit(d, {
    type: 'decision',
    player,
    kind: 'priority',
    summary:
      action.kind === 'pass'
        ? 'pass'
        : 'text' in action
          ? action.text
          : `${action.kind} ${'object' in action ? action.object : ''}`,
  });
  switch (action.kind) {
    case 'pass': {
      d.passes++;
      if (d.passes >= 2) {
        d.passes = 0;
        d.priority = null;
        if (d.stack.length === 0) pushFrame(d, { k: 'advanceStep' });
        else pushFrame(d, { k: 'resolveTop' });
      } else {
        d.priority = opponentOf(player);
      }
      return;
    }
    case 'playLand':
      d.passes = 0;
      playLand(d, player, action.object);
      d.priority = player;
      return;
    case 'cast':
      d.passes = 0;
      beginCast(d, player, action.object, action.alternative ?? false);
      return;
    case 'activate':
      d.passes = 0;
      beginActivate(d, player, action.source, action.ability, false);
      return;
    case 'loyalty':
      d.passes = 0;
      beginActivate(d, player, action.source, action.ability, true);
      return;
    case 'activateMana':
      d.passes = 0;
      pushFrame(d, {
        k: 'activateManaChoice',
        player,
        source: action.source,
        abilityIndex: action.ability,
      });
      return;
  }
}

/**
 * The engine's single entry point: applies a decision answer to the pending decision and runs until the
 * next decision or the end of the game. Throws IllegalDecision for answers not among the legal options.
 */
export function step(
  state: GameState,
  answer: DecisionAnswer,
): { state: GameState; events: GameEvent[] } {
  const d = beginDraft(state);
  const dec = d.pendingDecision;
  if (!dec) throw new IllegalDecision('no decision pending');
  if (d.result) throw new IllegalDecision('game is over');
  d.decisionCount++;
  if (dec.kind === 'priority') applyPriorityAnswer(d, dec.player, answer);
  else {
    const top = d.frames[d.frames.length - 1];
    if (!top) throw new Error('decision pending without a frame');
    const answered = d.pendingDecision;
    runFrame(d, top, answer);
    if (d.pendingDecision === answered) d.pendingDecision = null;
    if (d.pendingDecision && d.pendingDecision === dec) d.pendingDecision = null;
  }
  if (d.decisionCount > d.config.decisionCap && !d.result) endGame(d, null, 'decisionCap');
  advance(d);
  return finishDraft(d);
}

export function isGameOver(state: GameState): boolean {
  return state.result !== null;
}

export { fireTrigger, IllegalDecision };
