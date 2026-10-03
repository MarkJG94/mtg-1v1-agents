import type { CycleSummary, WsServerMessage } from '@mtg/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, describeError, type RunAction } from '../api.js';
import { useCardFacts } from '../cards.js';
import { BanConsole, bansKey } from '../components/BanConsole.js';
import { DeckPanel } from '../components/DeckPanel.js';
import { Timeline } from '../components/Timeline.js';
import { type BanMark, WinRateChart } from '../components/WinRateChart.js';
import { banMarkers } from '../dashboard.js';
import { mergeRun, useRunsStore, useSubscription } from '../live.js';
import { Link, livePath } from '../router.js';
import { actionsFor, runsQueryKey } from './RunsPage.js';

/**
 * The run dashboard (docs/08 "Run dashboard"): the header with the cycle's progress and
 * pace; both agents' win rate over every cycle, with its changes and bans; the current
 * decks side by side with each card's Δ; the timeline of cycles; and the ban console,
 * always in view. It follows the run's socket subscription: a finished cycle joins the
 * chart and the timeline, a changed deck and an applied ban are fetched afresh.
 */

export const runKeys = {
  run: (runId: string) => ['run', runId] as const,
  cycles: (runId: string) => ['cycles', runId] as const,
  stats: (runId: string) => ['stats', runId] as const,
};

