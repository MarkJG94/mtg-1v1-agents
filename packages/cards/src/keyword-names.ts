import { type GrantableKeyword, grantableKeywords } from '@mtg/engine';

/**
 * How a keyword reads on a card, both ways round.
 *
 * The engine names keywords the way code does — `firstStrike` — and a card prints "First
 * strike". Two places need the translation and they need to agree: the validator, deciding
 * whether a keyword line is claimed by the script's `keywords:` list, and the auto-scripter's
 * normaliser, reading that line in the first place. A second copy of this table would be a
 * table that drifts, and the drift would look like a card whose text nobody claimed.
 *
 * Every keyword the engine can grant appears here; a test asserts it, so adding one to the
 * engine without a printed name fails rather than quietly becoming unreadable.
 */
const printed: Readonly<Record<GrantableKeyword, string>> = {
  flying: 'flying',
  reach: 'reach',
  menace: 'menace',
  vigilance: 'vigilance',
  haste: 'haste',
  defender: 'defender',
  firstStrike: 'first strike',
  doubleStrike: 'double strike',
  trample: 'trample',
  deathtouch: 'deathtouch',
  lifelink: 'lifelink',
  indestructible: 'indestructible',
  shroud: 'shroud',
  hexproof: 'hexproof',
};

const byPrinted: ReadonlyMap<string, GrantableKeyword> = new Map(
  grantableKeywords.map((keyword) => [printed[keyword], keyword]),
);

/** What a card prints for this keyword, in lower case. */
export const printedKeyword = (keyword: GrantableKeyword): string => printed[keyword];

/** The engine's name for a printed keyword, or `null` if it has none. */
export const keywordFromPrinted = (text: string): GrantableKeyword | null =>
  byPrinted.get(text.trim().toLowerCase()) ?? null;
