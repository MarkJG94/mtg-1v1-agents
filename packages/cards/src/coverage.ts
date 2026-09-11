import { GrammarAutoScripter } from './auto/index.js';
import type { ScryfallCard } from './scryfall.js';
import { type ScriptStatus, validateScript } from './validate.js';

/**
 * Grammar coverage over a whole card database (docs/03 §Auto-scripter, roadmap 3.5). The report answers
 * two questions: how much of Magic can be played today, and which templates to write next.
 */
export interface CoverageRow {
  oracleId: string;
  name: string;
  status: ScriptStatus;
  source: 'hand' | 'auto';
  reasons: string[];
}

export interface FailingPattern {
  pattern: string;
  count: number;
  /** A few card names, so the pattern can be looked up while writing the grammar rule. */
  examples: string[];
}

export interface CoverageReport {
  generatedAt: string;
  parserVersion: number;
  total: number;
  counts: Record<ScriptStatus, number>;
  handScripted: number;
  autoScripted: number;
  /** `supported` as a fraction of the whole database. */
  supportedFraction: number;
  patterns: FailingPattern[];
  cards: CoverageRow[];
}

/**
 * Groups a failure message into a template the grammar could learn: the rule that gave up plus the first
 * few words it could not read. "effect: return target creature card from" is actionable; a card name is not.
 */
export function failurePattern(reason: string): string {
  const m = /^(?:sentence \d+: )?([a-z ]+): (.*)$/i.exec(reason);
  if (!m) return reason.slice(0, 60);
  const head = m[2]!
    .split(/\s+/)
    .filter((w) => w !== '.' && w.length > 0)
    .slice(0, 5)
    .join(' ')
    .toLowerCase();
  return `${m[1]!.trim()}: ${head}`;
}

export interface CoverageOptions {
  /** Hand scripts keyed by oracle id; they win over the grammar, exactly as the resolver orders them. */
  handScripts?: Map<string, unknown>;
  /** Executability smoke games are the slow part (≈ 1 s/card), so they are opt-in. */
  smoke?: boolean;
  /** Called every `progressEvery` cards so a long run is not silent. */
  onProgress?: (done: number, total: number) => void;
  progressEvery?: number;
}

export function coverageReport(
  cards: readonly ScryfallCard[],
  opts: CoverageOptions = {},
): CoverageReport {
  const handScripts = opts.handScripts ?? new Map<string, unknown>();
  const scripter = new GrammarAutoScripter();
  const validateOptions = { skipSmoke: opts.smoke !== true };
  const rows: CoverageRow[] = [];
  const counts: Record<ScriptStatus, number> = { supported: 0, partial: 0, unsupported: 0 };
  const patterns = new Map<string, FailingPattern>();
  let handScripted = 0;
  let autoScripted = 0;
  const every = opts.progressEvery ?? 2000;

  cards.forEach((card, i) => {
    const row = resolveOne(card, handScripts, scripter, validateOptions);
    rows.push(row);
    counts[row.status]++;
    if (row.status === 'supported') {
      if (row.source === 'hand') handScripted++;
      else autoScripted++;
    } else {
      for (const p of new Set(row.reasons.map(failurePattern))) {
        const entry = patterns.get(p) ?? { pattern: p, count: 0, examples: [] };
        entry.count++;
        if (entry.examples.length < 3) entry.examples.push(card.name);
        patterns.set(p, entry);
      }
    }
    if (opts.onProgress && (i + 1) % every === 0) opts.onProgress(i + 1, cards.length);
  });

  return {
    generatedAt: new Date().toISOString(),
    parserVersion: scripter.version,
    total: cards.length,
    counts,
    handScripted,
    autoScripted,
    supportedFraction: cards.length === 0 ? 0 : counts.supported / cards.length,
    patterns: [...patterns.values()].sort((a, b) => b.count - a.count),
    cards: rows,
  };
}

function resolveOne(
  card: ScryfallCard,
  handScripts: Map<string, unknown>,
  scripter: GrammarAutoScripter,
  validateOptions: { skipSmoke: boolean },
): CoverageRow {
  const base = { oracleId: card.oracle_id, name: card.name };
  const hand = handScripts.get(card.oracle_id);
  if (hand !== undefined) {
    const v = validateScript(hand, card, validateOptions);
    return { ...base, status: v.status, source: 'hand', reasons: v.reasons };
  }
  const attempt = scripter.explain(card);
  if (!attempt.script)
    return { ...base, status: 'unsupported', source: 'auto', reasons: attempt.reasons };
  const v = validateScript(attempt.script, card, validateOptions);
  return { ...base, status: v.status, source: 'auto', reasons: v.reasons };
}

/** The human-readable half of the report, printed by `pnpm cards:coverage` and committed by the nightly run. */
export function formatCoverage(report: CoverageReport, topPatterns = 25): string {
  const pct = (n: number): string => `${((n / Math.max(1, report.total)) * 100).toFixed(1)}%`;
  const lines = [
    `# Card coverage`,
    '',
    `Parser version ${report.parserVersion} · ${report.total} cards · ${report.generatedAt}`,
    '',
    `| Status | Cards | Share |`,
    `| --- | ---: | ---: |`,
    `| supported | ${report.counts.supported} | ${pct(report.counts.supported)} |`,
    `| partial | ${report.counts.partial} | ${pct(report.counts.partial)} |`,
    `| unsupported | ${report.counts.unsupported} | ${pct(report.counts.unsupported)} |`,
    '',
    `Supported by hand script: ${report.handScripted}; by the auto-scripter: ${report.autoScripted}.`,
    '',
    `## Top failing patterns`,
    '',
    `| Cards | Pattern | Examples |`,
    `| ---: | --- | --- |`,
  ];
  for (const p of report.patterns.slice(0, topPatterns))
    lines.push(`| ${p.count} | \`${p.pattern}\` | ${p.examples.join(', ')} |`);
  return `${lines.join('\n')}\n`;
}
