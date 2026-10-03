import type { CycleSummary } from '@mtg/shared';
import { type KeyboardEvent, type PointerEvent, useRef, useState } from 'react';

/**
 * Both agents' win rate cycle by cycle (docs/08 "Run dashboard": "win-rate chart over
 * cycles for both agents, with markers where changes and bans happened").
 *
 * One axis, 0–100%. A is blue and B orange (validated for colour-vision deficiency on the
 * dark surface: ΔE 22.6 under protanopia), each keyed in the legend and labelled at its
 * end, so identity is never colour alone. A change is a dot on the line of the agent that
 * changed; a ban is a hairline at the cycle it took effect in. Hover, or focus and use the
 * arrow keys, for a cycle's numbers; the timeline below is the table view.
 */

export const agentColour = { A: '#1b8fd0', B: '#e8672a' } as const;

export interface BanMark {
  readonly cycle: number;
  readonly label: string;
}

const W = 800;
const H = 220;
const M = { left: 40, right: 72, top: 12, bottom: 24 };
const plotW = W - M.left - M.right;
const plotH = H - M.top - M.bottom;
const percent = (rate: number) => `${Math.round(rate * 100)}%`;

export const WinRateChart = ({
  cycles,
  bans,
}: {
  cycles: readonly CycleSummary[];
  bans: readonly BanMark[];
}) => {
  const [active, setActive] = useState<number | null>(null);
  const plot = useRef<SVGRectElement>(null);

  if (cycles.length === 0) {
    return (
      <p className="text-sm text-slate-500" data-testid="win-rate-empty">
        No cycle has finished yet: the chart starts with the first.
      </p>
    );
  }

  const first = cycles[0]?.number ?? 1;
  const last = cycles.at(-1)?.number ?? first;
  const span = Math.max(1, last - first);
  const x = (cycle: number) =>
    cycles.length === 1 ? M.left + plotW / 2 : M.left + ((cycle - first) / span) * plotW;
  const y = (rate: number) => M.top + (1 - Math.min(1, Math.max(0, rate))) * plotH;
  const line = (agent: 'A' | 'B') =>
    cycles.map((cycle) => `${x(cycle.number).toFixed(1)},${y(cycle.winRate[agent]).toFixed(1)}`);
  const xTicks = ticks(first, last);
  const shown = active === null ? null : (cycles[active] ?? null);
  const final = cycles.at(-1);

  const nearest = (event: PointerEvent<SVGRectElement>) => {
    const box = plot.current?.getBoundingClientRect();
    if (box === undefined || box.width === 0) return;
    const at = ((event.clientX - box.left) / box.width) * plotW;
    const cycle = first + (at / plotW) * span;
    let best = 0;
    cycles.forEach((each, index) => {
      if (Math.abs(each.number - cycle) < Math.abs((cycles[best]?.number ?? 0) - cycle))
        best = index;
    });
    setActive(best);
  };
  const step = (event: KeyboardEvent<SVGRectElement>) => {
    const moves: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      End: cycles.length,
      Home: -cycles.length,
    };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    setActive((current) =>
      Math.min(cycles.length - 1, Math.max(0, (current ?? cycles.length - 1) + move)),
    );
  };

  return (
    <figure className="relative">
      <figcaption className="mb-2 flex flex-wrap items-center gap-4 text-xs text-slate-300">
        <span>Win rate by cycle</span>
        {(['A', 'B'] as const).map((agent) => (
          <span key={agent} className="inline-flex items-center gap-1.5">
            <svg width="16" height="4" aria-hidden="true">
              <line x1="0" x2="16" y1="2" y2="2" stroke={agentColour[agent]} strokeWidth="2" />
            </svg>
            Agent {agent}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <svg width="10" height="10" aria-hidden="true">
            <circle cx="5" cy="5" r="4" className="fill-slate-300" />
          </svg>
          change (on the changing agent’s line)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <svg width="10" height="12" aria-hidden="true">
            <line x1="5" x2="5" y1="0" y2="12" className="stroke-slate-400" />
          </svg>
          ban took effect
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Win rates over ${cycles.length} cycles; latest A ${percent(final?.winRate.A ?? 0)}, B ${percent(final?.winRate.B ?? 0)}`}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((rate) => (
          <g key={rate}>
            <line
              x1={M.left}
              x2={M.left + plotW}
              y1={y(rate)}
              y2={y(rate)}
              className={rate === 0.5 ? 'stroke-slate-600' : 'stroke-slate-800'}
              strokeWidth="1"
            />
            <text
              x={M.left - 6}
              y={y(rate) + 3}
              textAnchor="end"
              className="fill-slate-500 text-[10px]"
            >
              {percent(rate)}
            </text>
          </g>
        ))}
        {xTicks.map((cycle) => (
          <text
            key={cycle}
            x={x(cycle)}
            y={H - 6}
            textAnchor="middle"
            className="fill-slate-500 text-[10px]"
          >
            {cycle}
          </text>
        ))}
        {bans.map((ban) => (
          <line
            key={`${ban.cycle}-${ban.label}`}
            data-testid="ban-mark"
            x1={x(Math.min(last, Math.max(first, ban.cycle)))}
            x2={x(Math.min(last, Math.max(first, ban.cycle)))}
            y1={M.top}
            y2={M.top + plotH}
            className="stroke-slate-400"
            strokeWidth="1"
          >
            <title>{ban.label}</title>
          </line>
        ))}
        {(['A', 'B'] as const).map((agent) => (
          <polyline
            key={agent}
            data-testid={`line-${agent}`}
            points={line(agent).join(' ')}
            fill="none"
            stroke={agentColour[agent]}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {cycles.map((cycle) =>
          cycle.change === null ? null : (
            <circle
              key={cycle.number}
              data-testid="change-mark"
              cx={x(cycle.number)}
              cy={y(cycle.winRate[cycle.change.agent])}
              r="4"
              fill={agentColour[cycle.change.agent]}
              className="stroke-slate-950"
              strokeWidth="2"
            >
              <title>{`Cycle ${cycle.number}: ${cycle.change.agent} — ${cycle.change.reason}`}</title>
            </circle>
          ),
        )}
        {final !== undefined &&
          (['A', 'B'] as const).map((agent) => (
            <text
              key={agent}
              x={M.left + plotW + 6}
              y={y(final.winRate[agent]) + 3 + (agent === 'A' ? -5 : 5)}
              className="fill-slate-300 text-[11px]"
            >
              {agent} {percent(final.winRate[agent])}
            </text>
          ))}
        {shown !== null && (
          <line
            x1={x(shown.number)}
            x2={x(shown.number)}
            y1={M.top}
            y2={M.top + plotH}
            className="stroke-slate-300"
            strokeWidth="1"
          />
        )}
        <rect
          ref={plot}
          x={M.left}
          y={M.top}
          width={plotW}
          height={plotH}
          fill="transparent"
          tabIndex={0}
          role="slider"
          aria-label="Cycle"
          aria-valuemin={first}
          aria-valuemax={last}
          aria-valuenow={shown?.number ?? last}
          onPointerMove={nearest}
          onPointerLeave={() => setActive(null)}
          onKeyDown={step}
          onBlur={() => setActive(null)}
          className="cursor-crosshair outline-none focus-visible:stroke-slate-500"
        />
      </svg>
      {shown !== null && (
        <CycleTooltip cycle={shown} left={(x(shown.number) / W) * 100} bans={bans} />
      )}
    </figure>
  );
};

const CycleTooltip = ({
  cycle,
  left,
  bans,
}: {
  cycle: CycleSummary;
  left: number;
  bans: readonly BanMark[];
}) => (
  <div
    role="tooltip"
    className="pointer-events-none absolute top-8 z-10 w-64 -translate-x-1/2 rounded border border-slate-700 bg-slate-900/95 p-2 text-xs shadow-lg"
    style={{ left: `${Math.min(80, Math.max(20, left))}%` }}
  >
    <div className="mb-1 text-slate-400">Cycle {cycle.number}</div>
    {(['A', 'B'] as const).map((agent) => (
      <div key={agent} className="flex items-center gap-2">
        <svg width="12" height="4" aria-hidden="true">
          <line x1="0" x2="12" y1="2" y2="2" stroke={agentColour[agent]} strokeWidth="2" />
        </svg>
        <strong className="tabular-nums text-slate-100">{percent(cycle.winRate[agent])}</strong>
        <span className="text-slate-400">Agent {agent}</span>
      </div>
    ))}
    <div className="mt-1 text-slate-300">
      {cycle.loser} lost
      {cycle.decidedBy === 'winRate'
        ? ''
        : ` (by ${cycle.decidedBy === 'coinFlip' ? 'coin flip' : 'tiebreak'})`}
    </div>
    <div className="mt-1 text-slate-300">
      {cycle.change !== null ? cycle.change.reason : (cycle.unchanged ?? 'No change')}
    </div>
    {bans
      .filter((ban) => ban.cycle === cycle.number)
      .map((ban) => (
        <div key={ban.label} className="mt-1 text-slate-400">
          {ban.label}
        </div>
      ))}
  </div>
);

/** About six clean cycle numbers across the axis, the first and last among them. */
const ticks = (first: number, last: number): number[] => {
  if (last === first) return [first];
  const raw = (last - first) / 5;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const stepSize = [1, 2, 5, 10].map((each) => each * magnitude).find((each) => each >= raw) ?? raw;
  const found = new Set([first, last]);
  for (let tick = Math.ceil(first / stepSize) * stepSize; tick < last; tick += stepSize) {
    if (tick - first > stepSize / 3 && last - tick > stepSize / 3) found.add(tick);
  }
  return [...found].sort((a, b) => a - b);
};
