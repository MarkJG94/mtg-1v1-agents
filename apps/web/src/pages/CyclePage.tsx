import type { CycleDetail, StatsTable } from '@mtg/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, describeError } from '../api.js';
import { nameOf, useCardFacts } from '../cards.js';
import { DeltaChip } from '../components/DeckPanel.js';
import { SlotDiff } from '../components/Timeline.js';
import { agentColour } from '../components/WinRateChart.js';
import { held } from '../dashboard.js';
import { Link, runPath } from '../router.js';

/**
 * A cycle in full (docs/08 "Cycle detail"): its result, the change with its evidence —
 * the diagnosis, the card cut, the candidate shortlist and trial results — each deck's
 * rates, the matches, and the card statistics table, sortable by any column and filtered to
 * the main deck or the sideboard. The game viewer the matches will link to is roadmap 6.5.
 */

const rate = (value: number | null) => (value === null ? '—' : `${Math.round(value * 100)}%`);

export const CyclePage = ({ runId, cycle }: { runId: string; cycle: number }) => {
  const detail = useQuery({
    queryKey: ['cycle', runId, cycle],
    queryFn: () => api.cycle(runId, cycle),
  });
  const data = detail.data;
  const change = data?.changed?.change ?? null;
  const facts = useCardFacts(
    data === undefined
      ? []
      : [
          ...(change === null ? [] : [change.remove.oracleId, change.add.oracleId]),
          ...(change?.evidence.candidates.map((candidate) => candidate.oracleId) ?? []),
        ],
  );

  return (
    <section className="flex flex-col gap-6">
      <p className="text-sm">
        <Link to={runPath(runId)} className="text-sky-300 hover:underline">
          ← Run
        </Link>
      </p>
      {detail.isPending && <p className="text-slate-400">Loading…</p>}
      {detail.isError && (
        <p role="alert" className="text-orange-300">
          {describeError(detail.error)}
        </p>
      )}
      {data !== undefined && (
        <>
          <header>
            <h1 className="text-2xl font-semibold tracking-tight">Cycle {data.number}</h1>
            <p className="text-sm text-slate-400" data-testid="cycle-result">
              {data.status === 'running' ? 'in progress · ' : ''}A {rate(data.winRate.A)} · B{' '}
              {rate(data.winRate.B)} · {data.loser} lost
              {data.decidedBy === 'winRate'
                ? ''
                : ` by ${data.decidedBy === 'coinFlip' ? 'coin flip' : 'tiebreak'}`}{' '}
              · {data.matches} matches
              {data.tiebreakMatches > 0 && ` + ${data.tiebreakMatches} tiebreak`}
            </p>
          </header>

          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-medium uppercase tracking-wide text-slate-400">
              The change
            </h2>
            {change === null || data.changed === null ? (
              <p className="italic text-slate-400">{data.unchanged ?? 'Nothing changed.'}</p>
            ) : (
              <ChangeEvidence
                agent={data.changed.agent}
                change={change}
                facts={facts}
                trialled={data.trialled}
              />
            )}
          </section>

          <section className="grid gap-4 md:grid-cols-2">
            {(['A', 'B'] as const).map((agent) => (
              <DeckRates key={agent} agent={agent} detail={data} />
            ))}
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-medium uppercase tracking-wide text-slate-400">Matches</h2>
            <table className="w-full text-left text-sm" aria-label="Matches">
              <thead className="text-xs uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="py-1 pr-3">#</th>
                  <th className="py-1 pr-3">Kind</th>
                  <th className="py-1 pr-3">Winner</th>
                  <th className="py-1 pr-3">Games</th>
                </tr>
              </thead>
              <tbody>
                {data.matchList.map((match) => (
                  <tr key={match.id} className="border-t border-slate-800">
                    <td className="py-1 pr-3 tabular-nums">{match.number + 1}</td>
                    <td className="py-1 pr-3">{match.kind}</td>
                    <td className="py-1 pr-3">{match.winner ?? 'draw'}</td>
                    <td className="py-1 pr-3 tabular-nums">
                      {match.wins.A}–{match.wins.B} of {match.games}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <CardStatsTable runId={runId} detail={data} />
        </>
      )}
    </section>
  );
};

type Change = NonNullable<NonNullable<CycleDetail['changed']>['change']>;

const ChangeEvidence = ({
  agent,
  change,
  facts,
  trialled,
}: {
  agent: 'A' | 'B';
  change: Change;
  facts: ReturnType<typeof useCardFacts>;
  trialled: readonly string[];
}) => {
  const { evidence } = change;
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p>
        <span className="mr-2 inline-flex items-center gap-1 text-xs text-slate-400">
          <svg width="8" height="8" aria-hidden="true">
            <circle cx="4" cy="4" r="4" fill={agentColour[agent]} />
          </svg>
          Agent {agent}
        </span>
        {change.reason}
      </p>
      <SlotDiff removed={[change.remove]} added={[change.add]} facts={facts} label="The change" />
      <dl className="grid max-w-xl grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-slate-400">Diagnosis</dt>
        <dd>{evidence.diagnosis}</dd>
        <dt className="text-slate-400">Deck</dt>
        <dd>
          {evidence.deck.games} games · win {rate(evidence.deck.winRate)} · screw{' '}
          {rate(evidence.deck.screwRate)} · flood {rate(evidence.deck.floodRate)} · colour screw{' '}
          {rate(evidence.deck.colourScrewRate)}
        </dd>
        <dt className="text-slate-400">Cut</dt>
        <dd>
          {evidence.removed.name} ({evidence.removed.count}, {evidence.removed.zone}) · Δ{' '}
          <DeltaChip delta={evidence.removed.delta} /> · dead in hand{' '}
          {rate(evidence.removed.deadInHandRate)} · cast {rate(evidence.removed.castRate)} · drawn
          in {evidence.removed.gamesDrawn} games
        </dd>
        {evidence.starvedColour !== null && (
          <>
            <dt className="text-slate-400">Starved colour</dt>
            <dd>{evidence.starvedColour}</dd>
          </>
        )}
      </dl>
      <table className="w-full max-w-3xl text-left text-xs" aria-label="Candidates">
        <thead className="uppercase tracking-wide text-slate-400">
          <tr>
            <th className="py-1 pr-3">Candidate</th>
            <th className="py-1 pr-3">Static</th>
            <th className="py-1 pr-3">Playable</th>
            <th className="py-1 pr-3">Score</th>
            <th className="py-1">Trial</th>
          </tr>
        </thead>
        <tbody>
          {evidence.candidates.map((candidate) => (
            <tr
              key={candidate.oracleId}
              className={`border-t border-slate-800 ${candidate.oracleId === change.add.oracleId ? 'text-sky-200' : ''}`}
            >
              <td className="py-1 pr-3">
                {candidate.name ?? nameOf(facts, candidate.oracleId)}
                {candidate.oracleId === change.add.oracleId && (
                  <span className="ml-1 text-slate-400">(chosen)</span>
                )}
              </td>
              <td className="py-1 pr-3 tabular-nums">{candidate.staticScore.toFixed(2)}</td>
              <td className="py-1 pr-3">
                {candidate.supported === null ? '—' : candidate.supported ? 'yes' : 'no'}
              </td>
              <td className="py-1 pr-3 tabular-nums">
                {candidate.score === null ? '—' : candidate.score.toFixed(2)}
              </td>
              <td className="py-1 tabular-nums">
                {candidate.trial === null
                  ? trialled.includes(candidate.oracleId)
                    ? 'trialled'
                    : '—'
                  : `${rate(candidate.trial.winRate)} over ${candidate.trial.matches}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const DeckRates = ({ agent, detail }: { agent: 'A' | 'B'; detail: CycleDetail }) => {
  const stats = detail.deckStats[agent];
  const playDraw = detail.playDraw[agent];
  return (
    <section
      className="rounded border border-slate-800 p-3 text-sm"
      aria-label={`Agent ${agent}'s rates`}
    >
      <h3 className="mb-1 flex items-center gap-2 font-medium">
        <svg width="16" height="4" aria-hidden="true">
          <line x1="0" x2="16" y1="2" y2="2" stroke={agentColour[agent]} strokeWidth="3" />
        </svg>
        Agent {agent} · generation {detail.generations[agent]}
      </h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-xs tabular-nums">
        <dt className="text-slate-400">Games</dt>
        <dd>{stats.games}</dd>
        <dt className="text-slate-400">Win</dt>
        <dd>{rate(stats.winRate)}</dd>
        <dt className="text-slate-400">On the play</dt>
        <dd>
          {playDraw.play.wins} of {playDraw.play.games} ({rate(stats.winRateOnPlay)})
        </dd>
        <dt className="text-slate-400">On the draw</dt>
        <dd>
          {playDraw.draw.wins} of {playDraw.draw.games} ({rate(stats.winRateOnDraw)})
        </dd>
        <dt className="text-slate-400">Turns</dt>
        <dd>{stats.averageTurns === null ? '—' : stats.averageTurns.toFixed(1)}</dd>
        <dt className="text-slate-400">Screw / flood</dt>
        <dd>
          {rate(stats.screwRate)} / {rate(stats.floodRate)}
        </dd>
      </dl>
    </section>
  );
};

type Row = StatsTable['cards'][number];
type Column = {
  readonly key: string;
  readonly label: string;
  readonly value: (row: Row) => number | string | null;
  readonly show: (row: Row) => string;
};

const columns: readonly Column[] = [
  {
    key: 'name',
    label: 'Card',
    value: (row) => row.name ?? row.oracleId,
    show: (row) => row.name ?? row.oracleId,
  },
  {
    key: 'delta',
    label: 'Δ',
    value: (row) => row.delta,
    show: (row) => `${(row.delta * 100).toFixed(1)}`,
  },
  {
    key: 'drawn',
    label: 'Drawn',
    value: (row) => row.gamesDrawn,
    show: (row) => `${row.gamesDrawn}`,
  },
  {
    key: 'wd',
    label: 'Win drawn',
    value: (row) => row.winRateDrawn,
    show: (row) => rate(row.winRateDrawn),
  },
  {
    key: 'wn',
    label: 'Win not drawn',
    value: (row) => row.winRateNotDrawn,
    show: (row) => rate(row.winRateNotDrawn),
  },
  { key: 'cast', label: 'Cast', value: (row) => row.castRate, show: (row) => rate(row.castRate) },
  {
    key: 'dead',
    label: 'Dead',
    value: (row) => row.deadInHandRate,
    show: (row) => rate(row.deadInHandRate),
  },
  {
    key: 'turn',
    label: 'Turn cast',
    value: (row) => row.avgTurnCast,
    show: (row) => (row.avgTurnCast === null ? '—' : row.avgTurnCast.toFixed(1)),
  },
];

/** docs/08: "stats table (sortable by any statistic, per agent, filterable to main/side)". */
const CardStatsTable = ({ runId, detail }: { runId: string; detail: CycleDetail }) => {
  const [agent, setAgent] = useState<'A' | 'B'>(detail.loser);
  const [zone, setZone] = useState<'all' | 'main' | 'side'>('all');
  const [sort, setSort] = useState<{ key: string; up: boolean }>({ key: 'delta', up: true });
  const stats = useQuery({
    queryKey: ['stats', runId, agent, detail.number],
    queryFn: () => api.stats(runId, agent, detail.number),
  });
  const deck = detail.decks[agent].deck;
  const inZone = (row: Row) =>
    zone === 'all' ||
    held(
      { main: zone === 'main' ? deck.main : [], side: zone === 'side' ? deck.side : [] },
      row.oracleId,
    ) > 0;
  const column = columns.find((each) => each.key === sort.key) ?? columns[1];
  const rows = [...(stats.data?.cards ?? [])].filter(inZone).sort((a, b) => {
    const left = column?.value(a) ?? null;
    const right = column?.value(b) ?? null;
    if (left === right) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    const order = left < right ? -1 : 1;
    return sort.up ? order : -order;
  });

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-4">
        <h2 className="text-sm font-medium uppercase tracking-wide text-slate-400">
          Card statistics
        </h2>
        <fieldset className="flex gap-1">
          <legend className="sr-only">Agent</legend>
          {(['A', 'B'] as const).map((each) => (
            <button
              key={each}
              type="button"
              aria-pressed={agent === each}
              className={`btn btn-small ${agent === each ? 'btn-primary' : ''}`}
              onClick={() => setAgent(each)}
            >
              Agent {each}
            </button>
          ))}
        </fieldset>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-slate-400">Show</span>
          <select
            aria-label="Zone"
            value={zone}
            onChange={(event) => setZone(event.target.value as typeof zone)}
            className="rounded border border-slate-700 bg-slate-900 px-2 py-0.5"
          >
            <option value="all">all</option>
            <option value="main">main</option>
            <option value="side">sideboard</option>
          </select>
        </label>
      </div>
      {stats.isError && (
        <p role="alert" className="text-orange-300">
          {describeError(stats.error)}
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs" aria-label="Card statistics">
          <thead className="uppercase tracking-wide text-slate-400">
            <tr>
              {columns.map((each) => (
                <th
                  key={each.key}
                  className="py-1 pr-3"
                  aria-sort={
                    sort.key === each.key ? (sort.up ? 'ascending' : 'descending') : 'none'
                  }
                >
                  <button
                    type="button"
                    className="uppercase hover:text-slate-200"
                    onClick={() =>
                      setSort({ key: each.key, up: sort.key === each.key ? !sort.up : true })
                    }
                  >
                    {each.label}
                    {sort.key === each.key && (sort.up ? ' ▲' : ' ▼')}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.oracleId} className="border-t border-slate-800" data-testid="stats-row">
                {columns.map((each) => (
                  <td key={each.key} className="py-1 pr-3 tabular-nums">
                    {each.show(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};
