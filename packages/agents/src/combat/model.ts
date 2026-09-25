import type { PlayerView, SideView, VisibleObject } from '@mtg/engine/view';
import { type ObjectId, opponentOf, type PlayerId } from '@mtg/shared';

/**
 * What a combat would do, worked out from a view (roadmap 4.4).
 *
 * The combat solver asks this hundreds of times a decision — every attack it considers,
 * against every set of blocks the defender might answer with — so it cannot run the
 * engine each time. It follows the engine's own damage assignment (`combat.ts`,
 * `assignCombatDamage`) as closely as a view allows:
 *
 * - a first-strike damage step happens only if a creature with first or double strike is
 *   in the fight, and a creature killed in it deals no regular damage (CR 510.4);
 * - an attacker assigns lethal damage to each blocker in order before the next gets any,
 *   and the last soaks up the rest — or, with trample, the defending player does
 *   (CR 510.1c-d, 702.19b); deathtouch makes one point lethal (CR 702.2c);
 * - an attacker whose blockers have all gone deals no damage unless it tramples
 *   (CR 509.1h, 702.19e);
 * - damage is dealt simultaneously and then creatures die — damage at least equal to
 *   toughness, or any deathtouch damage, unless indestructible (CR 704.5g-h, 702.12b);
 * - lifelink gains its controller the damage dealt (CR 702.15b).
 *
 * What it cannot see, it does not model: prevention and replacement effects, "can't be
 * blocked" beyond flying and protection, and triggers. The search checks its best few
 * answers against the real engine for exactly that reason (docs/04).
 *
 * The result is a view of the board **once combat is over and the turn has moved on** —
 * dead creatures in their owners' graveyards, attackers tapped unless they have vigilance,
 * damage on survivors healed as it will be in cleanup (CR 514.2) — so the evaluator can
 * score it like any other position.
 */

export interface PlannedAttack {
  readonly attacker: ObjectId;
  /** Only players are attacked here; attacking planeswalkers is left to the engine's answer. */
  readonly defender: PlayerId;
}

export interface CombatPlan {
  readonly attacks: readonly PlannedAttack[];
  /** Each attacker's blockers, in the order the attacker will assign damage to them. */
  readonly blocks: ReadonlyMap<ObjectId, readonly ObjectId[]>;
}

export interface CombatOutcome {
  readonly view: PlayerView;
  readonly died: ReadonlySet<ObjectId>;
  /** Combat damage each player took. */
  readonly damage: Readonly<Record<PlayerId, number>>;
}

interface Hit {
  readonly source: VisibleObject;
  readonly target: { readonly object: ObjectId } | { readonly player: PlayerId };
  readonly amount: number;
}

const strikesFirst = (object: VisibleObject): boolean =>
  object.keywords.firstStrike || object.keywords.doubleStrike;

/** Whether a creature deals damage in this step (the engine's `dealsDamageIn`, CR 510.4). */
const dealsDamageIn = (object: VisibleObject, firstStrikeStep: boolean): boolean =>
  firstStrikeStep
    ? strikesFirst(object)
    : object.keywords.doubleStrike || !object.keywords.firstStrike;

