import type { Colour } from '@mtg/shared';
import type { ManaCost } from './mana/cost.js';

/**
 * The keyword set, on its own.
 *
 * It lives here rather than in `targeting.ts` because both targeting and the layer system
 * need it, and those two already point at each other: `targeting` asks `characteristics`
 * what an object currently is, and `characteristics` starts from a printed keyword set. A
 * module that imports nothing from the engine breaks that knot, which otherwise depends
 * on which file a program happens to load first — a real failure, not a tidiness point.
 */

export interface Keywords {
  // --- Evasion and targeting ---
  /** CR 702.18: can't be the target of spells or abilities at all, even its controller's. */
  readonly shroud: boolean;
  /** CR 702.11: can't be targeted by spells or abilities an opponent controls. */
  readonly hexproof: boolean;
  /** CR 702.16: can't be targeted by sources of these colours. */
  readonly protectionFrom: readonly Colour[];
  /**
   * CR 702.21: not a targeting restriction at all — an opponent may still target it, but
   * their spell is countered unless they pay this. Reported rather than forbidden.
   */
  readonly ward: ManaCost | null;

  // --- Combat (CR 506-511). Evergreen keywords only; see docs/02 for the v1 scope. ---
  /** CR 702.9: can only be blocked by creatures with flying or reach. */
  readonly flying: boolean;
  /** CR 702.17: can block a creature with flying. */
  readonly reach: boolean;
  /** CR 702.110: can't be blocked except by two or more creatures. */
  readonly menace: boolean;
  /** CR 702.20: attacking doesn't cause it to tap. */
  readonly vigilance: boolean;
  /** CR 702.10: ignores summoning sickness. */
  readonly haste: boolean;
  /** CR 702.3: can't attack. */
  readonly defender: boolean;
  /** CR 702.7: deals its combat damage in the first-strike step. */
  readonly firstStrike: boolean;
  /** CR 702.4: deals combat damage in both damage steps. */
  readonly doubleStrike: boolean;
  /** CR 702.19: excess damage over lethal can be assigned to the defending player. */
  readonly trample: boolean;
  /** CR 702.2: any non-zero damage it deals to a creature is lethal. */
  readonly deathtouch: boolean;
  /** CR 702.15: damage it deals also gains its controller that much life. */
  readonly lifelink: boolean;
  /** CR 702.12: not destroyed by lethal damage or "destroy" effects. */
  readonly indestructible: boolean;
}

export const noKeywords: Keywords = Object.freeze({
  shroud: false,
  hexproof: false,
  protectionFrom: Object.freeze([]),
  ward: null,
  flying: false,
  reach: false,
  menace: false,
  vigilance: false,
  haste: false,
  defender: false,
  firstStrike: false,
  doubleStrike: false,
  trample: false,
  deathtouch: false,
  lifelink: false,
  indestructible: false,
});

/** Build a keyword set, naming only what differs from none of them. */
export const keywords = (some: Partial<Keywords> = {}): Keywords => ({ ...noKeywords, ...some });
