import type { CounterKind, EventTarget, MoveCause, ObjectId, PlayerId, ZoneId } from '@mtg/shared';

/**
 * Rules events: what the game is *about* to do, described as data (docs/02
 * "Replacement and prevention effects").
 *
 * Nothing in the engine deals damage, draws a card or moves a permanent directly any
 * more. It builds one of these, hands it to `runBatch`, and the batch runs it past every
 * applicable replacement effect (CR 614–616) before anything happens. A replacement
 * effect can change the event, swap it for a different one, or remove it entirely — which
 * is exactly what "enters tapped", "if it would die, exile it instead" and "prevent the
 * next 3 damage" are.
 *
 * These are not the events in `@mtg/shared`. Those are the *log*: a record of what
 * happened, written after the fact. These are the proposal, and a replacement effect can
 * still change what the log ends up saying.
 */

export interface DamageEvent {
  readonly kind: 'damage';
  readonly source: ObjectId;
  /** The source's controller, who gains the life if the source has lifelink. */
  readonly controller: PlayerId;
  readonly target: EventTarget;
  readonly amount: number;
  readonly combat: boolean;
  readonly deathtouch: boolean;
  readonly lifelink: boolean;
}

export interface DrawEvent {
  readonly kind: 'draw';
  readonly player: PlayerId;
}

export interface MoveZoneEvent {
  readonly kind: 'moveZone';
  readonly object: ObjectId;
  readonly from: ZoneId;
  readonly to: ZoneId;
  readonly cause: MoveCause;
  /**
   * Whether this is *destruction* (CR 701.7) rather than merely being put somewhere.
   * Regeneration and indestructible care about the difference: a creature with zero
   * toughness is put into its graveyard, not destroyed, so no shield saves it.
   */
  readonly destruction: boolean;
}

/**
 * A permanent arriving on the battlefield. Separate from `moveZone` because the
 * replacements that apply are the "as ... enters" ones (CR 614.1c), which decide how it
 * arrives rather than whether it does — tapped, with counters, as a copy of something.
 */
export interface EntersBattlefieldEvent {
  readonly kind: 'entersBattlefield';
  readonly object: ObjectId;
  readonly from: ZoneId;
  readonly tapped: boolean;
  readonly counters: Readonly<Record<string, number>>;
}

export interface LifeEvent {
  readonly kind: 'gainLife' | 'loseLife';
  readonly player: PlayerId;
  readonly amount: number;
}

export interface CountersEvent {
  readonly kind: 'addCounters';
  readonly object: ObjectId;
  readonly counter: CounterKind;
  readonly amount: number;
}

export type RulesEvent =
  | DamageEvent
  | DrawEvent
  | MoveZoneEvent
  | EntersBattlefieldEvent
  | LifeEvent
  | CountersEvent;

export type RulesEventKind = RulesEvent['kind'];

/**
 * Who chooses when several replacement effects would apply at once (CR 616.1): the
 * affected player, or the affected object's controller.
 */
export const affectedPlayer = (
  event: RulesEvent,
  controllerOf: (object: ObjectId) => PlayerId,
): PlayerId => {
  switch (event.kind) {
    case 'damage':
      return event.target.kind === 'player'
        ? event.target.player
        : controllerOf(event.target.object);
    case 'draw':
    case 'gainLife':
    case 'loseLife':
      return event.player;
    case 'moveZone':
    case 'entersBattlefield':
    case 'addCounters':
      return controllerOf(event.object);
  }
};
