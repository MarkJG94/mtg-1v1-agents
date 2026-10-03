import defaults from './weights/default.json' with { type: 'json' };

/**
 * The evaluator's weights (docs/04 "Architecture: evaluator + bounded search").
 *
 * Data rather than constants in the code, for the reason docs/04 gives: weights start
 * hand-tuned, and the weight-tuning harness (roadmap 4.7) improves them by playing one set
 * against another and hill-climbing — without a code change, and so without a code path
 * that only the tuned weights ever run. A tuned set is a JSON file like
 * `weights/default.json`, and `parseWeights` is how one is let in.
 *
 * Every field is a number and every field is required. A weights file that left one out
 * would not mean "that term does not matter"; it would mean `undefined` arithmetic, which
 * is `NaN`, which compares false against everything, which is an agent that silently
 * picks the first option every time. So a missing, extra or non-finite field is refused.
 */
export interface Weights {
  /** The value of a won game, and the negative of a lost one. Dominates everything. */
  readonly win: number;

  // --- Life (CR 119) ---
  /** Per point of life, for either side. */
  readonly life: number;
  /** Extra per point *below* `dangerThreshold`: life matters more the less there is. */
  readonly lifeDanger: number;
  readonly dangerThreshold: number;
  /** Per poison counter; ten is a loss (CR 704.5c). */
  readonly poison: number;

  // --- Board ---
  readonly creaturePower: number;
  readonly creatureToughness: number;
  /** Extra per point of power a creature has that is hard to block: flying, menace, trample. */
  readonly evasivePower: number;
  /** Per combat keyword that makes a creature better in a fight. */
  readonly combatKeyword: number;
  /** The fraction of a creature's value it lacks while it cannot yet attack or tap. */
  readonly summoningSickness: number;
  /** Per mana of value for a permanent that is neither a creature nor a land. */
  readonly otherPermanent: number;
  readonly planeswalkerLoyalty: number;

  // --- Cards ---
  readonly cardInHand: number;
  /**
   * A land in the viewer's own hand once there are already enough (`landTarget`) in play
   * and in hand. Must stay below `landBeyondTarget`, or playing it looks like a loss.
   */
  readonly spareLand: number;
  /**
   * The projected turn-3 board a seven-card hand must reach to be kept (docs/04 item 5),
   * on the evaluator's scale; a smaller hand is held to its share of it.
   */
  readonly keepBoard: number;
  /** Penalty for an empty library: the next draw loses the game (CR 704.5b). */
  readonly emptyLibrary: number;

  // --- Mana development ---
  readonly land: number;
  /** Lands past this count are worth `landBeyondTarget` each instead of `land`. */
  readonly landTarget: number;
  readonly landBeyondTarget: number;
  /** Per colour a card in hand needs that nothing on the battlefield can make. */
  readonly missingColour: number;

  // --- Tempo ---
  /** Per untapped mana source held while there is an instant in hand to spend it on. */
  readonly heldMana: number;

  // --- Threats ---
  /** When a side's creatures could deal the other's life total on the next attack. */
  readonly lethalOnBoard: number;

  // --- Priors for what `greedy` cannot see (see greedy.ts) ---
  /** Per point of a targeted opposing creature's value, for a spell aimed at it. */
  readonly spellAtOpponentCreature: number;
  /** Per mana of a spell aimed at the opponent. */
  readonly spellAtOpponent: number;
  /** Per point of a targeted friendly creature's value, for a spell aimed at it. */
  readonly spellAtOwnCreature: number;
  /** Per mana of a spell with no target at all. */
  readonly spellUntargeted: number;
  /** For activating a loyalty ability, over and above the change in loyalty. */
  readonly loyaltyActivation: number;
}

/**
 * The file and the interface must name the same terms, both ways round: a term in the
 * interface the file forgot is `undefined` at run time, and a term in the file the
 * interface does not know about is a weight nothing reads. Checked when this compiles.
 */
type SameKeys<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? true
    : false
  : false;
void (true satisfies SameKeys<typeof defaults, Weights>);

