import type { AbilityDef, CardDefinition, Quantity } from '@mtg/engine';
import type { CardScript, ScriptAbility } from './schema.js';

function ptValue(v: number | Quantity | string | undefined): number | Quantity | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
    throw new Error(`Non-numeric power/toughness "${v}" must be given as a quantity expression`);
  }
  return v;
}

function stripCovers(a: ScriptAbility): AbilityDef {
  const { covers: _covers, ...rest } = a;
  return rest as AbilityDef;
}

/** Turns a validated card script into the engine's CardDefinition (docs/03: one loader for hand and auto scripts). */
export function toDefinition(script: CardScript): CardDefinition {
  const def: CardDefinition = {
    id: script.oracleId,
    name: script.name,
    types: script.types.slice(),
    abilities: script.abilities.map(stripCovers),
  };
  if (script.manaCost !== undefined) def.manaCost = script.manaCost;
  if (script.colors) def.colors = script.colors.slice();
  if (script.supertypes) def.supertypes = script.supertypes.slice();
  if (script.subtypes) def.subtypes = script.subtypes.slice();
  const p = ptValue(script.power);
  const t = ptValue(script.toughness);
  if (p !== undefined) def.power = p;
  if (t !== undefined) def.toughness = t;
  if (script.loyalty !== undefined) def.loyalty = script.loyalty;
  return def;
}