export const RunPage = ({ runId }: { runId: string }) => {
  const queryClient = useQueryClient();
  const run = useQuery({ queryKey: runKeys.run(runId), queryFn: () => api.run(runId) });
  const cycles = useQuery({
    queryKey: runKeys.cycles(runId),
    queryFn: () => api.allCycles(runId),
  });
  const bans = useQuery({ queryKey: bansKey(runId), queryFn: () => api.bans(runId) });
  const statsA = useQuery({
    queryKey: [...runKeys.stats(runId), 'A'],
    queryFn: () => api.stats(runId, 'A'),
  });
  const statsB = useQuery({
    queryKey: [...runKeys.stats(runId), 'B'],
    queryFn: () => api.stats(runId, 'B'),
  });
  const live = useRunsStore((store) => store.live[runId]);
  const apply = useRunsStore((store) => store.apply);

  useSubscription({ to: 'run', runId }, (message: WsServerMessage) => {
    switch (message.type) {
      case 'runStatus':
        apply(message);
        return;
      case 'cycleFinished':
        queryClient.setQueryData<CycleSummary[]>(runKeys.cycles(runId), (known) =>
          known === undefined || known.some((cycle) => cycle.number === message.cycle.number)
            ? known
            : [...known, message.cycle],
        );
        void queryClient.invalidateQueries({ queryKey: runKeys.run(runId) });
        void queryClient.invalidateQueries({ queryKey: runKeys.stats(runId) });
        return;
      case 'deckChanged':
        void queryClient.invalidateQueries({ queryKey: runKeys.run(runId) });
        if (message.cause === 'ban') {
          void queryClient.invalidateQueries({ queryKey: bansKey(runId) });
        }
        return;
      case 'banApplied':
        void queryClient.invalidateQueries({ queryKey: bansKey(runId) });
        void queryClient.invalidateQueries({ queryKey: runKeys.run(runId) });
        return;
      default:
        return;
    }
  });

  const [actionError, setActionError] = useState<string | null>(null);
  const lifecycle = useMutation({
    mutationFn: (action: RunAction) => api.lifecycle(runId, action),
    onSuccess: () => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: runKeys.run(runId) });
      void queryClient.invalidateQueries({ queryKey: runsQueryKey });
    },
    onError: (failure) => setActionError(describeError(failure)),
  });

  const decks = run.data?.decks;
  const facts = useCardFacts(
    decks === undefined
      ? []
      : [
          ...decks.A.deck.main,
          ...decks.A.deck.side,
          ...decks.B.deck.main,
          ...decks.B.deck.side,
        ].map((slot) => slot.oracleId),
  );

  if (run.isPending) return <p className="text-slate-400">Loading…</p>;
  if (run.isError || decks === undefined) {
    return (
      <section className="flex flex-col gap-2">
        <BackLink />
        <p role="alert" className="text-orange-300">
          {run.isError ? describeError(run.error) : 'This run has no decks.'}
        </p>
      </section>
    );
  }

  const row = mergeRun(run.data, run.dataUpdatedAt, live);
  const marks: BanMark[] = banMarkers(bans.data?.history ?? []).flatMap((marker) =>
    marker.events.map((event) => ({
      cycle: marker.cycle,
      label: `${event.action} ${
        bans.data?.list.find((entry) => entry.oracleId === event.oracleId)?.name ??
        facts.get(event.oracleId)?.name ??
        event.oracleId
      } — in effect from cycle ${marker.cycle}`,
    })),
  );
  const progress =
    row.matchesPlanned !== null && row.matchesPlanned > 0
      ? Math.min(1, (row.matchesDone ?? 0) / row.matchesPlanned)
      : null;

  return (
    <section className="flex flex-col gap-6">
      <BackLink />
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">{row.name}</h1>
          <p className="text-sm text-slate-400" data-testid="run-status">
            {row.status === 'running' && !row.playing ? 'waiting for a worker' : row.status}
            {' · '}
            {row.cycle === null ? 'no cycle yet' : `cycle ${row.cycle}`}
            {' · '}
            {row.agentLevel} agents · seed <code>{row.seed}</code>
          </p>
          {progress !== null && row.playing && (
            <div className="mt-1 flex items-center gap-3 text-xs text-slate-400">
              <div
                className="h-1.5 w-48 overflow-hidden rounded bg-slate-800"
                role="progressbar"
                aria-label="This cycle's matches"
                aria-valuemin={0}
                aria-valuemax={row.matchesPlanned ?? 0}
                aria-valuenow={row.matchesDone ?? 0}
              >
                <div className="h-full bg-slate-300" style={{ width: `${progress * 100}%` }} />
              </div>
              <span className="tabular-nums">
                {row.matchesDone}/{row.matchesPlanned} matches
              </span>
              {row.gamesPerSecond !== null && (
                <span className="tabular-nums" data-testid="pace">
                  {row.gamesPerSecond.toFixed(1)} games/s
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex gap-2">
          <Link to={livePath(runId)} className="btn">
            Watch live
          </Link>
          {actionsFor(row.status).map((action) => (
            <button
              key={action}
              type="button"
              className="btn capitalize"
              disabled={lifecycle.isPending}
              onClick={() => lifecycle.mutate(action)}
            >
              {action}
            </button>
          ))}
          <a className="btn" href={api.exportUrl(runId)} download>
            Export
          </a>
        </div>
      </header>
      {actionError !== null && (
        <p role="alert" className="text-orange-300">
          {actionError}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-6">
          {cycles.isError ? (
            <p role="alert" className="text-orange-300">
              {describeError(cycles.error)}
            </p>
          ) : (
            <WinRateChart cycles={cycles.data ?? []} bans={marks} />
          )}

          <div className="grid gap-4 xl:grid-cols-2">
            <DeckPanel
              agent="A"
              generation={decks.A}
              facts={facts}
              stats={statsA.data}
              side="right"
            />
            <DeckPanel
              agent="B"
              generation={decks.B}
              facts={facts}
              stats={statsB.data}
              side="left"
            />
          </div>

          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-medium uppercase tracking-wide text-slate-400">Timeline</h2>
            <Timeline runId={runId} cycles={cycles.data ?? []} />
          </section>
        </div>
        <aside className="lg:sticky lg:top-4 lg:self-start">
          <BanConsole
            runId={runId}
            decks={{ A: decks.A.deck, B: decks.B.deck }}
            playing={row.playing}
          />
        </aside>
      </div>
    </section>
  );
};

const BackLink = () => (
  <p className="text-sm">
    <Link to="/" className="text-sky-300 hover:underline">
      ← Runs
    </Link>
  </p>
);
