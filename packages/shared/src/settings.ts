import { z } from 'zod';
import { colours } from './game/colour.js';

/**
 * Run settings (docs/05-evolution.md). Every knob that changes how a run plays out
 * lives here so that a run is fully described by `settings + seed`.
 */

/** Play-AI strength. See docs/04-agents.md. */
export const agentLevels = ['random', 'greedy', 'search', 'deep'] as const;
export type AgentLevel = (typeof agentLevels)[number];

/** How the starting 75 is produced. */
export const seedDeckModes = ['constrainedRandom', 'fixed'] as const;
export type SeedDeckMode = (typeof seedDeckModes)[number];

/** Shape of a deck change. Fixed at `slot` for now (decision D7). */
export const changeSizes = ['slot'] as const;
export type ChangeSize = (typeof changeSizes)[number];

/** Scryfall legality used as the base card pool, before the run's own ban list. */
export const legalityFilters = ['vintage', 'legacy', 'modern', 'pioneer', 'pauper'] as const;
export type LegalityFilter = (typeof legalityFilters)[number];

/**
 * Seeds are 64-bit and arrive from JSON, so they are carried as decimal strings
 * rather than as numbers (which would lose precision above 2^53).
 */
export const seedSchema = z.string().superRefine((value, ctx) => {
  // One check at a time: `BigInt()` throws on anything the pattern would have rejected.
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    ctx.addIssue({ code: 'custom', message: 'seed must be a non-negative decimal integer' });
    return;
  }
  if (BigInt(value) >= 1n << 64n) {
    ctx.addIssue({ code: 'custom', message: 'seed must fit in 64 bits' });
  }
});

export const runSettingsSchema = z.object({
  /** Everything in a run derives from this. */
  seed: seedSchema,

  // --- The cycle ---
  /** Bo3 matches per cycle; roughly 200-300 games at the default. */
  matchesPerCycle: z.int().min(1).max(10_000).default(100),
  /** Win-rate difference below which a cycle counts as a tie. */
  tieMargin: z.number().min(0).max(0.5).default(0.04),
  /** Extra matches played to break a tie before the seeded coin flip. */
  tiebreakMatches: z.int().min(0).max(10_000).default(30),
  /** All copies of one card name in one zone. Fixed for now. */
  changeSize: z.enum(changeSizes).default('slot'),

  // --- Replacement search ---
  /** Candidates scripted on demand per replacement search. */
  shortlistSize: z.int().min(1).max(500).default(50),
  /** Candidates that get a trial batch; 0 disables trials. */
  trialTopK: z.int().min(0).max(20).default(3),
  /** Matches played per trial candidate. */
  trialMatches: z.int().min(1).max(1000).default(20),

  // --- Play ---
  /** Turns after which an unfinished game is a draw. */
  turnCap: z.int().min(1).max(500).default(40),
  agentLevel: z.enum(agentLevels).default('search'),
  /** Pairs of cards the sideboarding agent may swap between games 2 and 3 (docs/04). */
  maxSideboardSwaps: z.int().min(0).max(15).default(4),

  // --- Seed deck ---
  seedDeck: z.enum(seedDeckModes).default('constrainedRandom'),
  /** Empty means "roll 1-3 colours from the seed". */
  seedDeckColours: z.array(z.enum(colours)).max(5).default([]),
  /** Target land count; the generator varies it by +/- `seedDeckLandsJitter`. */
  seedDeckLands: z.int().min(0).max(60).default(24),
  seedDeckLandsJitter: z.int().min(0).max(10).default(2),

  /** Base pool legality. The run's ban list sits on top of it. */
  legalityFilter: z.enum(legalityFilters).default('vintage'),
});

export type RunSettings = z.infer<typeof runSettingsSchema>;
/** What a caller may supply: everything but `seed` has a default. */
export type RunSettingsInput = z.input<typeof runSettingsSchema>;

/** Parse partial settings into a complete, validated `RunSettings`. */
export const parseRunSettings = (input: RunSettingsInput): RunSettings =>
  runSettingsSchema.parse(input);

/** Colours must be distinct; an explicit colour list must be 1-3 colours (decision D17). */
export const validateSeedDeckColours = (settings: RunSettings): string[] => {
  const problems: string[] = [];
  const chosen = settings.seedDeckColours;
  if (chosen.length === 0) return problems;
  if (new Set(chosen).size !== chosen.length) problems.push('seedDeckColours contains duplicates');
  if (chosen.length > 3) problems.push('seedDeckColours must name at most 3 colours');
  return problems;
};