export const projectCombat = (view: PlayerView, plan: CombatPlan): CombatOutcome => {
  const get = (id: ObjectId): VisibleObject | undefined => view.objects.get(id);
  const damage = new Map<ObjectId, number>();
  const deathtouched = new Set<ObjectId>();
  const died = new Set<ObjectId>();
  const life: Record<PlayerId, number> = { A: 0, B: 0 };
  const taken: Record<PlayerId, number> = { A: 0, B: 0 };

  const involved: VisibleObject[] = [];
  for (const attack of plan.attacks) {
    const attacker = get(attack.attacker);
    if (attacker !== undefined) involved.push(attacker);
    for (const id of plan.blocks.get(attack.attacker) ?? []) {
      const blocker = get(id);
      if (blocker !== undefined) involved.push(blocker);
    }
  }

  const toughnessLeft = (object: VisibleObject): number =>
    (object.toughness ?? 0) - object.damage - (damage.get(object.id) ?? 0);

  const steps = involved.some(strikesFirst) ? [true, false] : [false];
  for (const firstStrikeStep of steps) {
    const hits: Hit[] = [];

    for (const attack of plan.attacks) {
      const attacker = get(attack.attacker);
      if (attacker === undefined || died.has(attacker.id)) continue;
      const declared = plan.blocks.get(attacker.id) ?? [];
      const blockers = declared
        .map(get)
        .filter((object): object is VisibleObject => object !== undefined && !died.has(object.id));

      if (dealsDamageIn(attacker, firstStrikeStep)) {
        const power = Math.max(0, attacker.power ?? 0);
        const trample = attacker.keywords.trample;
        if (declared.length === 0) {
          if (power > 0)
            hits.push({ source: attacker, target: { player: attack.defender }, amount: power });
        } else if (blockers.length === 0) {
          // Blocked, and every blocker has gone: nothing, unless it tramples.
          if (trample && power > 0) {
            hits.push({ source: attacker, target: { player: attack.defender }, amount: power });
          }
        } else {
          let remaining = power;
          blockers.forEach((blocker, i) => {
            if (remaining <= 0) return;
            const lethal = attacker.keywords.deathtouch ? 1 : Math.max(0, toughnessLeft(blocker));
            const isLast = i === blockers.length - 1;
            const amount = isLast && !trample ? remaining : Math.min(remaining, lethal);
            if (amount > 0) hits.push({ source: attacker, target: { object: blocker.id }, amount });
            remaining -= amount;
          });
          if (trample && remaining > 0) {
            hits.push({ source: attacker, target: { player: attack.defender }, amount: remaining });
          }
        }
      }

      // Blockers deal their damage back to the attacker they block.
      for (const blocker of blockers) {
        if (!dealsDamageIn(blocker, firstStrikeStep)) continue;
        const power = Math.max(0, blocker.power ?? 0);
        if (power > 0)
          hits.push({ source: blocker, target: { object: attacker.id }, amount: power });
      }
    }

    // All of a step's damage lands at once (CR 510.2), and only then does anything die.
    for (const hit of hits) {
      if ('player' in hit.target) {
        life[hit.target.player] -= hit.amount;
        taken[hit.target.player] += hit.amount;
      } else {
        damage.set(hit.target.object, (damage.get(hit.target.object) ?? 0) + hit.amount);
        if (hit.source.keywords.deathtouch) deathtouched.add(hit.target.object);
      }
      if (hit.source.keywords.lifelink) life[hit.source.controller] += hit.amount;
    }
    for (const object of involved) {
      if (died.has(object.id) || object.keywords.indestructible) continue;
      if (toughnessLeft(object) <= 0 || deathtouched.has(object.id)) died.add(object.id);
    }
  }

  return { view: afterCombat(view, plan, died, life), died, damage: taken };
};

const afterCombat = (
  view: PlayerView,
  plan: CombatPlan,
  died: ReadonlySet<ObjectId>,
  life: Readonly<Record<PlayerId, number>>,
): PlayerView => {
  const attacking = new Set(plan.attacks.map((attack) => attack.attacker));
  const changed = new Map<ObjectId, VisibleObject>();
  // Only the battlefield: that is where every creature that fought, died or was damaged is.
  for (const id of view.battlefield) {
    const object = view.objects.get(id);
    if (object === undefined) continue;
    if (died.has(id)) {
      changed.set(id, { ...object, zone: `${object.owner}:graveyard`, tapped: false, damage: 0 });
    } else if (attacking.has(id) || object.damage > 0) {
      const tapped = object.tapped || (attacking.has(id) && !object.keywords.vigilance);
      changed.set(id, { ...object, tapped, damage: 0 });
    }
  }
  const objects = new Overlay(view.objects, changed);

  const side = <S extends SideView>(it: S): S => {
    const graveyard = [...it.graveyard];
    for (const id of died) {
      if (view.objects.get(id)?.owner === it.player) graveyard.push(id);
    }
    return {
      ...it,
      life: it.life + life[it.player],
      battlefield: it.battlefield.filter((id) => !died.has(id)),
      graveyard,
    };
  };

  const you = side(view.you);
  const opponent = side(view.opponent);
  const loser = [you, opponent].find((it) => it.life <= 0)?.player;

  return {
    ...view,
    step: 'endCombat',
    objects,
    battlefield: view.battlefield.filter((id) => !died.has(id)),
    you,
    opponent,
    // Both at zero is a draw (CR 104.4a); one is a loss (CR 704.5a).
    result:
      view.result ??
      (loser === undefined
        ? null
        : {
            winner: you.life <= 0 && opponent.life <= 0 ? null : opponentOf(loser),
            reason: 'life',
            turn: view.turn,
          }),
  };
};

/**
 * A map that reads through to `base` except where `changed` has an entry for the same key.
 *
 * The solver projects a combat hundreds of times a decision, and each projection changed
 * a handful of creatures but copied every object the viewer can see to do it, which was
 * several per cent of a searched game (4.8). `changed` only ever replaces keys `base`
 * already has, so the size and the order are `base`'s.
 */
class Overlay<K, V> implements ReadonlyMap<K, V> {
  constructor(
    private readonly base: ReadonlyMap<K, V>,
    private readonly changed: ReadonlyMap<K, V>,
  ) {}

  get size(): number {
    return this.base.size;
  }

  get(key: K): V | undefined {
    return this.changed.get(key) ?? this.base.get(key);
  }

  has(key: K): boolean {
    return this.base.has(key);
  }

  forEach(callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this) callback.call(thisArg, value, key, this);
  }

  *entries(): MapIterator<[K, V]> {
    for (const [key, value] of this.base) yield [key, this.changed.get(key) ?? value];
  }

  *keys(): MapIterator<K> {
    yield* this.base.keys();
  }

  *values(): MapIterator<V> {
    for (const [, value] of this.entries()) yield value;
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }
}
