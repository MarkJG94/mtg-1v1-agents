import {
  agentLevels,
  asOracleId,
  type BanList,
  type CardSummary,
  type CreateRunRequest,
  colours,
  legalityFilters,
  parseDecklist,
  type ResolvedCard,
  type RunSettings,
  runSettingsRequestSchema,
  runSettingsSchema,
  type SeedDeckPreview,
  validateSeedDeckColours,
} from '@mtg/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { api, describeError } from '../api.js';
import { CardTile, SupportBadge, sortForDisplay } from '../components/cards.js';
import { checkPastedDeck, nameKey, namesToResolve } from '../deck-paste.js';
import { navigate, runPath } from '../router.js';
import { runsQueryKey } from './RunsPage.js';

/**
 * The new-run form (docs/08 "New run"): the settings, with docs/05's defaults; the seed
 * deck, rolled and previewed — the 75 with images and support status — or pasted and
 * checked card by card; and an initial ban list, searched for or pasted.
 *
 * A roll fills in the seed it was rolled from, and a run made with that seed gets the deck
 * the preview showed: both come from `seedDeckFor` on the server.
 */

type SettingsForm = Omit<RunSettings, 'seed' | 'seedDeck' | 'changeSize'>;

/** docs/05's defaults, read from the schema that applies them rather than written again. */
export const defaultSettings = (): SettingsForm => {
  const {
    seed: _seed,
    seedDeck: _mode,
    changeSize: _size,
    ...rest
  } = runSettingsSchema.parse({
    seed: '0',
  });
  return rest;
};

export interface BanDraft {
  readonly oracleId: string;
  readonly name: string;
  readonly status: 'banned' | 'restricted';
  readonly note: string;
}

type DeckMode = 'roll' | 'paste';

/** The settings a roll depends on: change one and the preview is no longer this run's deck. */
const deckKey = (settings: SettingsForm, seed: string, bans: readonly BanDraft[]) =>
  JSON.stringify([
    seed,
    settings.seedDeckColours,
    settings.seedDeckLands,
    settings.seedDeckLandsJitter,
    settings.legalityFilter,
    bans.map((ban) => [ban.oracleId, ban.status]),
  ]);

