/**
 * A pasted decklist, read (docs/08 "New run": "paste a decklist which is validated
 * card-by-card"). The web app parses as the text is typed and asks the server to resolve
 * the names; the server checks the counts again when the run is made.
 *
 * What it reads, as the common exports write it:
 *
 * - `4 Lightning Bolt`, `4x Lightning Bolt`, or a name alone for one copy;
 * - an Arena-style set and number after the name, `4 Lightning Bolt (M11) 146`, ignored;
 * - `Sideboard` (or `Sideboard:`, `SB:`), or `SB: 2 Pyroblast` on the line itself, for the
 *   sideboard; `Deck`, `Main`, `Maindeck` and `Commander`-free headers are ignored;
 * - with no header at all, a second block after a blank line is the sideboard, which is
 *   how Arena and most sites export;
 * - a line starting with `//` or `#` is a comment, and so is ` #` and what follows it; a
 *   `//` inside a line is a split card's name (`Fire // Ice`), not a comment.
 */

export interface DecklistEntry {
  readonly count: number;
  readonly name: string;
  /** From 1, for pointing at the line a problem is on. */
  readonly line: number;
}

export interface DecklistProblem {
  readonly line: number;
  readonly text: string;
  readonly message: string;
}

export interface ParsedDecklist {
  readonly main: readonly DecklistEntry[];
  readonly side: readonly DecklistEntry[];
  readonly problems: readonly DecklistProblem[];
}

const SIDEBOARD_HEADER = /^(sideboard|sb)\s*:?\s*$/i;
const MAIN_HEADER = /^(deck|main|maindeck|main deck|mainboard)\s*:?\s*$/i;
const SB_PREFIX = /^sb\s*:\s*/i;
const ENTRY = /^(?:(\d+)\s*x?\s+)?(.+?)$/i;
/** Arena's "(SET) 123" after a name, and a trailing collector number with it. */
const SET_SUFFIX = /\s+\([A-Za-z0-9]{2,6}\)(\s+[\w-]+)?\s*$/;

export const parseDecklist = (text: string): ParsedDecklist => {
  const main: DecklistEntry[] = [];
  const side: DecklistEntry[] = [];
  const problems: DecklistProblem[] = [];
  const lines = text.split(/\r?\n/);
  const hasHeader = lines.some((line) => SIDEBOARD_HEADER.test(line.trim()));

  let inSide = false;
  let seenEntry = false;
  let blankAfterEntries = false;

  lines.forEach((raw, index) => {
    const number = index + 1;
    // A comment is not a blank line: it does not start the sideboard.
    if (/^\s*(\/\/|#)/.test(raw)) return;
    const line = raw.replace(/\s#.*$/, '').trim();
    if (line.length === 0) {
      if (seenEntry) blankAfterEntries = true;
      return;
    }
    if (SIDEBOARD_HEADER.test(line)) {
      inSide = true;
      return;
    }
    if (MAIN_HEADER.test(line)) return;

    // No header anywhere: the block after the first blank line is the sideboard.
    if (!hasHeader && blankAfterEntries && !inSide) inSide = true;

    let body = line;
    let toSide = inSide;
    if (SB_PREFIX.test(body)) {
      body = body.replace(SB_PREFIX, '');
      toSide = true;
    }
    const entry = body.replace(SET_SUFFIX, '').trim();
    if (/^\d+\s*x?$/i.test(entry)) {
      problems.push({ line: number, text: raw, message: 'no card name' });
      return;
    }
    const match = ENTRY.exec(entry);
    const name = match?.[2]?.trim() ?? '';
    const count = match?.[1] === undefined ? 1 : Number(match[1]);
    if (name.length === 0) {
      problems.push({ line: number, text: raw, message: 'no card name' });
      return;
    }
    if (!Number.isInteger(count) || count < 1) {
      problems.push({ line: number, text: raw, message: 'a count is a whole number from 1' });
      return;
    }
    (toSide ? side : main).push({ count, name, line: number });
    seenEntry = true;
  });

  return { main, side, problems };
};

/** How many cards a list of entries holds. */
export const entriesCount = (entries: readonly DecklistEntry[]): number =>
  entries.reduce((sum, entry) => sum + entry.count, 0);