const fields = Object.keys(defaults) as readonly (keyof Weights)[];

export class InvalidWeightsError extends Error {
  constructor(problems: readonly string[]) {
    super(`invalid evaluator weights: ${problems.join('; ')}`);
    this.name = 'InvalidWeightsError';
  }
}

/**
 * Accept a weights file only if it names every term, and nothing else, as a finite number,
 * and the terms that have to agree with each other do:
 *
 * - `spareLand` below `landBeyondTarget`. Playing a spare land moves it from one to the
 *   other, so if the spare in hand is worth as much as the land in play the evaluator
 *   never plays it — the bug `spareLand` was added to fix (4.3).
 * - `landTarget` and `dangerThreshold` whole and not negative: they are compared with a
 *   count of lands and a life total, so 7.5 lands means nothing that 8 does not.
 *
 * The tuning harness proposes weights no one has looked at, so this is the check that
 * stands between a proposal and a game.
 */
export const parseWeights = (input: unknown): Weights => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new InvalidWeightsError(['expected an object']);
  }
  const record = input as Readonly<Record<string, unknown>>;
  const problems: string[] = [];

  for (const field of fields) {
    const value = record[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      problems.push(`${field} must be a finite number, got ${JSON.stringify(value)}`);
    }
  }
  for (const key of Object.keys(record)) {
    if (!(fields as readonly string[]).includes(key)) problems.push(`${key} is not a weight`);
  }

  if (problems.length === 0) {
    const weights = record as unknown as Weights;
    if (!(weights.spareLand < weights.landBeyondTarget)) {
      problems.push('spareLand must be below landBeyondTarget, or a spare land is never played');
    }
    for (const count of ['landTarget', 'dangerThreshold'] as const) {
      if (!Number.isInteger(weights[count]) || weights[count] < 0) {
        problems.push(`${count} is a count, and must be a whole number of at least 0`);
      }
    }
  }

  if (problems.length > 0) throw new InvalidWeightsError(problems);
  return record as unknown as Weights;
};

/**
 * How the tuning harness may move each term (roadmap 4.7).
 *
 * - `scale`: multiplied or divided by the harness's step factor, so a term keeps its sign
 *   and its order of magnitude moves rather than its last decimal.
 * - `count`: moved by one, never below `min` — a number of lands or points of life.
 * - `fixed`: not tuned, and `why` says why.
 *
 * It lives beside the weights because what a term means is this package's to say; the
 * harness in `@mtg/sim` only reads it.
 */
export type TermTuning =
  | { readonly kind: 'scale' }
  | { readonly kind: 'count'; readonly min: number }
  | { readonly kind: 'fixed'; readonly why: string };

const scale: TermTuning = { kind: 'scale' };

export const weightTuning: { readonly [K in keyof Weights]: TermTuning } = {
  win: {
    kind: 'fixed',
    why: 'it only has to outweigh everything else; scaling it changes no decision until it stops',
  },
  life: scale,
  lifeDanger: scale,
  dangerThreshold: { kind: 'count', min: 0 },
  poison: scale,
  creaturePower: scale,
  creatureToughness: scale,
  evasivePower: scale,
  combatKeyword: scale,
  summoningSickness: scale,
  otherPermanent: scale,
  planeswalkerLoyalty: scale,
  cardInHand: scale,
  spareLand: scale,
  keepBoard: scale,
  emptyLibrary: scale,
  land: scale,
  landTarget: { kind: 'count', min: 1 },
  landBeyondTarget: scale,
  missingColour: scale,
  heldMana: scale,
  lethalOnBoard: scale,
  spellAtOpponentCreature: scale,
  spellAtOpponent: scale,
  spellAtOwnCreature: scale,
  spellUntargeted: scale,
  loyaltyActivation: scale,
};

/** The terms the harness moves, in the file's order. */
export const tunableTerms: readonly (keyof Weights)[] = fields.filter(
  (field) => weightTuning[field].kind !== 'fixed',
);

/** The hand-tuned starting point. Checked like any other file, so it cannot drift. */
export const defaultWeights: Weights = parseWeights(defaults);