export const NewRunPage = () => {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [settings, setSettings] = useState<SettingsForm>(defaultSettings);
  const [seed, setSeed] = useState('');
  const [mode, setMode] = useState<DeckMode>('roll');
  const [bans, setBans] = useState<BanDraft[]>([]);
  const [pasted, setPasted] = useState('');
  const [resolved, setResolved] = useState<ReadonlyMap<string, ResolvedCard>>(new Map());

  const settingsRequest = {
    ...settings,
    seedDeck: mode === 'paste' ? ('fixed' as const) : ('constrainedRandom' as const),
    ...(seed.trim() === '' ? {} : { seed: seed.trim() }),
  };
  const parsedSettings = runSettingsRequestSchema.safeParse(settingsRequest);
  const settingsProblems = [
    ...(parsedSettings.success
      ? []
      : parsedSettings.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)),
    ...validateSeedDeckColours(settings),
  ];
  const banRequest = bans.map(({ oracleId, status, note }) => ({ oracleId, status, note }));
  const banList: BanList = useMemo(
    () => new Map(bans.map((ban) => [asOracleId(ban.oracleId), ban.status])),
    [bans],
  );

  // --- Rolling ---
  const [preview, setPreview] = useState<{ deck: SeedDeckPreview; key: string } | null>(null);
  const roll = useMutation({
    mutationFn: async (fresh: boolean) => {
      // The key is of what was asked for, whatever changes while the roll is out.
      const asked = { settings, bans };
      const { seed: _seed, ...rest } = settingsRequest;
      const deck = await api.rollSeedDeck({
        settings: fresh ? rest : settingsRequest,
        bans: banRequest,
      });
      return { deck, key: deckKey(asked.settings, deck.seed, asked.bans) };
    },
    onSuccess: (rolled) => {
      setSeed(rolled.deck.seed);
      setPreview(rolled);
    },
  });
  const stale = preview !== null && preview.key !== deckKey(settings, seed.trim(), bans);

  // --- Pasting ---
  const parsed = useMemo(() => parseDecklist(pasted), [pasted]);
  const checked = useMemo(
    () => checkPastedDeck(parsed, resolved, banList),
    [parsed, resolved, banList],
  );
  const [resolveError, setResolveError] = useState<string | null>(null);
  const asked = useRef(new Set<string>());
  useEffect(() => {
    if (mode !== 'paste') return;
    const wanted = namesToResolve(parsed).filter((each) => !asked.current.has(nameKey(each)));
    if (wanted.length === 0) return;
    const timer = setTimeout(async () => {
      for (const each of wanted) asked.current.add(nameKey(each));
      try {
        const answers: ResolvedCard[] = [];
        for (let start = 0; start < wanted.length; start += 250) {
          const { cards } = await api.resolveCards(wanted.slice(start, start + 250));
          answers.push(...cards);
        }
        setResolveError(null);
        setResolved((known) => {
          const next = new Map(known);
          for (const card of answers) next.set(nameKey(card.query), card);
          return next;
        });
      } catch (error) {
        // Asked again on the next edit.
        for (const each of wanted) asked.current.delete(nameKey(each));
        setResolveError(describeError(error));
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [parsed, mode]);

  // --- Creating ---
  const create = useMutation({
    mutationFn: () => {
      const body: CreateRunRequest = {
        name: name.trim(),
        settings: settingsRequest,
        bans: banRequest,
        ...(mode === 'paste' && checked.deck !== null
          ? { seedDeck: { main: [...checked.deck.main], side: [...checked.deck.side] } }
          : {}),
      };
      return api.createRun(body);
    },
    onSuccess: (run) => {
      void queryClient.invalidateQueries({ queryKey: runsQueryKey });
      navigate(runPath(run.id));
    },
  });

  const blockers = [
    ...(name.trim() === '' ? ['the run needs a name'] : []),
    ...settingsProblems,
    ...(mode === 'paste' && checked.deck === null
      ? [
          checked.pending > 0
            ? 'the pasted cards are still being checked'
            : 'the pasted deck has problems',
        ]
      : []),
  ];

  const set = <K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) =>
    setSettings((current) => ({ ...current, [key]: value }));

  return (
    <form
      className="flex flex-col gap-8"
      onSubmit={(event) => {
        event.preventDefault();
        if (blockers.length === 0) create.mutate();
      }}
    >
      <h1 className="text-2xl font-semibold tracking-tight">New run</h1>

      <Section title="Run">
        <label className="field max-w-md">
          <span>Name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Vintage, search agents"
            required
          />
        </label>
        <label className="field max-w-md">
          <span>Seed (empty for a random one)</span>
          <input
            value={seed}
            inputMode="numeric"
            onChange={(event) => setSeed(event.target.value)}
            placeholder="random"
          />
        </label>
      </Section>

      <Section title="Settings">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          <NumberField
            label="Matches per cycle"
            value={settings.matchesPerCycle}
            onChange={(value) => set('matchesPerCycle', value)}
          />
          <NumberField
            label="Tie margin"
            step={0.01}
            value={settings.tieMargin}
            onChange={(value) => set('tieMargin', value)}
          />
          <NumberField
            label="Tiebreak matches"
            value={settings.tiebreakMatches}
            onChange={(value) => set('tiebreakMatches', value)}
          />
          <NumberField
            label="Turn cap"
            value={settings.turnCap}
            onChange={(value) => set('turnCap', value)}
          />
          <NumberField
            label="Shortlist size"
            value={settings.shortlistSize}
            onChange={(value) => set('shortlistSize', value)}
          />
          <NumberField
            label="Trial candidates"
            value={settings.trialTopK}
            onChange={(value) => set('trialTopK', value)}
          />
          <NumberField
            label="Trial matches"
            value={settings.trialMatches}
            onChange={(value) => set('trialMatches', value)}
          />
          <NumberField
            label="Sideboard swaps"
            value={settings.maxSideboardSwaps}
            onChange={(value) => set('maxSideboardSwaps', value)}
          />
          <label className="field">
            <span>Agent level</span>
            <select
              value={settings.agentLevel}
              onChange={(event) =>
                set('agentLevel', event.target.value as SettingsForm['agentLevel'])
              }
            >
              {agentLevels.map((level) => (
                <option key={level}>{level}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Card pool</span>
            <select
              value={settings.legalityFilter}
              onChange={(event) =>
                set('legalityFilter', event.target.value as SettingsForm['legalityFilter'])
              }
            >
              {legalityFilters.map((filter) => (
                <option key={filter}>{filter}</option>
              ))}
            </select>
          </label>
        </div>
      </Section>

      <Section title="Seed deck">
        <div className="flex gap-4" role="radiogroup" aria-label="Seed deck">
          {(['roll', 'paste'] as const).map((each) => (
            <label key={each} className="flex items-center gap-2">
              <input
                type="radio"
                name="deck-mode"
                checked={mode === each}
                onChange={() => setMode(each)}
              />
              {each === 'roll' ? 'Roll one from the seed' : 'Paste a decklist'}
            </label>
          ))}
        </div>

        {mode === 'roll' && (
          <RollPanel
            settings={settings}
            onColours={(value) => set('seedDeckColours', value)}
            onLands={(value) => set('seedDeckLands', value)}
            onJitter={(value) => set('seedDeckLandsJitter', value)}
            preview={preview?.deck ?? null}
            stale={stale}
            rolling={roll.isPending}
            error={roll.isError ? describeError(roll.error) : null}
            canRoll={settingsProblems.length === 0}
            onRoll={(fresh) => roll.mutate(fresh)}
          />
        )}

        {mode === 'paste' && (
          <PastePanel text={pasted} onText={setPasted} checked={checked} error={resolveError} />
        )}
      </Section>

      <Section title="Initial ban list">
        <BanEditor bans={bans} onChange={setBans} />
      </Section>

      <footer className="flex flex-wrap items-center gap-4 border-t border-slate-800 pt-6">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={blockers.length > 0 || create.isPending}
        >
          {create.isPending ? 'Creating…' : 'Create run'}
        </button>
        {blockers.length > 0 && (
          <span className="text-sm text-slate-400" data-testid="blockers">
            {blockers.join('; ')}
          </span>
        )}
        {create.isError && (
          <p role="alert" className="w-full text-orange-300">
            {describeError(create.error)}
          </p>
        )}
      </footer>
    </form>
  );
};

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="flex flex-col gap-4">
    <h2 className="text-sm font-medium uppercase tracking-wide text-slate-400">{title}</h2>
    {children}
  </section>
);

const NumberField = ({
  label,
  value,
  onChange,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  step?: number;
}) => (
  <label className="field">
    <span>{label}</span>
    <input
      type="number"
      step={step}
      value={Number.isNaN(value) ? '' : value}
      onChange={(event) =>
        onChange(event.target.value === '' ? Number.NaN : Number(event.target.value))
      }
    />
  </label>
);

// --- Rolling ---

const RollPanel = ({
  settings,
  onColours,
  onLands,
  onJitter,
  preview,
  stale,
  rolling,
  error,
  canRoll,
  onRoll,
}: {
  settings: SettingsForm;
  onColours: (value: SettingsForm['seedDeckColours']) => void;
  onLands: (value: number) => void;
  onJitter: (value: number) => void;
  preview: SeedDeckPreview | null;
  stale: boolean;
  rolling: boolean;
  error: string | null;
  canRoll: boolean;
  onRoll: (fresh: boolean) => void;
}) => {
  const [images, setImages] = useState(true);
  const chosen = settings.seedDeckColours;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-4">
        <fieldset className="field">
          <legend className="mb-1 text-xs text-slate-400">Colours (none: rolled, 1–3)</legend>
          <div className="flex gap-1">
            {colours.map((colour) => (
              <button
                key={colour}
                type="button"
                aria-pressed={chosen.includes(colour)}
                className={`btn btn-small w-9 ${chosen.includes(colour) ? 'btn-primary' : ''}`}
                onClick={() =>
                  onColours(
                    chosen.includes(colour)
                      ? chosen.filter((each) => each !== colour)
                      : [...chosen, colour],
                  )
                }
              >
                {colour}
              </button>
            ))}
          </div>
        </fieldset>
        <NumberField label="Lands" value={settings.seedDeckLands} onChange={onLands} />
        <NumberField label="Lands ±" value={settings.seedDeckLandsJitter} onChange={onJitter} />
        <button
          type="button"
          className="btn"
          disabled={!canRoll || rolling}
          onClick={() => onRoll(false)}
        >
          {rolling ? 'Rolling…' : preview === null ? 'Roll' : 'Show this seed’s deck'}
        </button>
        {preview !== null && (
          <button
            type="button"
            className="btn"
            disabled={!canRoll || rolling}
            onClick={() => onRoll(true)}
          >
            Roll a new seed
          </button>
        )}
      </div>
      {error !== null && (
        <p role="alert" className="text-orange-300">
          {error}
        </p>
      )}
      {preview !== null && (
        <div className="flex flex-col gap-3" data-testid="preview">
          {stale && (
            <p role="status" className="rounded border border-amber-700 bg-amber-950 p-2 text-sm">
              The seed or deck settings have changed since this roll: the run will get a different
              deck. Show this seed’s deck to see it.
            </p>
          )}
          <p className="text-sm text-slate-300">
            Seed <code className="text-slate-100">{preview.seed}</code> ·{' '}
            {preview.colours.join('') || 'colourless'} · {preview.lands} lands (
            {preview.nonbasicLands} nonbasic)
            {preview.rerolled.length > 0 &&
              ` · ${preview.rerolled.length} cards put back because the engine cannot play them`}
          </p>
          <label className="flex items-center gap-2 text-sm text-slate-400">
            <input
              type="checkbox"
              checked={images}
              onChange={(event) => setImages(event.target.checked)}
            />
            Card images
          </label>
          <DeckGrid title="Main" cards={preview.main} images={images} />
          <DeckGrid title="Sideboard" cards={preview.side} images={images} />
        </div>
      )}
    </div>
  );
};

const DeckGrid = ({
  title,
  cards,
  images,
}: {
  title: string;
  cards: SeedDeckPreview['main'];
  images: boolean;
}) => (
  <div>
    <h3 className="mb-2 text-sm text-slate-400">
      {title} · {cards.reduce((sum, card) => sum + card.count, 0)}
    </h3>
    <ul className="grid grid-cols-3 gap-3 sm:grid-cols-5 lg:grid-cols-8" aria-label={title}>
      {sortForDisplay(cards).map((card) => (
        <CardTile key={card.oracleId} card={card} images={images} />
      ))}
    </ul>
  </div>
);

// --- Pasting ---

const PastePanel = ({
  text,
  onText,
  checked,
  error,
}: {
  text: string;
  onText: (text: string) => void;
  checked: ReturnType<typeof checkPastedDeck>;
  error: string | null;
}) => (
  <div className="grid gap-4 lg:grid-cols-2">
    <label className="field">
      <span>Decklist (a “Sideboard” line, or a blank line, before the fifteen)</span>
      <textarea
        rows={18}
        value={text}
        onChange={(event) => onText(event.target.value)}
        className="font-mono text-sm"
        placeholder={'4 Lightning Bolt\n20 Mountain\n…\n\nSideboard\n3 Pyroblast\n…'}
      />
    </label>
    <div className="flex flex-col gap-2 text-sm">
      <p className="tabular-nums" data-testid="paste-counts">
        Main {checked.mainCount}/60 · Sideboard {checked.sideCount}/15
        {checked.pending > 0 && ` · checking ${checked.pending} lines…`}
      </p>
      {error !== null && (
        <p role="alert" className="text-orange-300">
          Could not check the cards: {error}
        </p>
      )}
      {checked.problems.length > 0 && (
        <ul className="list-inside list-disc text-orange-300" aria-label="Problems">
          {checked.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      {checked.lines.length > 0 && (
        <table className="w-full text-left">
          <tbody>
            {checked.lines.map(({ entry, zone, card }) => (
              <tr key={entry.line} className="border-t border-slate-800">
                <td className="py-1 pr-2 tabular-nums text-slate-500">{entry.count}</td>
                <td className="py-1 pr-2">
                  {card?.name ?? entry.name}
                  {zone === 'side' && <span className="ml-2 text-xs text-slate-500">side</span>}
                </td>
                <td className="py-1 text-right">
                  {card === undefined ? (
                    <span className="text-slate-500">…</span>
                  ) : card.oracleId === null ? (
                    <span className="text-orange-300">not found</span>
                  ) : (
                    <SupportBadge support={card.support ?? 'unscripted'} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {checked.deck !== null && <p className="text-sky-300">The 75 is ready.</p>}
    </div>
  </div>
);

// --- Bans ---

const BanEditor = ({
  bans,
  onChange,
}: {
  bans: BanDraft[];
  onChange: (bans: BanDraft[]) => void;
}) => {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const search = useQuery({
    queryKey: ['cards', debounced],
    queryFn: () => api.searchCards(debounced),
    enabled: debounced.length >= 2,
  });

  const [names, setNames] = useState('');
  const [missing, setMissing] = useState<string[]>([]);
  const add = (card: Pick<CardSummary, 'oracleId' | 'name'>, status: BanDraft['status']) => {
    const others = bans.filter((ban) => ban.oracleId !== card.oracleId);
    const note = bans.find((ban) => ban.oracleId === card.oracleId)?.note ?? '';
    onChange([...others, { oracleId: card.oracleId, name: card.name, status, note }]);
  };
  const paste = useMutation({
    mutationFn: (list: string[]) => api.resolveCards(list, false),
    onSuccess: ({ cards }) => {
      const found = new Map(bans.map((ban) => [ban.oracleId, ban]));
      const notFound: string[] = [];
      for (const card of cards) {
        if (card.oracleId === null || card.name === null) notFound.push(card.query);
        else if (!found.has(card.oracleId)) {
          found.set(card.oracleId, {
            oracleId: card.oracleId,
            name: card.name,
            status: 'banned',
            note: '',
          });
        }
      }
      onChange([...found.values()]);
      setMissing(notFound);
      if (notFound.length === 0) setNames('');
    },
  });

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="flex flex-col gap-4">
        <label className="field">
          <span>Search for a card</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Black Lotus"
          />
        </label>
        {search.data !== undefined && debounced.length >= 2 && (
          <ul className="flex flex-col gap-1 text-sm" aria-label="Search results">
            {search.data.cards.length === 0 && <li className="text-slate-500">No cards match.</li>}
            {search.data.cards.map((card) => (
              <li key={card.oracleId} className="flex items-center justify-between gap-2">
                <span>
                  {card.name} <span className="text-slate-500">{card.typeLine}</span>
                </span>
                <span className="flex gap-1">
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => add(card, 'banned')}
                    aria-label={`Ban ${card.name}`}
                  >
                    Ban
                  </button>
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => add(card, 'restricted')}
                    aria-label={`Restrict ${card.name}`}
                  >
                    Restrict
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
        <label className="field">
          <span>Or paste names, one a line, to ban</span>
          <textarea rows={4} value={names} onChange={(event) => setNames(event.target.value)} />
        </label>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn"
            disabled={paste.isPending || names.trim() === ''}
            onClick={() => {
              const list = names
                .split(/\r?\n/)
                .map((line) => line.replace(/^\s*\d+\s*x?\s+/i, '').trim())
                .filter((line) => line.length > 0);
              if (list.length > 0) paste.mutate(list.slice(0, 250));
            }}
          >
            Add pasted names
          </button>
          {paste.isError && (
            <span role="alert" className="text-orange-300">
              {describeError(paste.error)}
            </span>
          )}
        </div>
        {missing.length > 0 && (
          <p role="alert" className="text-sm text-orange-300">
            No card is named {missing.map((each) => `“${each}”`).join(', ')}.
          </p>
        )}
      </div>

      <div>
        {bans.length === 0 ? (
          <p className="text-sm text-slate-500">No cards banned or restricted.</p>
        ) : (
          <table className="w-full text-left text-sm" aria-label="Ban list">
            <tbody>
              {bans.map((ban) => (
                <tr key={ban.oracleId} className="border-t border-slate-800">
                  <td className="py-1 pr-2">{ban.name}</td>
                  <td className="py-1 pr-2">
                    <select
                      aria-label={`Status of ${ban.name}`}
                      value={ban.status}
                      onChange={(event) =>
                        onChange(
                          bans.map((each) =>
                            each.oracleId === ban.oracleId
                              ? { ...each, status: event.target.value as BanDraft['status'] }
                              : each,
                          ),
                        )
                      }
                    >
                      <option value="banned">banned</option>
                      <option value="restricted">restricted</option>
                    </select>
                  </td>
                  <td className="py-1 pr-2">
                    <input
                      aria-label={`Note on ${ban.name}`}
                      value={ban.note}
                      placeholder="note"
                      onChange={(event) =>
                        onChange(
                          bans.map((each) =>
                            each.oracleId === ban.oracleId
                              ? { ...each, note: event.target.value }
                              : each,
                          ),
                        )
                      }
                    />
                  </td>
                  <td className="py-1 text-right">
                    <button
                      type="button"
                      className="btn btn-small"
                      aria-label={`Remove ${ban.name}`}
                      onClick={() =>
                        onChange(bans.filter((each) => each.oracleId !== ban.oracleId))
                      }
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};
