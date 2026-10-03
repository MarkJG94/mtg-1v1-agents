import type { BanState, CardSummary } from '@mtg/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, describeError } from '../api.js';
import { nameOf, useCardFacts } from '../cards.js';
import { affected, type BanStatus, cycleOfGame, type Deck } from '../dashboard.js';
import { SlotDiff } from './Timeline.js';

/**
 * The ban console (docs/08 "Run dashboard": "search any Scryfall card, mark banned or
 * restricted with a note; current list with history; the UI shows immediately which agent
 * is affected and, after the current game, the legalisation change that resulted").
 *
 * An edit is answered at once with the trail (docs/07 `202`); on a run a worker is playing
 * it takes effect after the game in progress, otherwise when the run next plays. The
 * dashboard's socket tells this console when it has, and the legalisation it caused.
 */

export const bansKey = (runId: string) => ['bans', runId] as const;

export const BanConsole = ({
  runId,
  decks,
  playing,
}: {
  runId: string;
  decks: { A: Deck; B: Deck };
  playing: boolean;
}) => {
  const queryClient = useQueryClient();
  const state = useQuery({ queryKey: bansKey(runId), queryFn: () => api.bans(runId) });
  const [error, setError] = useState<string | null>(null);
  const settle = {
    onSuccess: (next: BanState) => {
      setError(null);
      queryClient.setQueryData(bansKey(runId), next);
    },
    onError: (failure: unknown) => setError(describeError(failure)),
  };
  const ban = useMutation({
    mutationFn: (edit: { oracleId: string; status: BanStatus; note: string }) =>
      api.ban(runId, edit.oracleId, { status: edit.status, note: edit.note }),
    ...settle,
  });
  const unban = useMutation({
    mutationFn: (oracleId: string) => api.unban(runId, oracleId),
    ...settle,
  });

  const data = state.data;
  const facts = useCardFacts(
    data === undefined
      ? []
      : [
          ...data.list.map((entry) => entry.oracleId),
          ...data.history.map((event) => event.oracleId),
          ...data.legalisations.flatMap((each) =>
            [...each.removed, ...each.added].map((slot) => slot.oracleId),
          ),
        ],
  );
  const pending = (data?.history ?? []).filter((event) => event.appliedAfterGameId === null);

  return (
    <section
      className="flex flex-col gap-4 rounded-lg border border-slate-800 bg-slate-900/40 p-4"
      aria-label="Ban console"
    >
      <h2 className="text-sm font-medium uppercase tracking-wide text-slate-400">Ban console</h2>
      <BanSearch
        decks={decks}
        busy={ban.isPending}
        onBan={(card, status, note) => ban.mutate({ oracleId: card.oracleId, status, note })}
      />
      {error !== null && (
        <p role="alert" className="text-sm text-orange-300">
          {error}
        </p>
      )}

      {state.isError && (
        <p role="alert" className="text-sm text-orange-300">
          {describeError(state.error)}
        </p>
      )}

      <div>
        <h3 className="mb-1 text-xs uppercase tracking-wide text-slate-500">List</h3>
        {data !== undefined && data.list.length === 0 && (
          <p className="text-sm text-slate-500">Nothing banned or restricted.</p>
        )}
        <ul className="flex flex-col gap-1 text-sm" aria-label="Ban list">
          {data?.list.map((entry) => (
            <li key={entry.oracleId} className="flex items-center justify-between gap-2">
              <span>
                {entry.name ?? nameOf(facts, entry.oracleId)}{' '}
                <span className="text-xs text-slate-400">{entry.status}</span>
              </span>
              <button
                type="button"
                className="btn btn-small"
                disabled={unban.isPending}
                onClick={() => unban.mutate(entry.oracleId)}
                aria-label={`Unban ${entry.name ?? entry.oracleId}`}
              >
                Unban
              </button>
            </li>
          ))}
        </ul>
      </div>

      {pending.length > 0 && (
        <div role="status" className="rounded border border-amber-700 bg-amber-950/60 p-2 text-sm">
          <p className="mb-1 text-amber-200">
            {pending.length === 1
              ? 'An edit is pending: it takes'
              : `${pending.length} edits are pending: they take`}{' '}
            effect{' '}
            {(data?.playing ?? playing) ? 'after the game in progress' : 'when the run next plays'}.
          </p>
          <ul className="text-xs text-slate-300">
            {pending.map((event) => (
              <li key={`${event.at}-${event.oracleId}`}>
                {event.action} {nameOf(facts, event.oracleId)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {data !== undefined && data.legalisations.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs uppercase tracking-wide text-slate-500">Legalisations</h3>
          <ul className="flex flex-col gap-2" aria-label="Legalisations">
            {data.legalisations.map((each) => (
              <li key={`${each.agent}-${each.generation}`} className="text-sm">
                <span className="text-slate-300">
                  Cycle {each.cycle} · Agent {each.agent}, generation {each.generation}
                </span>
                <SlotDiff
                  removed={each.removed}
                  added={each.added}
                  facts={facts}
                  label={`Agent ${each.agent}'s legalisation in cycle ${each.cycle}`}
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      {data !== undefined && data.history.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs uppercase tracking-wide text-slate-500">
            History · {data.history.length}
          </summary>
          <ol className="mt-2 flex flex-col gap-1 text-xs" aria-label="Ban history">
            {[...data.history].reverse().map((event) => {
              const cycle = cycleOfGame(event.appliedAfterGameId);
              return (
                <li key={`${event.at}-${event.oracleId}-${event.action}`}>
                  <span className="text-slate-300">
                    {event.action} {nameOf(facts, event.oracleId)}
                  </span>{' '}
                  <span className="text-slate-500">
                    by {event.by}
                    {event.note && ` — “${event.note}”`} ·{' '}
                    {event.appliedAfterGameId === null
                      ? 'pending'
                      : cycle === 0
                        ? 'from the start'
                        : `in effect from cycle ${cycle}`}
                  </span>
                </li>
              );
            })}
          </ol>
        </details>
      )}
    </section>
  );
};

/** Find a card, see who holds it, and ban or restrict it with a note. */
const BanSearch = ({
  decks,
  busy,
  onBan,
}: {
  decks: { A: Deck; B: Deck };
  busy: boolean;
  onBan: (card: CardSummary, status: BanStatus, note: string) => void;
}) => {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [chosen, setChosen] = useState<CardSummary | null>(null);
  const [status, setStatus] = useState<BanStatus>('banned');
  const [note, setNote] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const search = useQuery({
    queryKey: ['cards', debounced],
    queryFn: () => api.searchCards(debounced, 8),
    enabled: debounced.length >= 2 && chosen === null,
  });

  if (chosen !== null) {
    const hit = affected(decks, chosen.oracleId, status);
    return (
      <form
        className="flex flex-col gap-2 rounded border border-slate-700 p-3 text-sm"
        aria-label={`Ban ${chosen.name}`}
        onSubmit={(event) => {
          event.preventDefault();
          onBan(chosen, status, note);
          setChosen(null);
          setQuery('');
          setNote('');
        }}
      >
        <strong>{chosen.name}</strong>
        <div className="flex gap-4" role="radiogroup" aria-label="Status">
          {(['banned', 'restricted'] as const).map((each) => (
            <label key={each} className="flex items-center gap-1">
              <input
                type="radio"
                name="ban-status"
                checked={status === each}
                onChange={() => setStatus(each)}
              />
              {each}
            </label>
          ))}
        </div>
        <p data-testid="ban-effect" className="text-slate-300">
          {hit.length === 0
            ? 'Neither deck is over the limit: no deck changes.'
            : hit
                .map(
                  (each) =>
                    `Agent ${each.agent} holds ${each.held} and must cut to ${each.allowed}`,
                )
                .join('; ')}
        </p>
        <label className="field">
          <span>Note</span>
          <input value={note} onChange={(event) => setNote(event.target.value)} />
        </label>
        <div className="flex gap-2">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {status === 'banned' ? 'Ban' : 'Restrict'}
          </button>
          <button type="button" className="btn" onClick={() => setChosen(null)}>
            Cancel
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="field">
        <span>Search any card</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Lightning Bolt"
        />
      </label>
      {search.data !== undefined && debounced.length >= 2 && (
        <ul className="flex flex-col gap-0.5 text-sm" aria-label="Card search results">
          {search.data.cards.length === 0 && <li className="text-slate-500">No cards match.</li>}
          {search.data.cards.map((card) => (
            <li key={card.oracleId}>
              <button
                type="button"
                className="w-full rounded px-1 text-left hover:bg-slate-800"
                onClick={() => setChosen(card)}
              >
                {card.name} <span className="text-xs text-slate-500">{card.typeLine}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
