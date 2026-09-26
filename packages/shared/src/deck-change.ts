import type { DeckSlot } from './eventlog/log.js';
import type { Colour } from './game/colour.js';
import type { OracleId } from './ids.js';

/**
 * A deck change (docs/05 "Choosing the change"; roadmap 5.4): what the deck agent does to
 * the loser of a cycle, and the record of why. It is stored with the deck generation it
 * makes (docs/06 `deck_generations.change`) and shown in the UI, which is why it lives
 * here rather than with the agent.
 *
 * Two shapes, both keeping 60/15:
 *
 * - **`replace`**: all copies of one card in a zone out, as many copies of another in.
 * - **`swap`**: a main-deck card and a sideboard card trade places — `remove` names the
 *   main-deck card, which goes to the sideboard; `add` names the sideboard card, which
 *   comes into the main deck. docs/05's "moves between main and side".
 */

export type DeckZone = 'main' | 'side';

/** A deck as the evolution loop holds it: sixty to play and fifteen to sideboard from. */
export interface Deck75 {
  readonly main: readonly DeckSlot[];
  readonly side: readonly DeckSlot[];
}

export interface DeckChangeSlot {
  readonly oracleId: OracleId;
  readonly zone: DeckZone;
  readonly count: number;
}

/** Why the agent chose the slot it cut. */
export const diagnoses = [
  /** Too few lands too often: a spell out, a land in. */
  'screw',
  /** Too many: a land out, a spell in. */
  'flood',
  /** Spells held for want of a colour: a land that makes it in, or the card that needs it out. */
  'colourScrew',
  /** A sideboard card that did better when boarded in than the worst main-deck card. */
  'swap',
  /** A sideboard card that was never boarded in. */
  'idleSideboard',
  /** The main-deck card with the worst record. */
  'weakest',
] as const;
export type Diagnosis = (typeof diagnoses)[number];

/** The record of the slot that was cut, as the diagnosis read it. */
export interface SlotEvidence {
  readonly oracleId: OracleId;
  readonly name: string;
  readonly zone: DeckZone;
  readonly count: number;
  /** Shrunk win rate drawn less shrunk win rate not drawn (docs/05 Δ). */
  readonly delta: number;
  readonly deadInHandRate: number | null;
  readonly castRate: number | null;
  readonly gamesDrawn: number;
  /** What the diagnosis ranked it by: lower is worse. */
  readonly score: number;
}

export interface TrialEvidence {
  readonly matches: number;
  /** A drawn match counts half. */
  readonly winRate: number;
}

/** One card the replacement search looked at, in the order it ranked them. */
export interface CandidateEvidence {
  readonly oracleId: OracleId;
  readonly name: string;
  /** The static quality model's score, before the dice. */
  readonly staticScore: number;
  /** Whether the engine can play it; `null` if it was never scripted. */
  readonly supported: boolean | null;
  /** The whole score once scripted, which is what picks the finalists. */
  readonly score: number | null;
  readonly trial: TrialEvidence | null;
}

export interface DeckChangeEvidence {
  readonly diagnosis: Diagnosis;
  /** The deck-level rates the diagnosis read, over the games its statistics hold. */
  readonly deck: {
    readonly games: number;
    readonly winRate: number | null;
    readonly screwRate: number | null;
    readonly floodRate: number | null;
    readonly colourScrewRate: number | null;
  };
  readonly removed: SlotEvidence;
  /** For colour screw: the colour the lands are shortest of. */
  readonly starvedColour: Colour | null;
  /** The shortlist, best first. Empty for a swap, which searches nothing. */
  readonly candidates: readonly CandidateEvidence[];
}

export interface DeckChange {
  readonly shape: 'replace' | 'swap';
  readonly remove: DeckChangeSlot;
  readonly add: DeckChangeSlot;
  /** A sentence for a person: what was cut, what came in, and why. */
  readonly reason: string;
  readonly evidence: DeckChangeEvidence;
}

export class IllegalDeckChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalDeckChangeError';
  }
}

/**
 * The deck a change makes. It checks the change's own shape — the copies it removes are
 * there, and as many go in as come out, so 60/15 holds — and nothing else: whether the
 * card it adds may be played at all is the ban list's business (roadmap 5.5).
 */
export const applyDeckChange = (
  deck: Deck75,
  change: Pick<DeckChange, 'shape' | 'remove' | 'add'>,
): Deck75 => {
  const { remove, add } = change;
  if (remove.count !== add.count || remove.count <= 0) {
    throw new IllegalDeckChangeError(
      `a change must add as many cards as it removes, and some: ${remove.count} out, ${add.count} in`,
    );
  }
  const zones = { main: counted(deck.main), side: counted(deck.side) };
  if (change.shape === 'replace') {
    if (remove.zone !== add.zone) {
      throw new IllegalDeckChangeError('a replacement stays in one zone; a move is a swap');
    }
    take(zones[remove.zone], remove.oracleId, remove.count, remove.zone);
    give(zones[add.zone], add.oracleId, add.count);
  } else {
    if (remove.zone !== 'main' || add.zone !== 'main') {
      throw new IllegalDeckChangeError(
        'a swap names the card leaving the main deck and the one entering it',
      );
    }
    take(zones.main, remove.oracleId, remove.count, 'main');
    take(zones.side, add.oracleId, add.count, 'side');
    give(zones.main, add.oracleId, add.count);
    give(zones.side, remove.oracleId, remove.count);
  }
  return { main: slotsOf(zones.main), side: slotsOf(zones.side) };
};

const counted = (slots: readonly DeckSlot[]): Map<OracleId, number> => {
  const counts = new Map<OracleId, number>();
  for (const slot of slots)
    counts.set(slot.oracleId, (counts.get(slot.oracleId) ?? 0) + slot.count);
  return counts;
};

const take = (zone: Map<OracleId, number>, oracleId: OracleId, count: number, name: DeckZone) => {
  const held = zone.get(oracleId) ?? 0;
  if (held < count) {
    throw new IllegalDeckChangeError(`the ${name} deck holds ${held} of ${oracleId}, not ${count}`);
  }
  if (held === count) zone.delete(oracleId);
  else zone.set(oracleId, held - count);
};

const give = (zone: Map<OracleId, number>, oracleId: OracleId, count: number) => {
  zone.set(oracleId, (zone.get(oracleId) ?? 0) + count);
};

const slotsOf = (zone: ReadonlyMap<OracleId, number>): DeckSlot[] =>
  [...zone]
    .map(([oracleId, count]) => ({ oracleId, count }))
    .sort((a, b) => (a.oracleId < b.oracleId ? -1 : a.oracleId > b.oracleId ? 1 : 0));
