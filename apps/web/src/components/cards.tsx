import type { SupportStatus } from '@mtg/shared';
import { useState } from 'react';
import { imageUrl } from '../api.js';

/**
 * A card as the new-run form shows it: its image through the server's cache, or — when
 * images are off, or Scryfall does not answer — a text frame with its name, type and mana
 * value (docs/08 "Rendering": "art loads lazily via the image proxy and can be disabled").
 */

const supportStyle: Record<SupportStatus, { glyph: string; className: string }> = {
  supported: { glyph: '✓', className: 'border-sky-700 bg-sky-950 text-sky-200' },
  partial: { glyph: '◐', className: 'border-amber-700 bg-amber-950 text-amber-200' },
  unsupported: { glyph: '✕', className: 'border-orange-700 bg-orange-950 text-orange-200' },
  unscripted: { glyph: '?', className: 'border-slate-600 bg-slate-800 text-slate-300' },
};

/** Support status in words and a glyph, never colour alone (docs/08 "Accessibility"). */
export const SupportBadge = ({ support }: { support: SupportStatus }) => {
  const style = supportStyle[support];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${style.className}`}
    >
      <span aria-hidden="true">{style.glyph}</span>
      {support}
    </span>
  );
};

export interface TileCard {
  readonly oracleId: string;
  readonly name: string;
  readonly count: number;
  readonly typeLine: string;
  readonly manaValue: number;
  readonly support: SupportStatus;
}

export const CardTile = ({ card, images }: { card: TileCard; images: boolean }) => {
  const [failed, setFailed] = useState(false);
  const showImage = images && !failed;
  return (
    <li className="relative flex flex-col gap-1" data-testid="card-tile">
      {showImage ? (
        <img
          src={imageUrl(card.oracleId)}
          alt={card.name}
          loading="lazy"
          width={146}
          height={204}
          className="aspect-[146/204] w-full rounded-md bg-slate-800 object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="flex aspect-[146/204] w-full flex-col justify-between rounded-md border border-slate-700 bg-slate-900 p-2 pt-8 text-xs">
          <span className="font-medium text-slate-100">{card.name}</span>
          <span className="text-slate-400">
            {card.typeLine} · {card.manaValue}
          </span>
        </div>
      )}
      <span className="absolute top-1 left-1 rounded bg-slate-950/85 px-1.5 text-sm font-semibold tabular-nums">
        {card.count}×
      </span>
      <span className="flex items-center justify-between gap-1 text-xs">
        <span className="truncate text-slate-300" title={card.name}>
          {card.name}
        </span>
        <SupportBadge support={card.support} />
      </span>
    </li>
  );
};

/** A list of cards, lands last, cheapest first, as a deck reads. */
export const sortForDisplay = <T extends TileCard>(cards: readonly T[]): T[] =>
  [...cards].sort((a, b) => {
    const landA = /\bLand\b/.test(a.typeLine) ? 1 : 0;
    const landB = /\bLand\b/.test(b.typeLine) ? 1 : 0;
    return landA - landB || a.manaValue - b.manaValue || a.name.localeCompare(b.name);
  });
