import type { CardDetail, Coverage, SupportStatus } from '@mtg/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, describeError, imageUrl } from '../api.js';
import { SupportBadge } from '../components/cards.js';
import { useSubscription } from '../live.js';
import { cardPath, Link, navigate } from '../router.js';

/**
 * Cards & coverage (docs/08 page 6): how much of Magic the engine can play, and where to
 * spend the effort that would make it more — the parser over all of Scryfall, the
 * templates whose teaching would finish the most cards, the cards runs most asked for and
 * could not have with the sentence that stopped each, and any card, searched for, with
 * its rules text marked sentence by sentence as read or not, and a button to script it
 * again once the parser has learned something.
 */

const coverageKey = ['coverage'] as const;
const cardKey = (oracleId: string) => ['card', oracleId] as const;

const percent = (part: number, whole: number) =>
  whole === 0 ? '0%' : `${((part / whole) * 100).toFixed(1)}%`;
const count = (value: number) => value.toLocaleString('en-GB');

export const CardsPage = ({ oracleId }: { oracleId: string | null }) => {
  const queryClient = useQueryClient();
  const coverage = useQuery({ queryKey: coverageKey, queryFn: api.coverage });
  // A run that asks for a card it cannot have changes the most-requested (docs/07).
  useSubscription({ to: 'runs' }, (message) => {
    if (message.type === 'unsupportedCard') {
      void queryClient.invalidateQueries({ queryKey: coverageKey });
    }
  });

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Cards &amp; coverage</h1>
        <p className="text-sm text-slate-400">
          What the engine can play, and what to teach the parser next.
        </p>
      </header>
      {coverage.isError && (
        <p role="alert" className="text-orange-300">
          {describeError(coverage.error)}
        </p>
      )}
      {coverage.data !== undefined && <Totals coverage={coverage.data} />}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_26rem]">
        <div className="flex min-w-0 flex-col gap-6">
          {coverage.data !== undefined && <MostRequested coverage={coverage.data} />}
          {coverage.data?.parser != null && <Patterns parser={coverage.data.parser} />}
        </div>
        <aside className="flex flex-col gap-4 lg:sticky lg:top-4 lg:self-start">
          <CardSearch selected={oracleId} />
          {oracleId !== null && <CardPanel oracleId={oracleId} />}
        </aside>
      </div>
    </section>
  );
};

const statusOrder: readonly SupportStatus[] = ['supported', 'partial', 'unsupported', 'unscripted'];

/** The same four colours as the support badges, each with its glyph and count beside it. */
const statusFill: Record<SupportStatus, string> = {
  supported: 'bg-sky-500',
  partial: 'bg-amber-400',
  unsupported: 'bg-orange-600',
  unscripted: 'bg-slate-500',
};

const Totals = ({ coverage }: { coverage: Coverage }) => {
  const { parser, scripted } = coverage;
  const cached = scripted.supported + scripted.partial + scripted.unsupported;
  return (
    <section
      aria-label="Coverage"
      className="flex flex-col gap-3 rounded-lg border border-slate-800 p-4"
    >
      {parser === null ? (
        <p className="text-sm text-slate-400" data-testid="no-report">
          This server has no whole-Scryfall report. <code>pnpm cards:coverage</code> writes one to{' '}
          <code>reports/coverage.json</code>.
        </p>
      ) : (
        <>
          <p className="flex flex-wrap items-baseline gap-x-3">
            <span className="text-3xl font-semibold tabular-nums" data-testid="supported-share">
              {percent(parser.counts.supported, parser.counts.cards)}
            </span>
            <span className="text-sm text-slate-300">
              of Scryfall’s {count(parser.counts.cards)} cards the parser scripts in full
              {' · '}
              {count(parser.counts.supportedWithText)} of them by reading rules text
            </span>
          </p>
          <ProportionBar
            parts={statusOrder.map((status) => ({
              status,
              value: parser.counts[status],
            }))}
          />
          <p className="text-xs text-slate-400">
            {count(parser.counts.sentencesClaimed)} of {count(parser.counts.sentences)} sentences
            read ({percent(parser.counts.sentencesClaimed, parser.counts.sentences)})
            {parser.measuredAt !== null &&
              ` · measured ${new Date(parser.measuredAt).toLocaleDateString('en-GB')}`}
            {parser.quick && ' · quick run: cards were not played, so this is a rough number'}
          </p>
        </>
      )}
      <p className="text-xs text-slate-400" data-testid="cache-totals">
        This server has scripted {count(cached)} of its {count(coverage.cards)} cards:{' '}
        {count(scripted.supported)} supported, {count(scripted.partial)} partial,{' '}
        {count(scripted.unsupported)} unsupported.
      </p>
    </section>
  );
};

