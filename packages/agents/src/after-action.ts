import type { PlayerView, PriorityAction, VisibleObject } from '@mtg/engine/view';
import { type ObjectId, playerZone } from '@mtg/shared';

/**
 * What the viewer's own view would look like just after they take one priority action —
 * as far as the view alone can say.
 *
 * This is the `greedy` agent's substitute for a simulator, and its limits are the point
 * of writing it down. The agents package cannot call the engine's `step` (ADR 0009), so
 * greedy cannot find out what a spell *does*; it can only see what taking the action
 * visibly changes on the viewer's side of the table:
 *
 * - a land played moves from hand to the battlefield;
 * - a spell cast leaves the hand, and taps as many mana sources as the casting costs —
 *   which is its mana value less any reduction it gets (CR 601.2f);
 * - its additional cost is paid: what it sacrifices goes to the graveyard, what it
 *   discards leaves the hand, and the life comes off (CR 601.2h) — so a sacrifice is
 *   priced as the creature it costs, not as free;
 * - a permanent spell arrives on the battlefield, summoning sick, as the card it is;
 * - an instant or sorcery goes to the graveyard, having done — as far as this function
 *   knows — nothing at all;
 * - a loyalty ability moves its planeswalker's loyalty by its cost.
 *
 * What an instant, a sorcery or a loyalty ability does to the board is exactly what
 * greedy cannot see, and `greedy.ts` prices it with an explicit, tunable prior instead
 * of pretending. The determinised search in 4.3 replaces both: it runs the engine on a
 * state built from the view, and a spell's effect is then whatever the engine says it is.
 *
 * Returns a new view and never touches the one it was given, whose objects are shared.
 */
export const afterAction = (view: PlayerView, action: PriorityAction): PlayerView => {
  switch (action.kind) {
    case 'pass':
      return view;
    case 'playLand':
      return enterBattlefield(leaveHand(view, action.object), action.object, false);
    case 'cast': {
      const card = view.objects.get(action.object);
      if (card === undefined) return view;
      const paid = payAdditional(
        tapFor(leaveHand(view, action.object), manaIn(action.cost)),
        action,
      );
      return isPermanentCard(card)
        ? enterBattlefield(paid, action.object, card.isCreature)
        : toGraveyard(paid, action.object);
    }
    case 'activateLoyalty': {
      const walker = view.objects.get(action.object);
      if (walker === undefined) return view;
      return withObject(view, { ...walker, loyalty: (walker.loyalty ?? 0) + action.cost });
    }
  }
};

/** Cards that stay on the battlefield once they resolve (CR 110.1, 110.4). */
export const isPermanentCard = (card: VisibleObject): boolean =>
  card.types.some((type) => type !== 'instant' && type !== 'sorcery');

const withObject = (view: PlayerView, object: VisibleObject): PlayerView => {
  const objects = new Map(view.objects);
  objects.set(object.id, object);
  return { ...view, objects };
};

const leaveHand = (view: PlayerView, id: ObjectId): PlayerView => ({
  ...view,
  you: {
    ...view.you,
    hand: view.you.hand.filter((other) => other !== id),
    handSize: view.you.handSize - 1,
  },
});

const enterBattlefield = (view: PlayerView, id: ObjectId, sick: boolean): PlayerView => {
  const card = view.objects.get(id);
  if (card === undefined) return view;
  const entered = withObject(view, {
    ...card,
    zone: 'battlefield',
    controller: view.viewer,
    tapped: false,
    summoningSick: sick,
  });
  return {
    ...entered,
    battlefield: [...view.battlefield, id],
    you: {
      ...entered.you,
      battlefield: [...entered.you.battlefield, id],
      landsPlayedThisTurn: card.types.includes('land')
        ? entered.you.landsPlayedThisTurn + 1
        : entered.you.landsPlayedThisTurn,
    },
  };
};

const payAdditional = (
  view: PlayerView,
  action: Extract<PriorityAction, { kind: 'cast' }>,
): PlayerView => {
  let next = view;
  for (const id of action.sacrifice ?? []) next = sacrifice(next, id);
  for (const id of action.discard ?? []) next = toGraveyard(leaveHand(next, id), id);
  const life = action.life ?? 0;
  return life > 0 ? { ...next, you: { ...next.you, life: next.you.life - life } } : next;
};

/** A permanent of the viewer's, put into the graveyard (CR 701.21a). */
const sacrifice = (view: PlayerView, id: ObjectId): PlayerView => {
  const object = view.objects.get(id);
  const moved =
    object === undefined
      ? view
      : withObject(view, { ...object, zone: playerZone(object.owner, 'graveyard') });
  return toGraveyard(
    {
      ...moved,
      battlefield: moved.battlefield.filter((other) => other !== id),
      you: { ...moved.you, battlefield: moved.you.battlefield.filter((other) => other !== id) },
    },
    id,
  );
};

/** Mana symbols a cost asks for, an X counting as none: what tapping has to cover. */
const manaIn = (cost: Extract<PriorityAction, { kind: 'cast' }>['cost']): number =>
  cost.generic + cost.symbols.length;

const toGraveyard = (view: PlayerView, id: ObjectId): PlayerView => ({
  ...view,
  you: { ...view.you, graveyard: [...view.you.graveyard, id] },
});

/**
 * Tap enough of the viewer's untapped mana sources to cover `amount`, lands first — the
 * same preference the engine's auto-tapper has, so the held-mana term sees roughly what
 * the real payment will leave untapped. Exact payment is the engine's job, not this.
 */
const tapFor = (view: PlayerView, amount: number): PlayerView => {
  const sources = view.you.battlefield
    .map((id) => view.objects.get(id))
    .filter(
      (object): object is VisibleObject =>
        object !== undefined && !object.tapped && object.producesMana.length > 0,
    )
    .sort((a, b) => Number(b.types.includes('land')) - Number(a.types.includes('land')));

  let next = view;
  for (const source of sources.slice(0, Math.max(0, amount))) {
    next = withObject(next, { ...source, tapped: true });
  }
  return next;
};
