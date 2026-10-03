import type { PlayerView } from '@mtg/engine/view';
import type { ObjectId } from '@mtg/shared';

export interface Block {
  readonly blocker: ObjectId;
  readonly blocking: readonly ObjectId[];
}

/**
 * Drop any block that menace makes illegal as a whole (CR 702.110b): an attacker with
 * menace blocked by exactly one creature. The decision says which single pairings are
 * legal; this is the one rule about the declaration together, and the attacker's
 * keywords — current ones, from the view — are all it needs.
 */
export const withoutLoneMenaceBlocks = (view: PlayerView, blocks: readonly Block[]): Block[] => {
  const count = new Map<ObjectId, number>();
  for (const block of blocks) {
    for (const attacker of block.blocking) count.set(attacker, (count.get(attacker) ?? 0) + 1);
  }
  const alone = new Set(
    [...count]
      .filter(([attacker, n]) => n < 2 && view.objects.get(attacker)?.keywords.menace === true)
      .map(([attacker]) => attacker),
  );
  return blocks.filter((block) => !block.blocking.some((attacker) => alone.has(attacker)));
};
