import type { PlayerId, Replay } from '@mtg/shared';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { agentText, BoardView, HoverCard, type Inspecting } from './BoardView.js';
import { baseInterval, type GameCards, namesFor, type Speed, speeds } from './model.js';
import { Narrator, type TickerLine } from './narrate.js';
import {
  createViewerStore,
  currentLine,
  nextLine,
  nextTurn,
  placeOf,
  previousLine,
  previousTurn,
  type ViewerStore,
} from './transport.js';

/**
 * The game viewer (docs/08 "Game viewer"): one renderer for a replay and a live game. The
 * board is the log folded to the transport's position (`Replay.boardAt`, which starts from
 * the nearest turn's snapshot, so scrubbing back is as quick as forward); the ticker tells
 * the game in words with each decision's evaluation; the transport plays, steps, scrubs
 * and follows a live game's newest event.
 *
 * Keys: Space plays or pauses; ← and → step by event, Shift with them (or [ and ]) by
 * turn; Home and End; + and − change the speed; H reveals hidden information, T turns
 * art off, L follows a live game.
 */

export interface LiveState {
  /** The game has ended: nothing more is coming. */
  readonly finished: boolean;
}

export const GameViewer = ({
  replay,
  length,
  cards,
  live,
  controls,
  onPlayedThrough,
}: {
  replay: Replay;
  /** How many events the replay holds now; a new value re-renders as a live game grows. */
  length: number;
  cards: GameCards;
  live?: LiveState;
  /** More controls for the toolbar: the live page's pin. */
  controls?: ReactNode;
  /** Told, as it changes, whether a live game is over and played back to its end. */
  onPlayedThrough?: (through: boolean) => void;
}) => {
  // A live game plays from its start at the viewer's speed, as a replay does once asked:
  // a game the simulation finishes in a fraction of a second is still watched move by move,
  // and a slower one is caught up with and then waited on at its edge.
  const [store] = useState<ViewerStore>(() => createViewerStore({ playing: live !== undefined }));
  const state = useStore(store);
  const at = state.following ? length : Math.min(state.position, length);
  const lines = useNarration(replay, length, cards, state.reveal);
  const board = useMemo(() => replay.boardAt(at), [replay, at, length]);
  const [inspecting, setInspecting] = useState<Inspecting | null>(null);

  const go = (position: number) => store.getState().seek(Math.min(position, length));
  const toggle = () => {
    if (state.playing) store.getState().pause();
    else {
      // Played from the end, a replay starts again.
      store.setState({
        position: at >= length && live === undefined ? 0 : at,
        playing: true,
        following: false,
      });
    }
  };

  usePlayback(store, lines, at, length, live);
  const through = live?.finished === true && at >= length;
  useEffect(() => onPlayedThrough?.(through), [through, onPlayedThrough]);
  useKeys({
    playPause: toggle,
    nextEvent: () => go(nextLine(lines, at, length)),
    previousEvent: () => go(previousLine(lines, at)),
    nextTurn: () => go(nextTurn(lines, at, length)),
    previousTurn: () => go(previousTurn(lines, at, length)),
    start: () => go(0),
    end: () => go(length),
    faster: () => store.getState().faster(),
    slower: () => store.getState().slower(),
    reveal: () => store.getState().setReveal(!store.getState().reveal),
    images: () => store.getState().setImages(!store.getState().images),
    follow: () => live !== undefined && store.getState().follow(true),
  });

  return (
    <div className="flex flex-col gap-3" data-motion={state.motion ? 'on' : 'off'}>
      <Transport
        at={at}
        length={length}
        lines={lines}
        playing={state.playing}
        speed={state.speed}
        following={state.following}
        live={live}
        onSeek={go}
        onToggle={toggle}
        onSpeed={(speed) => store.getState().setSpeed(speed)}
        onFollow={() => store.getState().follow(true)}
      />
      <div className="flex flex-wrap items-center gap-4 text-xs text-slate-300">
        <Switch
          label="Reveal hidden information"
          checked={state.reveal}
          onChange={(value) => store.getState().setReveal(value)}
        />
        <Switch
          label="Card art"
          checked={state.images}
          onChange={(value) => store.getState().setImages(value)}
        />
        <Switch
          label="Animations"
          checked={state.motion}
          onChange={(value) => store.getState().setMotion(value)}
        />
        {controls}
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <BoardView board={board} cards={cards} reveal={state.reveal} onInspect={setInspecting} />
        <Ticker lines={lines} at={at} length={length} onSeek={go} />
      </div>
      {inspecting !== null && (
        <HoverCard inspecting={inspecting} board={board} cards={cards} images={state.images} />
      )}
    </div>
  );
};

