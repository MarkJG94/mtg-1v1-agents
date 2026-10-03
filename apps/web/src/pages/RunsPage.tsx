import type { RunSummary } from '@mtg/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ChangeEvent, useRef, useState } from 'react';
import { api, describeError, type RunAction } from '../api.js';
import { Sparkline } from '../components/Sparkline.js';
import { mergeRun, outdates, type RunRow, useRunsStore, useSubscription } from '../live.js';
import { Link, navigate, runPath } from '../router.js';

/**
 * The runs list (docs/08 "Runs"): each run's status, cycle, A's win rate over its last
 * cycles, its pace and its latest change, kept live by the socket's `runStatus`; and the
 * actions — new, start, pause, stop, fork, export, import.
 */

export const runsQueryKey = ['runs'] as const;

const statusText = (row: RunRow): string => {
  if (row.status !== 'running') return row.status;
  return row.playing ? 'running' : 'waiting for a worker';
};

const statusStyle: Record<RunSummary['status'], string> = {
  created: 'border-slate-600 text-slate-300',
  running: 'border-sky-600 text-sky-200',
  paused: 'border-amber-600 text-amber-200',
  stopped: 'border-slate-700 text-slate-500',
};

/** Which lifecycle actions a run in this status can take (docs/07: starting a stopped run is 409). */
export const actionsFor = (status: RunSummary['status']): RunAction[] => {
  switch (status) {
    case 'created':
    case 'paused':
      return ['start', 'stop'];
    case 'running':
      return ['pause', 'stop'];
    case 'stopped':
      return [];
  }
};

const formatPace = (row: RunRow): string => {
  if (row.gamesPerSecond === null || !row.playing) return '—';
  return row.gamesPerSecond.toFixed(row.gamesPerSecond < 10 ? 1 : 0);
};

const formatEta = (seconds: number | null): string | null => {
  if (seconds === null) return null;
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
};

