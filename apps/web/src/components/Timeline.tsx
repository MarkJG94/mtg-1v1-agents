import type { CardSummary, CycleSummary } from '@mtg/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, describeError } from '../api.js';
import { nameOf, useCardFacts } from '../cards.js';
import { cyclePath, Link } from '../router.js';
import { agentColour } from './WinRateChart.js';

/**
 * Every cycle as a row, newest first (docs/08 "Run dashboard": "result, loser, the change
 * in words … with a diff view and a link to the cycle detail"). It is also the chart's
 * table view: every number the chart draws is here.
 */

const PAGE = 50;
const percent = (rate: number) => `${Math.round(rate * 100)}%`;

export const Timeline = ({ runId, cycles }: { runId: string; cycles: readonly CycleSummary[] }) => {
  const [shown, setShown] = useState(PAGE);
  const [open, setOpen] = useState<number | null>(null);
  const newest = [...cycles].reverse();
  if (newest.length === 0) {
    return <p className="text-sm text-slate-500">No cycle has finished yet.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm" aria-label="Timeline">
        <thead className="text-xs uppercase tracking-wide text-slate-400">
          <tr>
            <th className="py-2 pr-3">Cycle</th>
            <th className="py-2 pr-3">A</th>
            <th className="py-2 pr-3">B</th>
            <th className="py-2 pr-3">Lost</th>
            <th className="py-2">Change</th>
          </tr>
        </thead>
        <tbody>
          {newest.slice(0, shown).map((cycle) => (
            <CycleRow
              key={cycle.number}
              runId={runId}
              cycle={cycle}
              open={open === cycle.number}
              onToggle={() => setOpen(open === cycle.number ? null : cycle.number)}
            />
          ))}
        </tbody>
      </table>
      {newest.length > shown && (
        <button type="button" className="btn btn-small mt-2" onClick={() => setShown(shown + PAGE)}>
          Show {Math.min(PAGE, newest.length - shown)} earlier cycles
        </button>
      )}
    </div>
  );
};

const CycleRow = ({
  runId,
  cycle,
  open,
  onToggle,
}: {
  runId: string;
  cycle: CycleSummary;
  open: boolean;
  onToggle: () => void;
}) => (
  <>
    <tr className="border-t border-slate-800 align-top" data-testid={`cycle-${cycle.number}`}>
      <td className="py-2 pr-3">
        <Link to={cyclePath(runId, cycle.number)} className="text-sky-300 hover:underline">
          {cycle.number}
        </Link>
      </td>
      <td className="py-2 pr-3 tabular-nums">{percent(cycle.winRate.A)}</td>
      <td className="py-2 pr-3 tabular-nums">{percent(cycle.winRate.B)}</td>
      <td className="py-2 pr-3">
        {cycle.loser}
        {cycle.decidedBy !== 'winRate' && (
          <span className="ml-1 text-xs text-slate-500">
            {cycle.decidedBy === 'coinFlip' ? 'coin flip' : 'tiebreak'}
          </span>
        )}
      </td>
      <td className="py-2">
        {cycle.change === null ? (
          <span className="italic text-slate-400">{cycle.unchanged ?? 'No change'}</span>
        ) : (
          <div className="flex items-start gap-2">
            <span className="inline-flex items-center gap-1 text-xs text-slate-400">
              <svg width="8" height="8" aria-hidden="true">
                <circle cx="4" cy="4" r="4" fill={agentColour[cycle.change.agent]} />
              </svg>
              {cycle.change.agent}
            </span>
            <span className="grow">{cycle.change.reason}</span>
            <button
              type="button"
              className="btn btn-small shrink-0"
              aria-expanded={open}
              onClick={onToggle}
            >
              {open ? 'Hide diff' : 'Diff'}
            </button>
          </div>
        )}
      </td>
    </tr>
    {open && (
      <tr>
        <td colSpan={5} className="pb-3">
          <CycleDiff runId={runId} cycle={cycle.number} />
        </td>
      </tr>
    )}
  </>
);

/** The slots a cycle's change took out and put in, from the cycle's detail. */
const CycleDiff = ({ runId, cycle }: { runId: string; cycle: number }) => {
  const detail = useQuery({
    queryKey: ['cycle', runId, cycle],
    queryFn: () => api.cycle(runId, cycle),
  });
  const change = detail.data?.changed?.change ?? null;
  const facts = useCardFacts(change === null ? [] : [change.remove.oracleId, change.add.oracleId]);
  if (detail.isPending) return <p className="text-xs text-slate-500">Loading…</p>;
  if (detail.isError) {
    return (
      <p role="alert" className="text-xs text-orange-300">
        {describeError(detail.error)}
      </p>
    );
  }
  if (change === null) return <p className="text-xs text-slate-500">No change this cycle.</p>;
  return (
    <SlotDiff
      removed={[change.remove]}
      added={[change.add]}
      facts={facts}
      label={`Cycle ${cycle}'s change`}
    />
  );
};

/** Slots out and in, each with its count, card and zone: a change's or a legalisation's. */
export const SlotDiff = ({
  removed,
  added,
  facts,
  label,
}: {
  removed: readonly { oracleId: string; zone: 'main' | 'side'; count: number }[];
  added: readonly { oracleId: string; zone: 'main' | 'side'; count: number }[];
  facts: ReadonlyMap<string, CardSummary>;
  label: string;
}) => (
  <ul className="flex flex-col gap-0.5 font-mono text-xs" aria-label={label}>
    {removed.map((slot) => (
      <li key={`-${slot.zone}-${slot.oracleId}`} className="text-orange-200">
        − {slot.count} {nameOf(facts, slot.oracleId)}{' '}
        <span className="text-slate-500">({slot.zone})</span>
      </li>
    ))}
    {added.map((slot) => (
      <li key={`+${slot.zone}-${slot.oracleId}`} className="text-sky-200">
        + {slot.count} {nameOf(facts, slot.oracleId)}{' '}
        <span className="text-slate-500">({slot.zone})</span>
      </li>
    ))}
  </ul>
);
