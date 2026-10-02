import { type EventLogObject, type ObjectId, Replay, type WsServerMessage } from '@mtg/shared';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useReducer, useRef, useState } from 'react';
import { api } from '../api.js';
import { useCardFacts } from '../cards.js';
import { useSubscription } from '../live.js';
import { Link, runPath } from '../router.js';
import { GameViewer } from '../viewer/GameViewer.js';
import { runKeys } from './RunPage.js';

/**
 * A run's games as they are played (`/runs/:id/live`, docs/08 "Game viewer"): the same
 * viewer as a replay, fed by the run's live stream (docs/07 `gameStart`, `gameEvents`,
 * `gameEnd`). It follows each new game as it starts unless a game is pinned, and keeps the
 * last few, so a game that went by too fast can be pinned and played back at leisure.
 *
 * The simulation never waits for a viewer (docs/07): a game can be over before its first
 * events are read. What makes it watchable is that every event is kept here, and the
 * viewer plays them back at its own speed.
 */

type GameStart = Extract<WsServerMessage, { type: 'gameStart' }>;
type GameEnd = Extract<WsServerMessage, { type: 'gameEnd' }>;

interface LiveGame {
  readonly start: GameStart;
  /** In the order the games started, from 1: how many have started since a pinned one. */
  readonly number: number;
  readonly replay: Replay;
  readonly identities: Map<ObjectId, EventLogObject>;
  end: GameEnd | null;
}

/** How many games the page keeps: the one being watched and a few before it. */
const KEPT = 8;

export const LivePage = ({ runId }: { runId: string }) => {
  const run = useQuery({ queryKey: runKeys.run(runId), queryFn: () => api.run(runId) });
  const games = useRef<LiveGame[]>([]);
  const started = useRef(0);
  const [version, changed] = useReducer((count: number) => count + 1, 0);
  const [pinned, setPinned] = useState<string | null>(null);

  useSubscription({ to: 'game', runId }, (message) => {
    const known = games.current;
    switch (message.type) {
      case 'gameStart': {
        // Caught up mid-game, a game already held starts again from the events resent.
        const again = known.find((game) => game.start.seed === message.seed);
        const rest = known.filter((game) => game !== again);
        if (again === undefined) started.current += 1;
        const all = [
          ...rest,
          {
            start: message,
            number: again?.number ?? started.current,
            replay: new Replay(),
            identities: new Map(),
            end: null,
          },
        ];
        // The last few, and the pinned game however long ago it was: a run of quick games
        // would otherwise take it away while it is being watched.
        games.current = all.filter(
          (game, index) => index >= all.length - KEPT || game.start.seed === pinned,
        );
        changed();
        return;
      }
      case 'gameEvents': {
        const game = known.find((each) => each.start.seed === message.seed);
        if (game === undefined) return;
        for (const object of message.objects) game.identities.set(object.id, object);
        game.replay.push(message.events);
        changed();
        return;
      }
      case 'gameEnd': {
        const game = known.find((each) => each.start.seed === message.seed);
        if (game === undefined) return;
        game.end = message;
        changed();
        return;
      }
      default:
        return;
    }
  });

  const all = games.current;
  const latest = all.at(-1);
  const shown =
    (pinned === null ? undefined : all.find((game) => game.start.seed === pinned)) ?? latest;
  const newer = shown === undefined ? 0 : started.current - shown.number;
  const faces = useCardFacts(
    shown === undefined
      ? []
      : [...shown.start.decks.A, ...shown.start.decks.B].map((slot) => slot.oracleId),
  );
  const cards = useMemo(
    () => ({ identities: shown?.identities ?? new Map(), faces }),
    // A game's identities grow in place; `version` says when.
    [shown, faces, version],
  );

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <p className="text-sm">
          <Link to={runPath(runId)} className="text-sky-300 hover:underline">
            {run.data?.name ?? 'Run'}
          </Link>
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">
          Live{' '}
          {shown !== undefined && (
            <span className="text-base font-normal text-slate-400" data-testid="live-game">
              · {where(shown.start)}
              {shown.end !== null &&
                ` · ${shown.end.winner === null ? 'a draw' : `${shown.end.winner} won`}`}
            </span>
          )}
        </h1>
      </header>
      {shown === undefined ? (
        <p className="text-slate-400" data-testid="live-waiting">
          Waiting for the run’s next game. Games are streamed while the run is playing and this page
          is open.
        </p>
      ) : (
        <GameViewer
          key={shown.start.seed}
          replay={shown.replay}
          length={shown.replay.length}
          cards={cards}
          live={{ finished: shown.end !== null }}
          controls={
            <>
              <label className="inline-flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={pinned !== null}
                  onChange={(event) => setPinned(event.target.checked ? shown.start.seed : null)}
                />
                Pin this game
              </label>
              {pinned !== null && newer > 0 && (
                <span className="text-amber-300" data-testid="newer-games">
                  {newer} newer {newer === 1 ? 'game' : 'games'} since
                </span>
              )}
              {all.length > 1 && (
                <label className="inline-flex items-center gap-1">
                  Recent
                  <select
                    aria-label="Recent games"
                    value={shown.start.seed}
                    onChange={(event) => setPinned(event.target.value)}
                    className="rounded border border-slate-700 bg-slate-900 px-1 py-0.5 text-slate-100"
                  >
                    {[...all].reverse().map((game) => (
                      <option key={game.start.seed} value={game.start.seed}>
                        {where(game.start)}
                        {game.end === null ? ' (playing)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </>
          }
        />
      )}
    </section>
  );
};

const where = (start: GameStart): string =>
  [
    start.cycle === null ? null : `cycle ${start.cycle}`,
    start.match === null ? null : `match ${start.match + 1}`,
    `game ${start.game}`,
  ]
    .filter((part) => part !== null)
    .join(' · ');