export const RunsPage = () => {
  const queryClient = useQueryClient();
  const runs = useQuery({ queryKey: runsQueryKey, queryFn: api.runs });
  const live = useRunsStore((store) => store.live);
  const apply = useRunsStore((store) => store.apply);
  const [error, setError] = useState<string | null>(null);
  const [forking, setForking] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: runsQueryKey });

  useSubscription({ to: 'runs' }, (message) => {
    if (message.type !== 'runStatus') return;
    apply(message);
    if (
      outdates(
        message,
        runs.data?.runs.find((run) => run.id === message.runId),
      )
    ) {
      void refresh();
    }
  });

  const lifecycle = useMutation({
    mutationFn: ({ id, action }: { id: string; action: RunAction }) => api.lifecycle(id, action),
    onSuccess: () => {
      setError(null);
      void refresh();
    },
    onError: (failure) => setError(describeError(failure)),
  });

  const importer = useMutation({
    mutationFn: async (file: File) => {
      let bundle: unknown;
      try {
        bundle = JSON.parse(await file.text());
      } catch {
        throw new Error(`${file.name} is not a JSON export bundle`);
      }
      return api.importRun(bundle);
    },
    onSuccess: (run) => {
      setError(null);
      void refresh();
      navigate(runPath(run.id));
    },
    onError: (failure) => setError(describeError(failure)),
  });
  const fileInput = useRef<HTMLInputElement>(null);

  const rows = (runs.data?.runs ?? []).map((run) =>
    mergeRun(run, runs.dataUpdatedAt, live[run.id]),
  );

  return (
    <section>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Runs</h1>
        <div className="flex gap-2">
          <button
            type="button"
            className="btn"
            onClick={() => fileInput.current?.click()}
            disabled={importer.isPending}
          >
            {importer.isPending ? 'Importing…' : 'Import'}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="hidden"
            aria-label="Import a run's export bundle"
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file !== undefined) importer.mutate(file);
            }}
          />
          <Link to="/runs/new" className="btn btn-primary">
            New run
          </Link>
        </div>
      </header>

      {error !== null && (
        <p role="alert" className="mt-4 rounded border border-orange-700 bg-orange-950 p-3">
          {error}
        </p>
      )}

      {runs.isPending && <p className="mt-6 text-slate-400">Loading runs…</p>}
      {runs.isError && (
        <p role="alert" className="mt-6 text-orange-300">
          Could not load the runs: {describeError(runs.error)}
        </p>
      )}
      {runs.isSuccess && rows.length === 0 && (
        <p className="mt-6 text-slate-400">
          No runs yet. <Link to="/runs/new">Start one</Link>.
        </p>
      )}

      {rows.length > 0 && (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="py-2 pr-4">Run</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Cycle</th>
                <th className="py-2 pr-4">Win rate</th>
                <th className="py-2 pr-4">Games/s</th>
                <th className="py-2 pr-4">Last change</th>
                <th className="py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <RunTableRow
                  key={row.id}
                  row={row}
                  busy={lifecycle.isPending && lifecycle.variables?.id === row.id}
                  onAction={(action) => lifecycle.mutate({ id: row.id, action })}
                  forking={forking === row.id}
                  onFork={() => setForking(forking === row.id ? null : row.id)}
                  onForked={(run) => {
                    setForking(null);
                    void refresh();
                    navigate(runPath(run.id));
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};

const RunTableRow = ({
  row,
  busy,
  onAction,
  forking,
  onFork,
  onForked,
}: {
  row: RunRow;
  busy: boolean;
  onAction: (action: RunAction) => void;
  forking: boolean;
  onFork: () => void;
  onForked: (run: RunSummary) => void;
}) => {
  const eta = formatEta(row.etaSeconds);
  return (
    <>
      <tr className="border-t border-slate-800 align-top" data-testid={`run-${row.id}`}>
        <td className="py-3 pr-4">
          <Link to={runPath(row.id)} className="font-medium text-sky-300 hover:underline">
            {row.name}
          </Link>
          <div className="text-xs text-slate-500">
            {row.agentLevel}
            {row.forkedFrom !== null && ` · forked at cycle ${row.forkedFrom.cycle}`}
          </div>
        </td>
        <td className="py-3 pr-4">
          <span className={`rounded border px-2 py-0.5 text-xs ${statusStyle[row.status]}`}>
            {statusText(row)}
          </span>
        </td>
        <td className="py-3 pr-4 tabular-nums">
          {row.cycle ?? '—'}
          {row.playing && row.matchesPlanned !== null && row.matchesPlanned > 0 && (
            <div className="text-xs text-slate-500">
              {row.matchesDone}/{row.matchesPlanned} matches{eta !== null && ` · ${eta} left`}
            </div>
          )}
        </td>
        <td className="py-3 pr-4">
          <Sparkline values={row.winRates} />
        </td>
        <td className="py-3 pr-4 tabular-nums" data-testid="games-per-second">
          {formatPace(row)}
        </td>
        <td className="max-w-xs py-3 pr-4 text-slate-300">
          <span className="line-clamp-2" title={row.lastChange ?? undefined}>
            {row.lastChange ?? '—'}
          </span>
        </td>
        <td className="py-3">
          <div className="flex flex-wrap gap-1">
            {actionsFor(row.status).map((action) => (
              <button
                key={action}
                type="button"
                className="btn btn-small capitalize"
                disabled={busy}
                onClick={() => onAction(action)}
              >
                {action}
              </button>
            ))}
            <button
              type="button"
              className="btn btn-small"
              onClick={onFork}
              aria-expanded={forking}
            >
              Fork
            </button>
            <a className="btn btn-small" href={api.exportUrl(row.id)} download>
              Export
            </a>
          </div>
        </td>
      </tr>
      {forking && (
        <tr>
          <td colSpan={7} className="pb-3">
            <ForkForm row={row} onForked={onForked} />
          </td>
        </tr>
      )}
    </>
  );
};

/** Fork at a finished cycle (docs/07 `POST /api/runs/:id/fork`). */
const ForkForm = ({ row, onForked }: { row: RunRow; onForked: (run: RunSummary) => void }) => {
  const [cycle, setCycle] = useState(String(row.cycles));
  const [name, setName] = useState(`${row.name} (fork)`);
  const fork = useMutation({
    mutationFn: () =>
      api.fork(row.id, { cycle: Number(cycle), ...(name.trim() === '' ? {} : { name }) }),
    onSuccess: onForked,
  });
  const cycleNumber = Number(cycle);
  const valid = Number.isInteger(cycleNumber) && cycleNumber >= 0 && cycleNumber <= row.cycles;
  return (
    <form
      className="flex flex-wrap items-end gap-3 rounded border border-slate-700 bg-slate-900/60 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) fork.mutate();
      }}
    >
      <label className="field">
        <span>After cycle (0–{row.cycles})</span>
        <input
          type="number"
          min={0}
          max={row.cycles}
          value={cycle}
          onChange={(event) => setCycle(event.target.value)}
        />
      </label>
      <label className="field grow">
        <span>Name</span>
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <button type="submit" className="btn btn-primary" disabled={!valid || fork.isPending}>
        {fork.isPending ? 'Forking…' : 'Fork'}
      </button>
      {fork.isError && (
        <p role="alert" className="w-full text-orange-300">
          {describeError(fork.error)}
        </p>
      )}
    </form>
  );
};
