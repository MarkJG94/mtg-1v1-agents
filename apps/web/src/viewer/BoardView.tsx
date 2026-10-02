import {
  type Board,
  type BoardObject,
  type ObjectId,
  type PlayerId,
  playerZone,
} from '@mtg/shared';
import { useState } from 'react';
import { imageUrl } from '../api.js';
import {
  type GameCards,
  loyaltyOf,
  nameOf,
  ownedIn,
  powerToughness,
  type Row,
  rowOf,
} from './model.js';
import { stepName } from './narrate.js';

/**
 * The board (docs/08 "Game viewer"): each player's battlefield in rows — lands, creatures,
 * other permanents — their hand, library, graveyard and exile, life and poison; the stack
 * between them; and the turn and step. B sits at the top and A at the bottom, each with
 * creatures nearest the middle, as two players across a table would have them.
 *
 * Every card is a text frame — name, P/T, counters, damage, tapped, in combat — and its
 * image and oracle text come up on hover or focus. A permanent is drawn on its owner's
 * side: the log does not say who controls one whose control changed.
 */

export const agentText: Record<PlayerId, string> = { A: 'text-sky-300', B: 'text-orange-300' };

/** What the board shows on hover or focus: the card, where it is on the page. */
export interface Inspecting {
  readonly id: ObjectId;
  readonly rect: { readonly top: number; readonly left: number; readonly right: number };
}

export const BoardView = ({
  board,
  cards,
  reveal,
  onInspect,
}: {
  board: Board;
  cards: GameCards;
  reveal: boolean;
  onInspect: (inspecting: Inspecting | null) => void;
}) => (
  <div className="flex flex-col gap-3" data-testid="board">
    <PlayerArea
      player="B"
      top
      board={board}
      cards={cards}
      handVisible={reveal}
      onInspect={onInspect}
    />
    <Middle board={board} cards={cards} onInspect={onInspect} />
    <PlayerArea
      player="A"
      top={false}
      board={board}
      cards={cards}
      handVisible
      onInspect={onInspect}
    />
  </div>
);

const Middle = ({
  board,
  cards,
  onInspect,
}: {
  board: Board;
  cards: GameCards;
  onInspect: (inspecting: Inspecting | null) => void;
}) => {
  const stack = [...board.zones.stack].reverse();
  return (
    <div className="flex flex-wrap items-start gap-4 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2">
      <p className="min-w-40 text-sm" data-testid="turn-step">
        {board.turn === 0 ? (
          <span className="text-slate-400">Before the first turn</span>
        ) : (
          <>
            <span className="font-medium">Turn {board.turn}</span>
            {board.activePlayer !== null && (
              <>
                {' · '}
                <span className={agentText[board.activePlayer]}>{board.activePlayer}</span>
              </>
            )}
            <br />
            <span className="text-slate-400">{stepName(board.step)}</span>
          </>
        )}
      </p>
      <section aria-label="Stack" className="flex min-w-0 grow flex-col gap-1">
        <h3 className="text-xs uppercase tracking-wide text-slate-400">
          Stack{stack.length > 0 && ` · ${stack.length}`}
        </h3>
        {stack.length === 0 ? (
          <p className="text-xs text-slate-500">empty</p>
        ) : (
          <ol className="flex flex-wrap gap-1.5">
            {stack.map((id, place) => {
              const object = board.objects.get(id);
              return object === undefined ? null : (
                <li key={id} className={place === 0 ? 'viewer-pulse rounded' : ''}>
                  <CardChip object={object} cards={cards} onInspect={onInspect} />
                </li>
              );
            })}
          </ol>
        )}
      </section>
      {board.result !== null && (
        <p className="self-center rounded border border-slate-600 px-2 py-1 text-sm font-medium">
          {board.result.winner === null ? 'Draw' : `${board.result.winner} wins`} ·{' '}
          {board.result.reason}
        </p>
      )}
    </div>
  );
};

const rowLabels: Record<Row, string> = { lands: 'Lands', creatures: 'Creatures', other: 'Other' };

