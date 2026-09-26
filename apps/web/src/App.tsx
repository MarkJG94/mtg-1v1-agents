import { useQuery } from '@tanstack/react-query';
import { api } from './api.js';
import { useConnected } from './live.js';
import { NewRunPage } from './pages/NewRunPage.js';
import { RunPage } from './pages/RunPage.js';
import { RunsPage } from './pages/RunsPage.js';
import { Link, type Route, useRoute } from './router.js';

/**
 * The app shell (docs/08): a header with the pages and the server's state, and the page
 * the path names. Pages to come — the run dashboard, the game viewer, coverage — are
 * roadmap 6.4 to 6.6.
 */
export const App = () => {
  const route = useRoute();
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-800 bg-slate-950/80">
        <nav className="mx-auto flex max-w-7xl items-center gap-6 px-6 py-3">
          <Link to="/" className="font-semibold tracking-tight">
            MTG 1v1 Agents
          </Link>
          <Link to="/" className={navClass(route.page === 'runs' || route.page === 'run')}>
            Runs
          </Link>
          <Link to="/runs/new" className={navClass(route.page === 'newRun')}>
            New run
          </Link>
          <span className="ml-auto">
            <ServerState />
          </span>
        </nav>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-8">
        <Page route={route} />
      </main>
    </div>
  );
};

const navClass = (active: boolean) =>
  active ? 'text-slate-100' : 'text-slate-400 hover:text-slate-200';

const Page = ({ route }: { route: Route }) => {
  switch (route.page) {
    case 'runs':
      return <RunsPage />;
    case 'newRun':
      return <NewRunPage />;
    case 'run':
      return <RunPage runId={route.runId} />;
    case 'notFound':
      return (
        <p>
          Nothing lives at <code>{route.path}</code>. <Link to="/">Back to the runs</Link>.
        </p>
      );
  }
};

/** The server's health, and whether the live feed is connected. */
const ServerState = () => {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: api.health,
    retry: false,
    refetchInterval: 30_000,
  });
  const connected = useConnected();
  if (health.isError) {
    return <span className="text-sm text-orange-300">Server unreachable</span>;
  }
  if (health.data === undefined) return null;
  return (
    <span className="text-xs text-slate-400" title={`v${health.data.version}`}>
      {health.data.runsPlaying} playing · {health.data.runsWaiting} waiting ·{' '}
      {health.data.simWorkers} workers · live feed{' '}
      <span className={connected ? 'text-sky-300' : 'text-amber-300'}>
        {connected ? 'on' : 'reconnecting'}
      </span>
    </span>
  );
};
