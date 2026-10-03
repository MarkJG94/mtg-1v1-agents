import { type EventLogObject, type ObjectId, Replay } from '@mtg/shared';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api, describeError } from '../api.js';
import { useCardFacts } from '../cards.js';
import { cyclePath, Link, runPath } from '../router.js';
import { GameViewer } from '../viewer/GameViewer.js';

/**
 * A game's replay (`/games/:id`, docs/08 "Game viewer"): its stored event log, drawn by
 * the same viewer as a live game, from the board before the first event to the result.
 */
export const GamePage = ({ gameId }: { gameId: string }) => {
  const game = useQuery({ queryKey: ['game', gameId], queryFn: () => api.game(gameId) });
  const log = useQuery({
    queryKey: ['game-log', gameId],
    queryFn: () => api.gameLog(gameId),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const data = log.data;
  const replay = useMemo(() => (data === undefined ? null : new Replay(data.events)), [data]);
  const identities = useMemo(
    () =>
      new Map<ObjectId, EventLogObject>((data?.objects ?? []).map((object) => [object.id, object])),
    [data],
  );
  const faces = useCardFacts(
    data === undefined
      ? []
      : [
          ...data.players.A.main.map((slot) => slot.oracleId),
          ...data.players.B.main.map((slot) => slot.oracleId),
          ...data.objects.map((object) => object.oracleId),
        ],
  );
  const cards = useMemo(() => ({ identities, faces }), [identities, faces]);
  const detail = game.data;

  return (
    <section className="flex flex-col gap-4">
      {detail !== undefined && (
        <header className="flex flex-col gap-1">
          <p className="text-sm">
            <Link to={runPath(detail.runId)} className="text-sky-300 hover:underline">
              Run
            </Link>
            {' › '}
            <Link
              to={cyclePath(detail.runId, detail.cycle)}
              className="text-sky-300 hover:underline"
            >
              Cycle {detail.cycle}
            </Link>
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">
            Game {detail.number + 1}{' '}
            <span className="text-base font-normal text-slate-400">
              · {detail.onPlay} on the play ·{' '}
              {detail.winner === null ? 'a draw' : `${detail.winner} won`}
              {detail.reason !== null && ` (${detail.reason})`}
              {detail.turns !== null && ` in ${detail.turns} turns`}
            </span>
          </h1>
        </header>
      )}
      {log.isError && (
        <p role="alert" className="text-orange-300">
          {describeError(log.error)}
        </p>
      )}
      {log.isPending && <p className="text-slate-400">Loading the game…</p>}
      {replay !== null && <GameViewer replay={replay} length={replay.length} cards={cards} />}
    </section>
  );
};
