import { useQuery } from '@tanstack/react-query';
import { api } from './api.js';
import { useConnected } from './live.js';
import { CardsPage } from './pages/CardsPage.js';
import { CyclePage } from './pages/CyclePage.js';
import { GamePage } from './pages/GamePage.js';
import { LivePage } from './pages/LivePage.js';
import { NewRunPage } from './pages/NewRunPage.js';
import { RunPage } from './pages/RunPage.js';
import { RunsPage } from './pages/RunsPage.js';
import { Link, type Route, useRoute } from './router.js';

/**
 * The app shell (docs/08): a header with the pages and the server's state, and the page
 * the path names.
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
          <Link
            to="/"
            className={navClass(
              route.page === 'runs' ||
                route.page === 'run' ||
                route.page === 'cycle' ||
                route.page === 'live' ||
                route.page === 'game',
            )}
          >
            Runs
          </Link>
          <Link to="/runs/new" className={navClass(route.page === 'newRun')}>
            New run
          </Link>
          <Link to="/cards" className={navClass(route.page === 'cards')}>
            Cards
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
    case 'cycle':
      return <CyclePage runId={route.runId} cycle={route.cycle} />;
    case 'live':
      return <LivePage runId={route.runId} />;
    case 'game':
      return <GamePage gameId={route.gameId} />;
    case 'cards':
      return <CardsPage oracleId={route.oracleId} />;
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
