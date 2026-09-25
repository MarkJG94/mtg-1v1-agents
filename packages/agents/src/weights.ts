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

/** Accept a weights file only if it names every term, and nothing else, as a finite number. */
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

  if (problems.length > 0) throw new InvalidWeightsError(problems);
  return record as unknown as Weights;
};

/** The hand-tuned starting point. Checked like any other file, so it cannot drift. */
export const defaultWeights: Weights = parseWeights(defaults);
