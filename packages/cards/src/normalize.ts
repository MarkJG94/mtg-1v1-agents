/**
 * Oracle-text normalisation shared by the validator (text coverage) and the auto-scripter (Phase 3):
 * the card's own name becomes `~`, reminder text is dropped, and the text is split into sentences.
 */
export interface NormalizedText {
  /** One entry per line of oracle text, each split into sentences; flattened indices are used by `covers`. */
  lines: string[][];
  sentences: string[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Names a card refers to itself by: the full name and, for "Name, Title" cards, the short name. */
export function selfNames(name: string): string[] {
  const out = [name];
  const comma = name.indexOf(',');
  if (comma > 0) out.push(name.slice(0, comma));
  return out;
}

export function stripReminderText(text: string): string {
  return text.replace(/\s*\([^)]*\)/g, '');
}

export function replaceSelfName(text: string, name: string): string {
  let out = text;
  for (const n of selfNames(name)) out = out.replace(new RegExp(escapeRegExp(n), 'g'), '~');
  return out;
}

/** Splits a line into sentences on ". " boundaries, keeping mana symbols and P/T like "+1/+1." intact. */
export function splitSentences(line: string): string[] {
  const out: string[] = [];
  let current = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    current += ch;
    if (ch === '.' || ch === '?' || ch === '!') {
      const next = line[i + 1];
      if (next === undefined || next === ' ') {
        const trimmed = current.trim();
        if (trimmed) out.push(trimmed);
        current = '';
      }
    }
  }
  const rest = current.trim();
  if (rest) out.push(rest);
  return out;
}

export function normalizeOracleText(text: string | undefined, name: string): NormalizedText {
  const cleaned = replaceSelfName(stripReminderText(text ?? ''), name);
  const lines = cleaned
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map(splitSentences);
  return { lines, sentences: lines.flat() };
}

/** Whether a normalised line is a keyword line ("Flying, first strike"): short, no verbs, no colon. */
export function looksLikeKeywordLine(line: string): boolean {
  if (line.includes(':') || line.includes('~')) return false;
  const words = line.replace(/[.,]/g, '').split(/\s+/);
  return words.length <= 6 && !/\b(you|your|whenever|when|at|if|each|target|may)\b/i.test(line);
}
