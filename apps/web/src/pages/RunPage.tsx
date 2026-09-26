import { useQuery } from '@tanstack/react-query';
import { api, describeError } from '../api.js';
import { Link } from '../router.js';

/**
 * A run's page. The dashboard — win-rate chart, decks with Δ chips, timeline and ban
 * console — is roadmap 6.4; until then this says where the run stands, so creating,
 * forking or importing one lands somewhere real.
 */
export const RunPage = ({ runId }: { runId: string }) => {
  const run = useQuery({ queryKey: ['run', runId], queryFn: () => api.run(runId) });
  return (
    <section className="flex flex-col gap-4">
      <p className="text-sm">
        <Link to="/" className="text-sky-300 hover:underline">
          ← Runs
        </Link>
      </p>
      {run.isPending && <p className="text-slate-400">Loading…</p>}
      {run.isError && (
        <p role="alert" className="text-orange-300">
          {describeError(run.error)}
        </p>
      )}
      {run.data !== undefined && (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">{run.data.name}</h1>
          <dl className="grid max-w-md grid-cols-2 gap-x-6 gap-y-1 text-sm">
            <dt className="text-slate-400">Status</dt>
            <dd>{run.data.status}</dd>
            <dt className="text-slate-400">Cycles finished</dt>
            <dd>{run.data.cycles}</dd>
            <dt className="text-slate-400">Seed</dt>
            <dd>
              <code>{run.data.seed}</code>
            </dd>
            <dt className="text-slate-400">Agents</dt>
            <dd>{run.data.agentLevel}</dd>
            <dt className="text-slate-400">Banned or restricted</dt>
            <dd>{run.data.bans.length}</dd>
          </dl>
          <p className="text-sm text-slate-500">The run dashboard arrives with roadmap 6.4.</p>
        </>
      )}
    </section>
  );
};