const PlayerArea = ({
  player,
  top,
  board,
  cards,
  handVisible,
  onInspect,
}: {
  player: PlayerId;
  top: boolean;
  board: Board;
  cards: GameCards;
  handVisible: boolean;
  onInspect: (inspecting: Inspecting | null) => void;
}) => {
  const permanents = ownedIn(cards, board.zones.battlefield, player);
  const rows: Record<Row, ObjectId[]> = { lands: [], creatures: [], other: [] };
  for (const id of permanents) rows[rowOf(cards, id)].push(id);
  const order: Row[] = top ? ['lands', 'other', 'creatures'] : ['creatures', 'other', 'lands'];
  const stats = board.players[player];
  const hand = board.zones[playerZone(player, 'hand')];
  const header = (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
      <h2 className={`text-base font-semibold ${agentText[player]}`}>
        Agent {player}
        {board.activePlayer === player && board.turn > 0 && (
          <span className="ml-1 text-xs font-normal text-slate-400">(active)</span>
        )}
      </h2>
      <span data-testid={`life-${player}`}>
        <span className="text-slate-400">Life</span>{' '}
        <strong className="tabular-nums">{stats.life}</strong>
      </span>
      {stats.poison > 0 && (
        <span data-testid={`poison-${player}`}>
          <span className="text-slate-400">Poison</span>{' '}
          <strong className="tabular-nums">{stats.poison}</strong>
        </span>
      )}
      <span className="text-slate-400">
        Library{' '}
        <span className="tabular-nums text-slate-200">
          {board.zones[playerZone(player, 'library')].length}
        </span>
      </span>
      {stats.mulligans > 0 && (
        <span className="text-slate-400">
          Mulligans <span className="tabular-nums text-slate-200">{stats.mulligans}</span>
        </span>
      )}
      <Pile
        label="Graveyard"
        player={player}
        ids={board.zones[playerZone(player, 'graveyard')]}
        board={board}
        cards={cards}
        onInspect={onInspect}
      />
      <Pile
        label="Exile"
        player={player}
        ids={ownedIn(cards, board.zones.exile, player)}
        board={board}
        cards={cards}
        onInspect={onInspect}
      />
    </div>
  );
  const battlefield = (
    <div className="flex flex-col gap-1.5">
      {order.map((row) => (
        <ul
          key={row}
          aria-label={`${player} ${rowLabels[row].toLowerCase()}`}
          className="flex min-h-9 flex-wrap gap-1.5"
        >
          {rows[row].map((id) => {
            const object = board.objects.get(id);
            return object === undefined ? null : (
              <li key={id}>
                <CardChip object={object} cards={cards} onInspect={onInspect} />
              </li>
            );
          })}
        </ul>
      ))}
    </div>
  );
  const handRow = (
    <ul
      aria-label={`${player} hand`}
      className="flex min-h-9 flex-wrap gap-1.5 border-slate-800 border-dashed"
    >
      {hand.map((id) => {
        const object = board.objects.get(id);
        if (object === undefined) return null;
        return (
          <li key={id}>
            {handVisible ? (
              <CardChip object={object} cards={cards} onInspect={onInspect} />
            ) : (
              <span
                className="inline-flex h-9 w-12 items-center justify-center rounded border border-slate-700 bg-slate-800 text-xs text-slate-500"
                data-testid="hidden-card"
              >
                ?
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
  return (
    <section
      aria-label={`Agent ${player}`}
      className="flex flex-col gap-2 rounded-lg border border-slate-800 p-3"
    >
      {top ? (
        <>
          {header}
          {handRow}
          {battlefield}
        </>
      ) : (
        <>
          {battlefield}
          {handRow}
          {header}
        </>
      )}
    </section>
  );
};

/** A graveyard or exile: a count that opens to the list, newest first. */
const Pile = ({
  label,
  player,
  ids,
  board,
  cards,
  onInspect,
}: {
  label: string;
  player: PlayerId;
  ids: readonly ObjectId[];
  board: Board;
  cards: GameCards;
  onInspect: (inspecting: Inspecting | null) => void;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative">
      <button
        type="button"
        className="text-slate-400 hover:text-slate-200 disabled:hover:text-slate-400"
        aria-expanded={open}
        aria-label={`${player} ${label.toLowerCase()}: ${ids.length}`}
        disabled={ids.length === 0}
        onClick={() => setOpen(!open)}
      >
        {label} <span className="tabular-nums text-slate-200">{ids.length}</span>
        {ids.length > 0 && <span aria-hidden="true"> {open ? '▴' : '▾'}</span>}
      </button>
      {open && ids.length > 0 && (
        <ul
          aria-label={`${player} ${label.toLowerCase()}`}
          className="absolute top-full left-0 z-20 mt-1 flex max-h-72 w-60 flex-col gap-1 overflow-y-auto rounded border border-slate-700 bg-slate-900 p-2 shadow-xl"
        >
          {[...ids].reverse().map((id) => {
            const object = board.objects.get(id);
            return object === undefined ? null : (
              <li key={id}>
                <CardChip object={object} cards={cards} onInspect={onInspect} />
              </li>
            );
          })}
        </ul>
      )}
    </span>
  );
};

/** What a card on the board says of itself, in words, for a screen reader and the tests. */
export const describeObject = (cards: GameCards, object: BoardObject): string => {
  const parts = [nameOf(cards, object.id)];
  const pt = powerToughness(cards, object);
  if (pt !== null && object.zone === 'battlefield') parts.push(`${pt.power}/${pt.toughness}`);
  const loyalty = object.zone === 'battlefield' ? loyaltyOf(cards, object) : null;
  if (loyalty !== null && object.counters.loyalty !== undefined) parts.push(`loyalty ${loyalty}`);
  for (const [kind, count] of Object.entries(object.counters)) {
    if (kind !== 'loyalty') parts.push(`${count} ${kind}`);
  }
  if (object.damage > 0) parts.push(`${object.damage} damage`);
  if (object.tapped) parts.push('tapped');
  if (object.attacking !== null) parts.push('attacking');
  if (object.blocking.length > 0) parts.push('blocking');
  return parts.join(', ');
};

export const CardChip = ({
  object,
  cards,
  onInspect,
}: {
  object: BoardObject;
  cards: GameCards;
  onInspect: (inspecting: Inspecting | null) => void;
}) => {
  const pt = object.zone === 'battlefield' ? powerToughness(cards, object) : null;
  const loyalty =
    object.zone === 'battlefield' && object.counters.loyalty !== undefined
      ? loyaltyOf(cards, object)
      : null;
  const show = (target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    onInspect({ id: object.id, rect: { top: rect.top, left: rect.left, right: rect.right } });
  };
  const inCombat = object.attacking !== null || object.blocking.length > 0;
  const counters = Object.entries(object.counters).filter(([kind]) => kind !== 'loyalty');
  return (
    <button
      type="button"
      data-testid={`card-${object.id}`}
      aria-label={describeObject(cards, object)}
      onMouseEnter={(event) => show(event.currentTarget)}
      onMouseLeave={() => onInspect(null)}
      onFocus={(event) => show(event.currentTarget)}
      onBlur={() => onInspect(null)}
      className={`flex h-9 max-w-44 items-center gap-1.5 rounded border px-1.5 text-left text-xs transition-transform focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
        object.ability
          ? 'border-violet-700 bg-violet-950/60 italic'
          : inCombat
            ? 'border-amber-500 bg-slate-800'
            : 'border-slate-600 bg-slate-800'
      } ${object.tapped ? 'rotate-6 opacity-60' : ''}`}
    >
      {object.attacking !== null && (
        <span aria-hidden="true" title="attacking">
          ⚔
        </span>
      )}
      {object.blocking.length > 0 && (
        <span aria-hidden="true" title="blocking">
          ⛨
        </span>
      )}
      <span className="truncate">{nameOf(cards, object.id)}</span>
      {counters.map(([kind, count]) => (
        <span
          key={kind}
          className="shrink-0 rounded bg-slate-700 px-1 text-[10px] tabular-nums"
          title={`${count} ${kind} counter${count === 1 ? '' : 's'}`}
        >
          {kind === '+1/+1' || kind === '-1/-1' ? `${kind}×${count}` : `${kind} ${count}`}
        </span>
      ))}
      {loyalty !== null && (
        <span
          className="shrink-0 rounded border border-slate-500 px-1 tabular-nums"
          title="loyalty"
        >
          ◆{loyalty}
        </span>
      )}
      {pt !== null && (
        <span className="shrink-0 font-semibold tabular-nums">
          {pt.power}/{pt.toughness}
        </span>
      )}
      {object.damage > 0 && (
        <span
          key={object.damage}
          className="viewer-flash shrink-0 rounded bg-orange-900 px-1 text-[10px] tabular-nums text-orange-100"
          title={`${object.damage} damage marked${object.deathtouched ? ', from deathtouch' : ''}`}
        >
          −{object.damage}
        </span>
      )}
    </button>
  );
};

/**
 * Card hover, anywhere on the board (docs/08): the card's image through the server's
 * cache and its oracle text — or only the text, in text-only mode or when the image will
 * not load — with what the board says of it now.
 */
export const HoverCard = ({
  inspecting,
  board,
  cards,
  images,
}: {
  inspecting: Inspecting;
  board: Board;
  cards: GameCards;
  images: boolean;
}) => {
  const [failed, setFailed] = useState<string | null>(null);
  const identity = cards.identities.get(inspecting.id);
  const object = board.objects.get(inspecting.id);
  if (identity === undefined) return null;
  const face = cards.faces.get(identity.oracleId);
  const width = 340;
  const placeLeft =
    typeof window !== 'undefined' && inspecting.rect.right + width + 16 > window.innerWidth;
  const left = placeLeft
    ? Math.max(8, inspecting.rect.left - width - 8)
    : inspecting.rect.right + 8;
  const top = Math.max(8, Math.min(inspecting.rect.top, (window.innerHeight || 800) - 260));
  const showImage = images && failed !== identity.oracleId && identity.token !== true;
  return (
    <div
      role="tooltip"
      data-testid="hover-card"
      style={{ position: 'fixed', top, left, width }}
      className="pointer-events-none z-50 flex gap-3 rounded-lg border border-slate-700 bg-slate-900 p-3 text-xs shadow-2xl"
    >
      {showImage && (
        <img
          src={imageUrl(identity.oracleId, 'normal')}
          alt=""
          width={130}
          height={181}
          className="h-[181px] w-[130px] shrink-0 rounded bg-slate-800"
          onError={() => setFailed(identity.oracleId)}
        />
      )}
      <div className="flex min-w-0 flex-col gap-1">
        <strong className="text-sm text-slate-100">{nameOf(cards, inspecting.id)}</strong>
        {identity.ability === true ? (
          <span className="text-slate-400">
            An ability on the stack, of {face?.name ?? 'a card'}
          </span>
        ) : identity.token === true ? (
          <span className="text-slate-400">
            Token{identity.power != null && ` · ${identity.power}/${identity.toughness}`}
            {face !== undefined && `, made by ${face.name}`}
          </span>
        ) : (
          face !== undefined && (
            <span className="text-slate-400">
              {face.typeLine}
              {face.manaCost && ` · ${face.manaCost}`}
            </span>
          )
        )}
        {face !== undefined && identity.token !== true && (
          <p className="whitespace-pre-line text-slate-200" data-testid="oracle-text">
            {face.oracleText}
          </p>
        )}
        {face !== undefined &&
          identity.token !== true &&
          (face.power !== null || face.loyalty !== null) && (
            <span className="text-slate-400">
              {face.power !== null ? `${face.power}/${face.toughness}` : `Loyalty ${face.loyalty}`}
            </span>
          )}
        {object !== undefined && (
          <span className="text-slate-500">{describeObject(cards, object)}</span>
        )}
        <span className="text-slate-500">Owner: {identity.owner}</span>
      </div>
    </div>
  );
};