/** A single bar of the whole, split by status, with a legend that carries the numbers. */
const ProportionBar = ({
  parts,
}: {
  parts: readonly { status: SupportStatus; value: number }[];
}) => {
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  return (
    <div className="flex flex-col gap-1.5">
      <div
        className="flex h-3 w-full gap-0.5 overflow-hidden rounded"
        role="img"
        aria-label={parts.map((part) => `${part.status} ${part.value}`).join(', ')}
      >
        {parts
          .filter((part) => part.value > 0)
          .map((part) => (
            <div
              key={part.status}
              className={statusFill[part.status]}
              style={{ width: `${(part.value / Math.max(total, 1)) * 100}%` }}
              title={`${part.status}: ${part.value}`}
            />
          ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-300">
        {parts.map((part) => (
          <li key={part.status} className="flex items-center gap-1.5" data-testid="share">
            <SupportBadge support={part.status} />
            <span className="tabular-nums">
              {count(part.value)} ({percent(part.value, total)})
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
};

const MostRequested = ({ coverage }: { coverage: Coverage }) => (
  <section aria-label="Most requested" className="flex flex-col gap-2">
    <h2 className="text-sm font-medium uppercase tracking-wide text-slate-400">
      Most requested, and what stopped them
    </h2>
    {coverage.mostRequested.length === 0 ? (
      <p className="text-sm text-slate-400">No run has asked for a card it could not have.</p>
    ) : (
      <table className="w-full text-left text-sm" aria-label="Most-requested cards">
        <thead className="text-xs uppercase tracking-wide text-slate-400">
          <tr>
            <th className="py-1 pr-3">Card</th>
            <th className="py-1 pr-3 text-right">Asked</th>
            <th className="py-1 pr-3">Stopped at</th>
            <th className="py-1" />
          </tr>
        </thead>
        <tbody>
          {coverage.mostRequested.map((card) => (
            <tr
              key={card.oracleId}
              className="border-t border-slate-800 align-top"
              data-testid="requested-row"
            >
              <td className="py-1.5 pr-3">
                <Link to={cardPath(card.oracleId)} className="text-sky-300 hover:underline">
                  {card.name ?? card.oracleId}
                </Link>
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{card.requests}</td>
              <td className="py-1.5 pr-3 text-xs">
                {card.failing === null ? (
                  <span className="text-slate-400">{card.lastReason}</span>
                ) : (
                  <Unread text={card.failing} />
                )}
              </td>
              <td className="py-1.5">
                <TryToScript oracleId={card.oracleId} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </section>
);

/** A sentence the parser could not read, marked as such in words and not colour alone. */
const Unread = ({ text }: { text: string }) => (
  <mark
    className="rounded bg-orange-950 px-1 text-orange-100 decoration-orange-400 underline decoration-wavy underline-offset-4"
    data-testid="unread"
  >
    <span aria-hidden="true">✕ </span>
    <span className="sr-only">Not read: </span>
    {text}
  </mark>
);

const Patterns = ({ parser }: { parser: NonNullable<Coverage['parser']> }) => (
  <section aria-label="Templates to teach" className="flex flex-col gap-2">
    <h2 className="text-sm font-medium uppercase tracking-wide text-slate-400">
      Templates to teach next
    </h2>
    <p className="text-xs text-slate-400">
      “Would finish” counts the cards this is the last unread template on — an upper bound, and the
      number to work from; “appears in” counts every card it is on.
    </p>
    <table className="w-full text-left text-sm" aria-label="Failing patterns">
      <thead className="text-xs uppercase tracking-wide text-slate-400">
        <tr>
          <th className="py-1 pr-3">Template</th>
          <th className="py-1 pr-3 text-right">Would finish</th>
          <th className="py-1 pr-3 text-right">Appears in</th>
          <th className="py-1">For example</th>
        </tr>
      </thead>
      <tbody>
        {[...parser.patterns]
          .sort((a, b) => b.finishes - a.finishes || b.count - a.count)
          .map((pattern) => (
            <tr
              key={pattern.pattern}
              className="border-t border-slate-800 align-top"
              data-testid="pattern-row"
            >
              <td className="py-1.5 pr-3">
                <code className="text-xs">{pattern.pattern}</code>
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{count(pattern.finishes)}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{count(pattern.count)}</td>
              <td className="py-1.5 text-xs text-slate-300">
                <span className="text-slate-100">{pattern.example.card}</span>:{' '}
                {pattern.example.sentence}
              </td>
            </tr>
          ))}
      </tbody>
    </table>
  </section>
);

/** Scripts a card afresh and says what came of it, refreshing what depends on its script. */
const TryToScript = ({ oracleId }: { oracleId: string }) => {
  const queryClient = useQueryClient();
  const script = useMutation({
    mutationFn: () => api.scriptCard(oracleId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: coverageKey });
      void queryClient.invalidateQueries({ queryKey: cardKey(oracleId) });
    },
  });
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <button
        type="button"
        className="btn btn-small"
        disabled={script.isPending}
        onClick={() => script.mutate()}
      >
        {script.isPending ? 'Scripting…' : 'Try to script'}
      </button>
      {script.data !== undefined && (
        <span data-testid="script-result">
          <SupportBadge support={script.data.status} />
        </span>
      )}
      {script.isError && (
        <span role="alert" className="text-xs text-orange-300">
          {describeError(script.error)}
        </span>
      )}
    </span>
  );
};

const CardSearch = ({ selected }: { selected: string | null }) => {
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQuery(typed.trim()), 250);
    return () => clearTimeout(timer);
  }, [typed]);
  const results = useQuery({
    queryKey: ['card-search', query],
    queryFn: () => api.searchCards(query, 20),
    enabled: query.length >= 2,
  });
  return (
    <section aria-label="Card search" className="flex flex-col gap-2">
      <label className="field">
        <span>Search every card</span>
        <input
          type="search"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          placeholder="A name, a type, some rules text"
        />
      </label>
      {results.isError && <p className="text-sm text-orange-300">{describeError(results.error)}</p>}
      {results.data !== undefined && query.length >= 2 && (
        <ul aria-label="Search results" className="flex max-h-72 flex-col overflow-y-auto">
          {results.data.cards.length === 0 && (
            <li className="text-sm text-slate-400">No card matches “{query}”.</li>
          )}
          {results.data.cards.map((card) => (
            <li key={card.oracleId}>
              <button
                type="button"
                aria-current={card.oracleId === selected ? 'true' : undefined}
                className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-sm hover:bg-slate-800 ${card.oracleId === selected ? 'bg-slate-800' : ''}`}
                onClick={() => navigate(cardPath(card.oracleId))}
              >
                <span className="truncate">
                  {card.name}
                  <span className="ml-2 text-xs text-slate-400">{card.typeLine}</span>
                </span>
                <SupportBadge support={card.support} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

/**
 * One card: its image, its rules text a sentence at a time — each marked read, not read,
 * or, with no script that loads, neither — its script's verdict, and its record in runs.
 */
const CardPanel = ({ oracleId }: { oracleId: string }) => {
  const card = useQuery({ queryKey: cardKey(oracleId), queryFn: () => api.card(oracleId) });
  const [imageFailed, setImageFailed] = useState(false);
  if (card.isError) {
    return (
      <p role="alert" className="text-orange-300">
        {describeError(card.error)}
      </p>
    );
  }
  const data = card.data;
  if (data === undefined) return <p className="text-sm text-slate-400">Loading the card…</p>;
  return (
    <section
      aria-label={data.name}
      className="flex flex-col gap-3 rounded-lg border border-slate-800 p-3"
      data-testid="card-panel"
    >
      <div className="flex gap-3">
        {!imageFailed && (
          <img
            src={imageUrl(data.oracleId, 'normal')}
            alt=""
            width={130}
            height={181}
            className="h-[181px] w-[130px] shrink-0 rounded bg-slate-800"
            onError={() => setImageFailed(true)}
          />
        )}
        <div className="flex min-w-0 flex-col gap-1 text-sm">
          <h2 className="text-lg font-semibold">{data.name}</h2>
          <span className="text-slate-400">
            {data.typeLine}
            {data.manaCost && ` · ${data.manaCost}`}
          </span>
          {(data.power !== null || data.loyalty !== null) && (
            <span className="text-slate-400">
              {data.power !== null ? `${data.power}/${data.toughness}` : `Loyalty ${data.loyalty}`}
            </span>
          )}
          <span>
            <SupportBadge support={data.support} />
            {data.script !== null && (
              <span className="ml-2 text-xs text-slate-400">
                {data.script.source === 'hand' ? 'hand-written script' : 'auto script'}
              </span>
            )}
          </span>
          <TryToScript oracleId={data.oracleId} />
        </div>
      </div>
      <Sentences card={data} />
      {data.script !== null && data.script.reasons.length > 0 && (
        <details className="text-xs text-slate-300">
          <summary className="cursor-pointer text-slate-400">
            Why: {data.script.reasons.length}{' '}
            {data.script.reasons.length === 1 ? 'finding' : 'findings'}
          </summary>
          <ul className="mt-1 flex flex-col gap-1">
            {data.script.reasons.map((reason, index) => (
              <li key={`${reason.check}-${index}`}>
                <span className="text-slate-500">{reason.check}:</span> {reason.message}
              </li>
            ))}
          </ul>
        </details>
      )}
      <Record card={data} />
    </section>
  );
};

const Sentences = ({ card }: { card: CardDetail }) => {
  if (card.sentences.length === 0) {
    return <p className="text-sm text-slate-400">No rules text.</p>;
  }
  return (
    <ol aria-label="Rules text" className="flex flex-col gap-1 text-sm">
      {card.sentences.map((sentence, index) => (
        <li
          key={`${index}-${sentence.text}`}
          data-testid="sentence"
          data-claimed={String(sentence.claimed)}
        >
          {sentence.claimed === false ? (
            <Unread text={sentence.text} />
          ) : sentence.claimed === true ? (
            <span>
              <span aria-hidden="true" className="text-sky-400">
                ✓{' '}
              </span>
              <span className="sr-only">Read: </span>
              {sentence.text}
            </span>
          ) : (
            <span className="text-slate-300">{sentence.text}</span>
          )}
        </li>
      ))}
    </ol>
  );
};

const Record = ({ card }: { card: CardDetail }) => {
  const { stats } = card;
  const rate = (wins: number, games: number) => (games === 0 ? '—' : percent(wins, games));
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs" data-testid="card-record">
      <dt className="text-slate-400">Played in</dt>
      <dd className="tabular-nums">
        {stats.runs} {stats.runs === 1 ? 'run' : 'runs'}, ≈{Math.round(stats.games)} games
      </dd>
      <dt className="text-slate-400">Won when drawn</dt>
      <dd className="tabular-nums">{rate(stats.winsDrawn, stats.gamesDrawn)}</dd>
      <dt className="text-slate-400">Won when not</dt>
      <dd className="tabular-nums">{rate(stats.winsNotDrawn, stats.gamesNotDrawn)}</dd>
      <dt className="text-slate-400">Asked for, not had</dt>
      <dd className="tabular-nums">{card.unsupportedRequests}</dd>
    </dl>
  );
};