/**
 * The ticker's lines, told as the replay grows: a live game's new events are told on to
 * the end of the lines already told, and the whole is told again only when what names
 * them changes — the cards' faces arriving, or hidden information being revealed.
 */
const useNarration = (
  replay: Replay,
  length: number,
  cards: GameCards,
  reveal: boolean,
): readonly TickerLine[] => {
  const told = useRef<{
    narrator: Narrator;
    replay: Replay;
    faces: GameCards['faces'];
    reveal: boolean;
    count: number;
  } | null>(null);
  let current = told.current;
  if (
    current === null ||
    current.replay !== replay ||
    current.faces !== cards.faces ||
    current.reveal !== reveal
  ) {
    current = {
      // A's hand is the one shown face up (docs/08 "yours visible"); B's on revealing.
      narrator: new Narrator(namesFor(cards), {
        reveal: (player: PlayerId) => player === 'A' || reveal,
      }),
      replay,
      faces: cards.faces,
      reveal,
      count: 0,
    };
    told.current = current;
  }
  if (current.count < length) {
    current.narrator.push(replay.all.slice(current.count, length));
    current.count = length;
  }
  // A new array when lines were added, so what depends on them sees the change.
  const lines = current.narrator.lines;
  return useMemo(() => [...lines], [lines, lines.length]);
};

/** Playing: one told event every `800 ms / speed`, waiting at a live game's edge for more. */
const usePlayback = (
  store: ViewerStore,
  lines: readonly TickerLine[],
  at: number,
  length: number,
  live: LiveState | undefined,
) => {
  const playing = useStore(store, (state) => state.playing);
  const speed = useStore(store, (state) => state.speed);
  useEffect(() => {
    if (!playing) return;
    if (at >= length) {
      if (live === undefined || live.finished) store.getState().pause();
      return;
    }
    const timer = setTimeout(
      () => store.setState({ position: nextLine(lines, at, length) }),
      baseInterval / speed,
    );
    return () => clearTimeout(timer);
  }, [store, playing, speed, at, length, lines, live]);
};

interface KeyActions {
  playPause(): void;
  nextEvent(): void;
  previousEvent(): void;
  nextTurn(): void;
  previousTurn(): void;
  start(): void;
  end(): void;
  faster(): void;
  slower(): void;
  reveal(): void;
  images(): void;
  follow(): void;
}

/**
 * Whether the focused element takes this key itself: a field for typing takes any key, a
 * select its arrows, and the scrub bar its arrows, Home and End. A checkbox takes none —
 * the transport's keys still work after a switch is clicked.
 */
const wantsKey = (target: HTMLElement | null, key: string): boolean => {
  if (target === null) return false;
  if (target.tagName === 'TEXTAREA' || target.isContentEditable) return true;
  const moves = key.startsWith('Arrow') || key === 'Home' || key === 'End';
  if (target.tagName === 'SELECT') return moves || key === ' ';
  if (target.tagName !== 'INPUT') return false;
  const type = (target as HTMLInputElement).type;
  if (type === 'checkbox' || type === 'radio' || type === 'button') return false;
  if (type === 'range') return moves;
  return true;
};

