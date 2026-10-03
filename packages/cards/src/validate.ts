import type { CardDefinition } from '@mtg/engine';
import { type CheckProblem, checkCharacteristics, checkCoverage } from './checks.js';
import { loadCardScript, ScriptError } from './load.js';
import { cardScriptSchema } from './schema.js';
import type { CardProjection } from './scryfall.js';
import { smokeTest } from './smoke.js';

/**
 * `validateScript(script, card)` — the four checks docs/03 asks for, in one answer.
 *
 * The three verdicts mean different things, and the difference is the point:
 *
 * - **unsupported** — the script is wrong. It does not load, it disagrees with the
 *   printed card, or the engine throws when the card is played. Nothing should use it.
 * - **partial** — the script is right about what it does, but does not do everything the
 *   card says. Partial scripts are never played (decision D-partial in docs/03); they are
 *   listed so somebody can finish them.
 * - **supported** — loads, agrees with Scryfall, claims every sentence, and survives being
 *   played.
 *
 * The version is part of the answer because verdicts are cached (roadmap 2.4): a cached
 * "unsupported" from an older validator has to be re-earned rather than believed.
 */

export const VALIDATOR_VERSION = 1;

export type ValidationStatus = 'supported' | 'partial' | 'unsupported';

export interface ValidationResult {
  readonly status: ValidationStatus;
  readonly reasons: readonly CheckProblem[];
  readonly validatorVersion: number;
  /** The loaded card, when it loaded at all — callers usually want it anyway. */
  readonly definition: CardDefinition | null;
  /** Scenarios the smoke test could not cast the card in, which is not a failure. */
  readonly skipped: readonly string[];
}

export interface ValidateOptions {
  /** Skip playing the card. For a caller that only wants the cheap checks. */
  readonly skipSmokeTest?: boolean;
}

export const validateScript = (
  input: unknown,
  card: CardProjection,
  options: ValidateOptions = {},
): ValidationResult => {
  const parsed = cardScriptSchema.safeParse(input);
  let definition: CardDefinition;
  try {
    if (!parsed.success) throw new ScriptError('card script', '', 'did not match the schema');
    definition = loadCardScript(input);
  } catch (error) {
    return {
      status: 'unsupported',
      reasons: [{ check: 'schema', message: (error as Error).message }],
      validatorVersion: VALIDATOR_VERSION,
      definition: null,
      skipped: [],
    };
  }

  const script = parsed.data;
  const characteristics = checkCharacteristics(script, definition, card);
  const coverage = checkCoverage(script, card);
  const smoke = options.skipSmokeTest === true ? null : smokeTest(definition);

  const fatal = [...characteristics, ...coverage.problems, ...(smoke?.problems ?? [])];

  // An unclaimed sentence is the one kind of finding that is not an error: the script is
  // right as far as it goes, and says so by leaving the rest unclaimed.
  const unclaimed: CheckProblem[] = coverage.unclaimed.map((index) => ({
    check: 'coverage',
    message: `sentence ${index} is not claimed by any ability: "${coverage.sentences[index] ?? ''}"`,
  }));

  return {
    status: fatal.length > 0 ? 'unsupported' : unclaimed.length > 0 ? 'partial' : 'supported',
    reasons: [...fatal, ...unclaimed],
    validatorVersion: VALIDATOR_VERSION,
    definition,
    skipped: smoke?.skipped ?? [],
  };
};
