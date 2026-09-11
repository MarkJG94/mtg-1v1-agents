import type { CostDef, Effect, ModeDef } from '@mtg/engine';
import { normalizeOracleText } from '../normalize.js';
import type { CardScript, ScriptAbility } from '../schema.js';
import { parseTypeLine, type ScryfallCard, SUPPORTED_LAYOUTS } from '../scryfall.js';
import {
  classify,
  missingKeywords,
  parseActivated,
  parseAdditionalCost,
  parseEnchant,
  parseEquip,
  parseKeywordLine,
  parseLoyalty,
  parseSpellSentence,
  parseStatic,
  parseTriggered,
  type SentenceKind,
  unimplementedKeyword,
} from './abilities.js';
import { applyNoRegenerate, Bindings, parseEffects } from './effects.js';
import { foldText, Scanner } from './scan.js';

/** Bumping this invalidates every cached auto script (docs/03 §Sources of truth). */
export const AUTO_SCRIPTER_VERSION = 3;

export interface SentenceFailure {
  index: number;
  kind: SentenceKind;
  sentence: string;
  /** The rule that gave up and the text it stopped on — the coverage report groups on this. */
  reason: string;
}

export interface ScriptAttempt {
  script: CardScript | null;
  reasons: string[];
  failures: SentenceFailure[];
}

/** A bullet line of a modal spell, with the leading marker the tokeniser folds "\u2022" to. */
function bulletText(line: string[]): string | null {
  const first = foldText(line[0] ?? '').trimStart();
  if (!first.startsWith('*')) return null;
  return [first.replace(/^\*\s*/, ''), ...line.slice(1).map(foldText)].join(' ');
}

/**
 * "Choose one --" followed by bullet lines becomes one spell ability with `modes` (docs/03 §Vocabulary).
 * Each mode gets its own bindings, so its targets are chosen only when that mode is picked.
 */
function parseModal(
  lines: string[][],
  lineStart: number[],
  li: number,
): { modes: ModeDef[]; covers: number[]; lastLine: number; failure: string | null } | null {
  const head = foldText(lines[li]!.join(' ')).trim();
  if (!/^choose one\b/i.test(head)) return null;
  const covers = lines[li]!.map((_, k) => lineStart[li]! + k);
  const modes: ModeDef[] = [];
  let last = li;
  let bullets = 0;
  let failure: string | null = null;
  for (let j = li + 1; j < lines.length; j++) {
    const text = bulletText(lines[j]!);
    if (text === null) break;
    bullets++;
    covers.push(...lines[j]!.map((_, k) => lineStart[j]! + k));
    last = j;
    const b = new Bindings();
    const s = Scanner.of(text);
    const effects = parseEffects(s, b);
    if (!effects || !s.finish()) {
      // Report the mode that could not be read; blaming "Choose one" hides which one it was.
      failure ??= `mode: ${s.remainder() || text}`;
      continue;
    }
    const mode: ModeDef = { label: text.replace(/\.$/, '').slice(0, 60), effects };
    if (b.targets.length > 0) mode.targets = b.targets;
    modes.push(mode);
  }
  if (bullets < 2) return null;
  return { modes, covers, lastLine: last, failure };
}

/** Characteristics the auto-scripter refuses outright, because only a hand script can express them. */
function unscriptable(card: ScryfallCard): string | null {
  if (!SUPPORTED_LAYOUTS.has(card.layout)) return `layout "${card.layout}" is not supported`;
  if (card.card_faces && card.card_faces.length > 1) return 'multi-faced cards need a hand script';
  if (card.power?.includes('*') || card.toughness?.includes('*'))
    return 'characteristic-defining power/toughness needs a hand script';
  if (card.loyalty !== undefined && !Number.isFinite(Number(card.loyalty)))
    return `non-numeric loyalty "${card.loyalty}"`;
  if (card.power !== undefined && !Number.isFinite(Number(card.power)))
    return `non-numeric power "${card.power}"`;
  if (card.toughness !== undefined && !Number.isFinite(Number(card.toughness)))
    return `non-numeric toughness "${card.toughness}"`;
  const tl = parseTypeLine(card.type_line);
  if (tl.types.length === 0) return `no supported card type in "${card.type_line}"`;
  return null;
}

