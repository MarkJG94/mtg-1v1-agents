import {
  asOracleId,
  type BanList,
  banViolations,
  type Deck75,
  type DecklistEntry,
  entriesCount,
  type OracleId,
  type ParsedDecklist,
  type ResolvedCard,
} from '@mtg/shared';

/**
 * A pasted decklist checked card by card (docs/08 "New run"): each line against what the
 * server made of its name, the counts against sixty and fifteen, the cards against the
 * engine's support and the initial ban list. The server checks the same again when the
 * run is made (docs/07 `400 invalid_seed_deck`); this is so a person sees which line is
 * wrong before sending it.
 */

export interface CheckedLine {
  readonly entry: DecklistEntry;
  readonly zone: 'main' | 'side';
  /** `undefined` while the server has not answered for its name. */
  readonly card: ResolvedCard | undefined;
}

export interface PastedDeck {
  readonly lines: readonly CheckedLine[];
  readonly mainCount: number;
  readonly sideCount: number;
  /** Each thing that stops the deck being used, worst first. */
  readonly problems: readonly string[];
  /** Names still being looked up. */
  readonly pending: number;
  /** The 75, when there is nothing wrong with it and nothing left to look up. */
  readonly deck: Deck75 | null;
}

/** How a name is looked up: the server matches without regard to case. */
export const nameKey = (name: string) => name.trim().toLowerCase();

/** The names a list needs looked up, each once. */
export const namesToResolve = (parsed: ParsedDecklist): string[] => {
  const seen = new Map<string, string>();
  for (const entry of [...parsed.main, ...parsed.side]) {
    if (!seen.has(nameKey(entry.name))) seen.set(nameKey(entry.name), entry.name);
  }
  return [...seen.values()];
};

export const checkPastedDeck = (
  parsed: ParsedDecklist,
  resolved: ReadonlyMap<string, ResolvedCard>,
  banList: BanList,
): PastedDeck => {
  const problems: string[] = parsed.problems.map(
    (problem) => `line ${problem.line}: ${problem.message}`,
  );
  const lines: CheckedLine[] = [
    ...parsed.main.map((entry) => ({ entry, zone: 'main' as const })),
    ...parsed.side.map((entry) => ({ entry, zone: 'side' as const })),
  ]
    .sort((a, b) => a.entry.line - b.entry.line)
    .map((line) => ({ ...line, card: resolved.get(nameKey(line.entry.name)) }));

  let pending = 0;
  const zones = { main: new Map<OracleId, number>(), side: new Map<OracleId, number>() };
  const names = new Map<OracleId, string>();
  for (const { entry, zone, card } of lines) {
    if (card === undefined) {
      pending += 1;
      continue;
    }
    if (card.oracleId === null || card.name === null) {
      problems.push(`line ${entry.line}: no card is named “${entry.name}”`);
      continue;
    }
    if (card.support !== 'supported') {
      problems.push(
        `line ${entry.line}: ${card.name} cannot be played yet (its script is ${card.support ?? 'unknown'})`,
      );
    }
    const oracleId = asOracleId(card.oracleId);
    names.set(oracleId, card.name);
    zones[zone].set(oracleId, (zones[zone].get(oracleId) ?? 0) + entry.count);
  }

  const mainCount = entriesCount(parsed.main);
  const sideCount = entriesCount(parsed.side);
  if (mainCount !== 60) problems.push(`the main deck has ${mainCount} cards, not 60`);
  if (sideCount !== 15) problems.push(`the sideboard has ${sideCount} cards, not 15`);

  const slots = (zone: Map<OracleId, number>) =>
    [...zone].map(([oracleId, count]) => ({ oracleId, count }));
  const deck: Deck75 = { main: slots(zones.main), side: slots(zones.side) };
  for (const violation of banViolations(deck, banList)) {
    const name = names.get(violation.oracleId) ?? violation.oracleId;
    problems.push(
      violation.status === 'banned'
        ? `${name} is banned`
        : `${name} is restricted to one copy, and the deck has ${violation.held}`,
    );
  }

  return {
    lines,
    mainCount,
    sideCount,
    problems,
    pending,
    deck: problems.length === 0 && pending === 0 ? deck : null,
  };
};
