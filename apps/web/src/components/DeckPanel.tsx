import type { CardSummary, DeckGenerationDto, StatsTable } from '@mtg/shared';
import { useState } from 'react';
import { imageUrl } from '../api.js';
import {
  colourOrder,
  colourShare,
  curveBuckets,
  formatDelta,
  groupDeck,
  manaCurve,
  type Slot,
} from '../dashboard.js';
import { agentColour } from './WinRateChart.js';

/**
 * One agent's current deck (docs/08 "Run dashboard": "main and side, grouped by type, mana
 * curve, colour pie; each card shows its Δ statistic as a coloured chip; hover shows the
 * card image and its full statistics").
 */

type CardStats = StatsTable['cards'][number];

export const DeckPanel = ({
  agent,
  generation,
  facts,
  stats,
  side = 'right',
}: {
  agent: 'A' | 'B';
  generation: DeckGenerationDto;
  facts: ReadonlyMap<string, CardSummary>;
  stats: StatsTable | undefined;
  /** Which side of a row its hover card opens on, so it stays on the page. */
  side?: 'left' | 'right';
}) => {
  const byCard = new Map((stats?.cards ?? []).map((row) => [row.oracleId, row]));
  const [active, setActive] = useState<string | null>(null);
  const main = groupDeck(generation.deck.main, facts);
  const sideboard = groupDeck(generation.deck.side, facts).flatMap((group) => group.cards);

  const row = (card: { oracleId: string; count: number; card: CardSummary | undefined }) => (
    <CardRow
      key={card.oracleId}
      oracleId={card.oracleId}
      count={card.count}
      card={card.card}
      stats={byCard.get(card.oracleId)}
      open={active === card.oracleId}
      onOpen={(open) => setActive(open ? card.oracleId : null)}
      side={side}
    />
  );

  return (
    <section
      className="flex flex-col gap-4 rounded-lg border border-slate-800 bg-slate-900/40 p-4"
      aria-label={`Agent ${agent}'s deck`}
    >
      <header className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 font-medium">
          <svg width="16" height="4" aria-hidden="true">
            <line x1="0" x2="16" y1="2" y2="2" stroke={agentColour[agent]} strokeWidth="3" />
          </svg>
          Agent {agent}
        </h3>
        <span className="text-xs text-slate-400">
          generation {generation.generation}
          {stats !== undefined && ` · ${weighted(stats.deck.games)} games`}
        </span>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        <ManaCurve slots={generation.deck.main} facts={facts} />
        <ColourShare slots={generation.deck.main} facts={facts} />
      </div>

      <div>
        {main.map((group) => (
          <div key={group.group} className="mb-3">
            <h4 className="mb-1 text-xs uppercase tracking-wide text-slate-500">
              {group.group} · {group.count}
            </h4>
            <ul className="flex flex-col">{group.cards.map(row)}</ul>
          </div>
        ))}
      </div>
      <div>
        <h4 className="mb-1 text-xs uppercase tracking-wide text-slate-500">
          Sideboard · {sideboard.reduce((sum, card) => sum + card.count, 0)}
        </h4>
        <ul className="flex flex-col" aria-label={`Agent ${agent}'s sideboard`}>
          {sideboard.map(row)}
        </ul>
      </div>
    </section>
  );
};

const CardRow = ({
  oracleId,
  count,
  card,
  stats,
  open,
  onOpen,
  side,
}: {
  oracleId: string;
  count: number;
  card: CardSummary | undefined;
  stats: CardStats | undefined;
  open: boolean;
  onOpen: (open: boolean) => void;
  side: 'left' | 'right';
}) => (
  <li className="relative" data-testid={`deck-card-${oracleId}`}>
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-sm hover:bg-slate-800/60 focus:bg-slate-800/60 focus:outline-none"
      aria-expanded={open}
      onMouseEnter={() => onOpen(true)}
      onMouseLeave={() => onOpen(false)}
      onFocus={() => onOpen(true)}
      onBlur={() => onOpen(false)}
    >
      <span className="w-5 text-right tabular-nums text-slate-400">{count}</span>
      <span className="grow truncate">{card?.name ?? oracleId}</span>
      {card?.manaCost && <span className="text-xs text-slate-500">{card.manaCost}</span>}
      {stats !== undefined && <DeltaChip delta={stats.delta} />}
    </button>
    {open && <CardInspector oracleId={oracleId} card={card} stats={stats} side={side} />}
  </li>
);