/**
 * Oracle text → card script (docs/03 §Auto-scripter). Every sentence is classified and handed to its
 * grammar; a sentence that will not parse is reported rather than silently dropped, so the card comes
 * back `null` and the resolver logs it as unsupported.
 */
export function scriptCard(card: ScryfallCard): ScriptAttempt {
  const blocked = unscriptable(card);
  if (blocked) return { script: null, reasons: [blocked], failures: [] };

  const tl = parseTypeLine(card.type_line);
  const normalized = normalizeOracleText(card.oracle_text, card.name);
  const abilities: ScriptAbility[] = [];
  const failures: SentenceFailure[] = [];

  // Instants and sorceries resolve once, so every spell sentence feeds one ability with shared bindings.
  const spellEffects: Effect[] = [];
  const spellCovers: number[] = [];
  const spellBindings = new Bindings();

  // Modal spells put the choice on one line and each mode on a bullet line after it.
  const lineStart: number[] = [];
  let running = 0;
  for (const line of normalized.lines) {
    lineStart.push(running);
    running += line.length;
  }

  let spellModes: ModeDef[] | null = null;
  let additionalCost: CostDef | null = null;

  for (let li = 0; li < normalized.lines.length; li++) {
    const line = normalized.lines[li]!;
    const base = lineStart[li]!;
    const covers = line.map((_, k) => base + k);

    const modal = parseModal(normalized.lines, lineStart, li);
    if (modal) {
      if (modal.failure)
        failures.push({
          index: base,
          kind: 'spell',
          sentence: line.join(' '),
          reason: modal.failure,
        });
      spellModes = modal.modes;
      spellCovers.push(...modal.covers);
      li = modal.lastLine;
      continue;
    }

    const keywordLine = parseKeywordLine(line.join(' '));
    if (keywordLine) {
      for (const a of keywordLine) abilities.push({ ...a, covers });
      continue;
    }

    line.forEach((sentence, k) => {
      const i = base + k;
      const folded = foldText(sentence);
      const kind = classify(folded, { types: tl.types, keywords: card.keywords });
      const record = (reason: string): void => {
        failures.push({ index: i, kind, sentence, reason });
      };

      // These two qualify the ability above them rather than standing on their own.
      if (/^activate only as a sorcery\.?$/i.test(folded)) {
        const last = abilities[abilities.length - 1];
        if (last?.kind === 'activated') {
          last.timing = 'sorcery';
          last.covers = [...(last.covers ?? []), i];
          return;
        }
        // When the ability above already failed, its reason is the useful one; do not add a second.
        if (failures.length === 0) record('timing restriction with no activated ability above it');
        return;
      }

      if (/^this ability triggers only once each turn\.?$/i.test(folded)) {
        const last = abilities[abilities.length - 1];
        if (last?.kind === 'triggered') {
          last.oncePerTurn = true;
          last.covers = [...(last.covers ?? []), i];
          return;
        }
        if (failures.length === 0)
          record('"only once each turn" with no triggered ability above it');
        return;
      }

      const keywordAbility = unimplementedKeyword(folded);
      if (keywordAbility) {
        record(`keyword ability "${keywordAbility}" is not implemented by the engine`);
        return;
      }
      switch (kind) {
        case 'keyword': {
          const kws = parseKeywordLine(folded);
          if (!kws) {
            record(`keyword: ${sentence}`);
            return;
          }
          for (const a of kws) abilities.push({ ...a, covers: [i] });
          return;
        }
        case 'enchant': {
          const r = parseEnchant(folded);
          if (!r.value) {
            record(r.failure ?? 'enchant');
            return;
          }
          abilities.push({ ...r.value, covers: [i] });
          return;
        }
        case 'equip': {
          const r = parseEquip(folded);
          if (!r.value) {
            record(r.failure ?? 'equip');
            return;
          }
          abilities.push({ ...r.value, covers: [i] });
          return;
        }
        case 'additionalCost': {
          const r = parseAdditionalCost(folded);
          if (!r.value) {
            record(r.failure ?? 'additionalCost');
            return;
          }
          additionalCost = r.value;
          spellCovers.push(i);
          return;
        }
        case 'loyalty': {
          const r = parseLoyalty(folded);
          if (!r.value) {
            record(r.failure ?? 'loyalty');
            return;
          }
          abilities.push({ ...r.value, covers: [i] });
          return;
        }
        case 'activated': {
          const r = parseActivated(folded);
          if (!r.value) {
            record(r.failure ?? 'activated');
            return;
          }
          abilities.push({ ...r.value, covers: [i] });
          return;
        }
        case 'triggered': {
          const r = parseTriggered(folded);
          if (!r.value) {
            record(r.failure ?? 'triggered');
            return;
          }
          abilities.push({ ...r.value, covers: [i] });
          return;
        }
        case 'static': {
          const r = parseStatic(folded);
          if (!r.value) {
            record(r.failure ?? 'static');
            return;
          }
          abilities.push({ ...r.value, covers: [i] });
          return;
        }
        case 'spell': {
          const r = parseSpellSentence(folded, spellBindings);
          if (!r.value) {
            record(r.failure ?? 'spell');
            return;
          }
          spellEffects.push(...r.value);
          spellCovers.push(i);
          return;
        }
      }
    });
  }

  if (spellCovers.length > 0) {
    const ability: ScriptAbility = {
      kind: 'spell',
      effects: applyNoRegenerate(spellEffects, spellBindings),
      covers: [...spellCovers].sort((a, b) => a - b),
    };
    if (spellBindings.targets.length > 0) ability.targets = spellBindings.targets;
    if (spellModes) ability.modes = spellModes;
    if (additionalCost) ability.additionalCost = additionalCost;
    abilities.push(ability);
  }

  const reasons = failures.map((f) => `sentence ${f.index}: ${f.reason}`);
  const missing = missingKeywords(abilities, { types: tl.types, keywords: card.keywords });
  for (const k of missing) reasons.push(`Scryfall lists keyword "${k}" but no ability provides it`);
  if (reasons.length > 0) return { script: null, reasons, failures };

  const script: CardScript = {
    oracleId: card.oracle_id,
    name: card.name,
    types: tl.types,
    text: card.oracle_text ?? '',
    abilities,
    colors: (card.colors ?? []) as NonNullable<CardScript['colors']>,
  };
  if (card.mana_cost) script.manaCost = card.mana_cost;
  if (tl.supertypes.length > 0) script.supertypes = tl.supertypes;
  if (tl.subtypes.length > 0) script.subtypes = tl.subtypes;
  if (card.power !== undefined) script.power = Number(card.power);
  if (card.toughness !== undefined) script.toughness = Number(card.toughness);
  if (card.loyalty !== undefined) script.loyalty = Number(card.loyalty);
  return { script, reasons: [], failures };
}

/** The `AutoScripter` the `ScriptResolver` calls (docs/01 §Card lifecycle). */
export class GrammarAutoScripter {
  readonly version = AUTO_SCRIPTER_VERSION;

  script(card: ScryfallCard): { script: unknown | null; reasons: string[] } {
    const r = scriptCard(card);
    return { script: r.script, reasons: r.reasons };
  }

  /** Same run with the per-sentence failures kept, for `pnpm cards:coverage`. */
  explain(card: ScryfallCard): ScriptAttempt {
    return scriptCard(card);
  }
}
