/**
 * A win rate over cycles, as a line (docs/08 "Runs": "win-rate sparkline (A vs B over
 * cycles)"). A's rate is the line; B's is its mirror, so the dashed middle is an even
 * cycle and a line above it is A ahead.
 */
export const Sparkline = ({
  values,
  width = 96,
  height = 24,
}: {
  values: readonly number[];
  width?: number;
  height?: number;
}) => {
  const last = values.at(-1);
  if (last === undefined) return <span className="text-slate-500">—</span>;
  const pad = 2;
  const x = (index: number) =>
    values.length === 1 ? width / 2 : pad + (index * (width - 2 * pad)) / (values.length - 1);
  const y = (rate: number) => pad + (1 - Math.min(1, Math.max(0, rate))) * (height - 2 * pad);
  const points = values.map((rate, index) => `${x(index).toFixed(1)},${y(rate).toFixed(1)}`);
  const percent = Math.round(last * 100);
  return (
    <span className="inline-flex items-center gap-2">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`A's win rate over the last ${values.length} cycles, latest ${percent}%`}
      >
        <line
          x1={0}
          x2={width}
          y1={y(0.5)}
          y2={y(0.5)}
          className="stroke-slate-600"
          strokeDasharray="2 2"
        />
        <polyline
          points={points.join(' ')}
          fill="none"
          className="stroke-sky-400"
          strokeWidth={1.5}
          data-testid="sparkline-line"
        />
      </svg>
      <span className="tabular-nums text-xs text-slate-300">A {percent}%</span>
    </span>
  );
};
