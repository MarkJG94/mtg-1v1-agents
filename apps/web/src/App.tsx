import { useQuery } from '@tanstack/react-query';
import { fetchHealth } from './api.js';

/**
 * App shell. The runs list, run dashboard, game viewer, ban console and coverage
 * page arrive in phase 6 of docs/10-roadmap.md; for now this proves the browser
 * can reach the API through the dev proxy.
 */
export const App = () => {
  const health = useQuery({ queryKey: ['health'], queryFn: fetchHealth, retry: false });

  return (
    <main className="mx-auto max-w-3xl px-6 py-16 text-slate-100">
      <h1 className="text-3xl font-semibold tracking-tight">MTG 1v1 Agents</h1>
      <p className="mt-3 text-slate-400">
        Two agents play best-of-three; the loser changes one slot each cycle.
      </p>

      <section className="mt-10 rounded-lg border border-slate-700 bg-slate-900/60 p-5">
        <h2 className="text-sm font-medium uppercase tracking-wide text-slate-400">Server</h2>
        {health.isPending && <p className="mt-2 text-slate-400">Checking…</p>}
        {health.isError && (
          <p className="mt-2 text-red-400">Unreachable — is the API running on port 8080?</p>
        )}
        {health.data && (
          <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
            <dt className="text-slate-400">Status</dt>
            <dd className="text-emerald-400">{health.data.status}</dd>
            <dt className="text-slate-400">Version</dt>
            <dd>{health.data.version}</dd>
            <dt className="text-slate-400">Simulation workers</dt>
            <dd>{health.data.simWorkers}</dd>
            <dt className="text-slate-400">Uptime</dt>
            <dd>{health.data.uptimeSeconds}s</dd>
          </dl>
        )}
      </section>
    </main>
  );
};