/** The transport's shortcuts, anywhere on the page but in a field that wants the key itself. */
const useKeys = (actions: KeyActions) => {
  const latest = useRef(actions);
  latest.current = actions;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (wantsKey(event.target as HTMLElement | null, event.key)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const act = latest.current;
      const keys: Record<string, (() => void) | undefined> = {
        ' ': act.playPause,
        k: act.playPause,
        ArrowRight: event.shiftKey ? act.nextTurn : act.nextEvent,
        ArrowLeft: event.shiftKey ? act.previousTurn : act.previousEvent,
        ']': act.nextTurn,
        '[': act.previousTurn,
        Home: act.start,
        End: act.end,
        '+': act.faster,
        '=': act.faster,
        '-': act.slower,
        h: act.reveal,
        t: act.images,
        l: act.follow,
      };
      const action = keys[event.key];
      if (action === undefined) return;
      // A focused button would also take Space as a click.
      event.preventDefault();
      action();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
};

const Switch = ({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) => (
  <label className="inline-flex items-center gap-1.5">
    <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    {label}
  </label>
);

const Transport = ({
  at,
  length,
  lines,
  playing,
  speed,
  following,
  live,
  onSeek,
  onToggle,
  onSpeed,
  onFollow,
}: {
  at: number;
  length: number;
  lines: readonly TickerLine[];
  playing: boolean;
  speed: Speed;
  following: boolean;
  live: LiveState | undefined;
  onSeek: (position: number) => void;
  onToggle: () => void;
  onSpeed: (speed: Speed) => void;
  onFollow: () => void;
}) => {
  const turns = lines.flatMap((line, place) => (line.kind === 'turn' ? [{ line, place }] : []));
  const current = currentLine(lines, at);
  const button = 'btn btn-small min-w-8';
  return (
    <section
      aria-label="Transport"
      className="sticky top-0 z-30 flex flex-col gap-2 rounded-lg border border-slate-800 bg-slate-950/95 px-3 py-2 backdrop-blur"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" className={button} aria-label="Start" onClick={() => onSeek(0)}>
          ⏮
        </button>
        <button
          type="button"
          className={button}
          aria-label="Previous turn"
          onClick={() => onSeek(previousTurn(lines, at, length))}
        >
          ⏪
        </button>
        <button
          type="button"
          className={button}
          aria-label="Previous event"
          onClick={() => onSeek(previousLine(lines, at))}
        >
          ◀
        </button>
        <button
          type="button"
          className={`${button} btn-primary`}
          aria-label={playing ? 'Pause' : 'Play'}
          onClick={onToggle}
        >
          {playing ? '⏸' : '▶'}
        </button>
        <button
          type="button"
          className={button}
          aria-label="Next event"
          onClick={() => onSeek(nextLine(lines, at, length))}
        >
          ▶︎|
        </button>
        <button
          type="button"
          className={button}
          aria-label="Next turn"
          onClick={() => onSeek(nextTurn(lines, at, length))}
        >
          ⏩
        </button>
        <button type="button" className={button} aria-label="End" onClick={() => onSeek(length)}>
          ⏭
        </button>
        <label className="ml-2 inline-flex items-center gap-1 text-xs text-slate-400">
          Speed
          <select
            value={speed}
            onChange={(event) => onSpeed(Number(event.target.value) as Speed)}
            className="rounded border border-slate-700 bg-slate-900 px-1 py-0.5 text-slate-100"
          >
            {speeds.map((each) => (
              <option key={each} value={each}>
                {each}×
              </option>
            ))}
          </select>
        </label>
        {live !== undefined && (
          <button
            type="button"
            className={`btn btn-small ml-2 ${following ? 'border-sky-500 text-sky-200' : ''}`}
            aria-pressed={following}
            onClick={onFollow}
            disabled={following}
          >
            {following ? '● Live' : 'Go live'}
          </button>
        )}
        <span className="ml-auto text-xs text-slate-400" data-testid="position">
          {current === undefined ? 'Before the game' : `Turn ${current.turn}`} · event{' '}
          <span className="tabular-nums">{at}</span> of{' '}
          <span className="tabular-nums">{length}</span>
          {live !== undefined && !live.finished && ' · in play'}
        </span>
      </div>
      <div className="relative pb-4">
        <input
          type="range"
          aria-label="Position"
          min={0}
          max={Math.max(length, 1)}
          value={at}
          onChange={(event) => onSeek(Number(event.target.value))}
          className="w-full accent-sky-500"
        />
        <ol aria-label="Turns" className="absolute right-0 bottom-0 left-0 h-4">
          {turns.map(({ line, place }) => (
            <li
              key={line.index}
              className="absolute -translate-x-1/2"
              style={{ left: `${(line.index / Math.max(length, 1)) * 100}%` }}
            >
              <button
                type="button"
                className="px-0.5 text-[10px] leading-none text-slate-500 hover:text-slate-200"
                title={`Turn ${line.turn}`}
                aria-label={`Turn ${line.turn}`}
                onClick={() => onSeek(placeOf(lines, place, length))}
              >
                {line.turn % 5 === 0 || line.turn === 1 ? line.turn : '·'}
              </button>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
};

/** The play-by-play: what has happened in full, what is to come dimmed, each a place to go. */
const Ticker = ({
  lines,
  at,
  length,
  onSeek,
}: {
  lines: readonly TickerLine[];
  at: number;
  length: number;
  onSeek: (position: number) => void;
}) => {
  const current = currentLine(lines, at);
  const scale = useMemo(() => scoreScale(lines), [lines]);
  const currentRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    currentRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [current?.index]);
  return (
    <section aria-label="Ticker" className="flex max-h-[70vh] flex-col gap-1 lg:sticky lg:top-28">
      <h2 className="text-sm font-medium uppercase tracking-wide text-slate-400">Play by play</h2>
      <ol className="flex flex-col overflow-y-auto rounded-lg border border-slate-800 text-xs">
        {lines.map((line, place) => {
          const past = line.index < at;
          const isCurrent = line === current;
          return (
            <li
              key={line.index}
              ref={isCurrent ? currentRef : undefined}
              data-testid="ticker-line"
              aria-current={isCurrent ? 'step' : undefined}
              className={`${line.kind === 'turn' ? 'border-t border-slate-800 bg-slate-900/60 font-medium' : ''} ${isCurrent ? 'bg-sky-950/60' : ''} ${past ? '' : 'opacity-45'}`}
            >
              <button
                type="button"
                className="flex w-full items-center gap-2 px-2 py-0.5 text-left hover:bg-slate-800/60"
                onClick={() => onSeek(placeOf(lines, place, length))}
              >
                <span
                  className={`grow ${line.player !== null && line.kind !== 'event' ? agentText[line.player] : ''}`}
                >
                  {line.text}
                </span>
                {line.score !== undefined && line.player !== null && (
                  <ScoreBar score={line.score} scale={scale} player={line.player} />
                )}
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
};

/**
 * What a full bar is: the 90th percentile of the game's evaluations, so the one huge
 * score of a won position does not flatten every other bar to nothing; beyond it, a bar
 * is full.
 */
export const scoreScale = (lines: readonly TickerLine[]): number => {
  const sizes = lines
    .flatMap((line) => (line.score === undefined ? [] : [Math.abs(line.score)]))
    .sort((a, b) => a - b);
  const at = sizes[Math.floor((sizes.length - 1) * 0.9)];
  return Math.max(1, at ?? 1);
};

/**
 * The deciding player's evaluation as a small bar about zero, scaled to the largest in the
 * game: blue to the right with + when the position was good for them, orange to the left
 * with − when not — the sign is a glyph, not colour alone (docs/08 "Accessibility").
 */
export const ScoreBar = ({
  score,
  scale,
  player,
}: {
  score: number;
  scale: number;
  player: PlayerId;
}) => {
  const share = Math.min(1, Math.abs(score) / scale);
  const text = `${score > 0 ? '+' : score < 0 ? '−' : ''}${Math.abs(score).toFixed(1)}`;
  return (
    <span
      className="flex shrink-0 items-center gap-1"
      title={`${player}’s evaluation of the position as it decided: ${text}`}
      data-testid="score"
    >
      <span className="relative h-2 w-12 rounded-sm bg-slate-800">
        <span className="absolute top-0 left-1/2 h-2 w-px bg-slate-500" />
        <span
          className={`absolute top-0 h-2 rounded-sm ${score >= 0 ? 'left-1/2 bg-sky-500' : 'right-1/2 bg-orange-500'}`}
          style={{ width: `${share * 50}%` }}
        />
      </span>
      <span className="w-9 text-right tabular-nums text-slate-400">{text}</span>
    </span>
  );
};