/** Δ in percentage points, blue up and orange down with the sign as a glyph (docs/08). */
export const DeltaChip = ({ delta }: { delta: number }) => {
  const { text, glyph, sign } = formatDelta(delta);
  const style =
    sign > 0
      ? 'border-sky-700 bg-sky-950 text-sky-200'
      : sign < 0
        ? 'border-orange-700 bg-orange-950 text-orange-200'
        : 'border-slate-700 bg-slate-800 text-slate-300';
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-0.5 rounded border px-1 text-[11px] tabular-nums ${style}`}
      title="Δ: its deck’s win rate with it drawn, less without, in percentage points"
      data-testid="delta"
    >
      <span aria-hidden="true">{glyph}</span>
      {text}
    </span>
  );
};

const rate = (value: number | null) => (value === null ? '—' : `${Math.round(value * 100)}%`);

/**
 * A count rolled up over cycles is weighted by docs/05's decay, so it is seldom whole:
 * shown rounded, and marked as weighted when rounding changed it.
 */
export const weighted = (count: number): string =>
  Number.isInteger(count) ? `${count}` : `≈${Math.round(count)}`;

const CardInspector = ({
  oracleId,
  card,
  stats,
  side,
}: {
  oracleId: string;
  card: CardSummary | undefined;
  stats: CardStats | undefined;
  side: 'left' | 'right';
}) => {
  const [failed, setFailed] = useState(false);
  return (
    <div
      role="tooltip"
      data-testid="card-inspector"
      className={`absolute top-0 z-20 flex w-72 gap-3 rounded-lg border border-slate-700 bg-slate-900 p-3 text-xs shadow-xl ${side === 'right' ? 'left-full ml-2' : 'right-full mr-2'}`}
    >
      {!failed && (
        <img
          src={imageUrl(oracleId, 'normal')}
          alt=""
          width={110}
          height={153}
          className="h-[153px] w-[110px] shrink-0 rounded"
          onError={() => setFailed(true)}
        />
      )}
      <div className="flex min-w-0 flex-col gap-1">
        <strong className="text-sm text-slate-100">{card?.name ?? oracleId}</strong>
        <span className="text-slate-400">{card?.typeLine}</span>
        {stats === undefined ? (
          <span className="text-slate-500">No statistics yet.</span>
        ) : (
          <dl className="mt-1 grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 tabular-nums">
            <dt className="text-slate-400">Δ</dt>
            <dd>{formatDelta(stats.delta).text} pp</dd>
            <dt className="text-slate-400">Drawn in</dt>
            <dd>
              {weighted(stats.gamesDrawn)} of {weighted(stats.games)}
            </dd>
            <dt className="text-slate-400">Win drawn</dt>
            <dd>{rate(stats.winRateDrawn)}</dd>
            <dt className="text-slate-400">Win not drawn</dt>
            <dd>{rate(stats.winRateNotDrawn)}</dd>
            <dt className="text-slate-400">Cast</dt>
            <dd>{rate(stats.castRate)}</dd>
            <dt className="text-slate-400">Dead in hand</dt>
            <dd>{rate(stats.deadInHandRate)}</dd>
            <dt className="text-slate-400">Turn cast</dt>
            <dd>{stats.avgTurnCast === null ? '—' : stats.avgTurnCast.toFixed(1)}</dd>
            <dt className="text-slate-400">Impact</dt>
            <dd>{stats.impact === null ? '—' : stats.impact.toFixed(2)}</dd>
          </dl>
        )}
      </div>
    </div>
  );
};

const ManaCurve = ({
  slots,
  facts,
}: {
  slots: readonly Slot[];
  facts: ReadonlyMap<string, CardSummary>;
}) => {
  const curve = manaCurve(slots, facts);
  const top = Math.max(1, ...curve);
  const height = 56;
  return (
    <figure>
      <figcaption className="mb-1 text-xs text-slate-500">Mana curve (spells)</figcaption>
      <svg
        viewBox={`0 0 ${curveBuckets.length * 22} ${height + 24}`}
        className="h-auto w-full max-w-60"
        role="img"
        aria-label={`Mana curve: ${curveBuckets.map((bucket, index) => `${curve[index]} at ${bucket}`).join(', ')}`}
      >
        {curveBuckets.map((bucket, index) => {
          const value = curve[index] ?? 0;
          const barHeight = (value / top) * height;
          const x = index * 22 + 3;
          return (
            <g key={bucket} data-testid={`curve-${bucket}`} data-value={value}>
              {value > 0 && (
                <path
                  d={roundedTop(x, 12 + height - barHeight, 16, barHeight)}
                  className="fill-slate-400"
                />
              )}
              {value > 0 && (
                <text
                  x={x + 8}
                  y={10 + height - barHeight}
                  textAnchor="middle"
                  className="fill-slate-300 text-[9px]"
                >
                  {value}
                </text>
              )}
              <text
                x={x + 8}
                y={height + 22}
                textAnchor="middle"
                className="fill-slate-500 text-[9px]"
              >
                {bucket}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
};

/** A bar with a 4px rounded top and a square foot on the baseline. */
const roundedTop = (x: number, y: number, width: number, height: number) => {
  const r = Math.min(4, height, width / 2);
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
};

/** The five colours as the game shows them, lifted to read on the dark surface. */
const colourFill = {
  W: '#e9dcb5',
  U: '#3d7fd1',
  B: '#8a7d8f',
  R: '#d8553f',
  G: '#3f9a5a',
} as const;
const colourName = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' } as const;

const ColourShare = ({
  slots,
  facts,
}: {
  slots: readonly Slot[];
  facts: ReadonlyMap<string, CardSummary>;
}) => {
  const share = colourShare(slots, facts);
  const total = colourOrder.reduce((sum, colour) => sum + share[colour], 0);
  const present = colourOrder.filter((colour) => share[colour] > 0);
  return (
    <figure>
      <figcaption className="mb-1 text-xs text-slate-500">
        Colours (coloured mana symbols)
      </figcaption>
      {total === 0 ? (
        <p className="text-xs text-slate-500">Colourless</p>
      ) : (
        <>
          <div
            className="flex h-3 w-full max-w-60 gap-0.5 overflow-hidden rounded"
            aria-hidden="true"
          >
            {present.map((colour) => (
              <div
                key={colour}
                style={{ flexGrow: share[colour], backgroundColor: colourFill[colour] }}
              />
            ))}
          </div>
          <ul
            className="mt-1 flex flex-wrap gap-x-3 text-xs text-slate-300"
            aria-label="Colour share"
          >
            {present.map((colour) => (
              <li key={colour} className="inline-flex items-center gap-1">
                <span
                  className="inline-block h-2 w-2 rounded-sm"
                  style={{ backgroundColor: colourFill[colour] }}
                  aria-hidden="true"
                />
                <span title={colourName[colour]}>
                  {colour} {Math.round((share[colour] / total) * 100)}%
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </figure>
  );
};
