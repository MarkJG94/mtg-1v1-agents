import type { CardProjection } from '../scryfall.js';
import { validateScript } from './../validate.js';
import { emitScript } from './emit.js';

/**
 * The golden corpus (docs/09 "Auto-scripter golden tests").
 *
 * What the auto-scripter makes of every card in the corpus, written down and committed.
 * A change to any rule in the pipeline shows up as a diff somebody has to read and accept,
 * which is the only way to notice that teaching the parser one template quietly changed
 * what it does with another.
 *
 * The cards that *fail* are as much the point as the ones that pass. Their recorded
 * reasons are the list of templates still to teach, and a card moving from unsupported to
 * supported is exactly the diff a coverage push wants to show.
 */

export interface Golden {
  readonly status: string;
  /** Why it is not supported, in the validator's words. Empty when it is. */
  readonly reasons: readonly string[];
  /** The script the auto-scripter wrote, or `null` when it could write none. */
  readonly script: unknown;
}

/** Computed fresh from the corpus; compared against the committed file by a test. */
export const goldensFor = (
  corpus: Readonly<Record<string, CardProjection>>,
): Record<string, Golden> => {
  const goldens: Record<string, Golden> = {};

  // By name and in name order: a diff should be about what changed, not about the order
  // Scryfall happened to answer in, and a name is what somebody reading it recognises.
  const cards = Object.values(corpus).sort((left, right) => left.name.localeCompare(right.name));

  for (const card of cards) {
    const emitted = emitScript(card);
    if (emitted.script === null) {
      goldens[card.name] = { status: 'unscripted', reasons: emitted.problems, script: null };
      continue;
    }

    const verdict = validateScript(emitted.script, card, { skipSmokeTest: false });
    goldens[card.name] = {
      status: verdict.status,
      reasons: verdict.reasons.map((reason) => `${reason.check}: ${reason.message}`),
      script: emitted.script,
    };
  }

  return goldens;
};

/** How many cards ended up at each verdict, which is the number worth reporting. */
export const tally = (
  goldens: Readonly<Record<string, Golden>>,
): Readonly<Record<string, number>> => {
  const counts: Record<string, number> = {};
  for (const golden of Object.values(goldens)) {
    counts[golden.status] = (counts[golden.status] ?? 0) + 1;
  }
  return counts;
};
