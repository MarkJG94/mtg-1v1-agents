import type { CardDefinition } from '@mtg/engine';
import { costColors, formatManaCost, parseManaCost, UNIMPLEMENTED_OPS } from '@mtg/engine';
import { toDefinition } from './loader.js';
import { normalizeOracleText } from './normalize.js';
import { type CardScript, parseCardScript } from './schema.js';
import { parseTypeLine, type ScryfallCard } from './scryfall.js';
import { smokeTest } from './smoke.js';

export type ScriptStatus = 'supported' | 'partial' | 'unsupported';

export interface ValidationResult {
  status: ScriptStatus;
  reasons: string[];
  script: CardScript | null;
  definition: CardDefinition | null;
  /** Sentences of the normalised oracle text, for error messages and tooling. */
  sentences: string[];
}

export interface ValidateOptions {
  /** Skip the executability smoke test (schema/agreement/coverage only). */
  skipSmoke?: boolean;
  smokeSeeds?: number[];
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

/** Characteristic agreement with Scryfall (docs/03 §Validation.2): a script can never change what a card costs or is. */
export function checkCharacteristics(script: CardScript, card: ScryfallCard): string[] {
  const errors: string[] = [];
  if (script.name !== card.name)
    errors.push(`name: script "${script.name}" vs Scryfall "${card.name}"`);
  const scriptCost = formatManaCost(parseManaCost(script.manaCost));
  const cardCost = formatManaCost(parseManaCost(card.mana_cost));
  if (scriptCost !== cardCost)
    errors.push(`manaCost: script "${scriptCost}" vs Scryfall "${cardCost}"`);
  const tl = parseTypeLine(card.type_line);
  if (!sameSet(script.types, tl.types))
    errors.push(`types: script [${script.types}] vs Scryfall [${tl.types}]`);
  if (!sameSet(script.supertypes ?? [], tl.supertypes))
    errors.push(`supertypes: script [${script.supertypes ?? []}] vs Scryfall [${tl.supertypes}]`);
  if (!sameSet(script.subtypes ?? [], tl.subtypes))
    errors.push(`subtypes: script [${script.subtypes ?? []}] vs Scryfall [${tl.subtypes}]`);
  const scriptColors = script.colors ?? costColors(parseManaCost(script.manaCost));
  const cardColors = card.colors ?? [];
  if (!sameSet(scriptColors, cardColors))
    errors.push(`colors: script [${scriptColors}] vs Scryfall [${cardColors}]`);
  const pt = (
    label: 'power' | 'toughness',
    scriptValue: CardScript['power'],
    cardValue: string | undefined,
  ) => {
    if (cardValue === undefined) {
      if (scriptValue !== undefined)
        errors.push(`${label}: script has a value but Scryfall has none`);
      return;
    }
    if (scriptValue === undefined) {
      errors.push(`${label}: Scryfall "${cardValue}" but script has none`);
      return;
    }
    if (cardValue.includes('*')) {
      if (
        typeof scriptValue === 'number' ||
        (typeof scriptValue === 'string' && Number.isFinite(Number(scriptValue)))
      )
        errors.push(
          `${label}: Scryfall "${cardValue}" is characteristic-defining; the script must give an expression`,
        );
      return;
    }
    const n = typeof scriptValue === 'string' ? Number(scriptValue) : scriptValue;
    if (typeof n !== 'number' || n !== Number(cardValue))
      errors.push(`${label}: script ${JSON.stringify(scriptValue)} vs Scryfall "${cardValue}"`);
  };
  pt('power', script.power, card.power);
  pt('toughness', script.toughness, card.toughness);
  if (card.loyalty !== undefined) {
    if (script.loyalty !== Number(card.loyalty))
      errors.push(`loyalty: script ${script.loyalty} vs Scryfall "${card.loyalty}"`);
  } else if (script.loyalty !== undefined)
    errors.push('loyalty: script has a value but Scryfall has none');
  return errors;
}

/** Text coverage (docs/03 §Validation.3): every sentence claimed; non-keyword abilities never share a sentence. */
export function checkTextCoverage(
  script: CardScript,
  sentences: string[],
): { errors: string[]; partial: string[] } {
  const errors: string[] = [];
  const partial: string[] = [];
  const claimedBy: number[][] = sentences.map(() => []);
  script.abilities.forEach((a, i) => {
    const covers = a.covers ?? [];
    if (covers.length === 0 && sentences.length > 0)
      errors.push(`ability ${i} (${a.kind}) claims no sentence`);
    for (const c of covers) {
      if (c < 0 || c >= sentences.length)
        errors.push(`ability ${i} covers sentence ${c} but the text has ${sentences.length}`);
      else claimedBy[c]!.push(i);
    }
  });
  sentences.forEach((s, idx) => {
    const claimers = claimedBy[idx]!;
    if (claimers.length === 0) partial.push(`sentence ${idx} is not implemented: "${s}"`);
    const nonKeyword = claimers.filter((i) => script.abilities[i]!.kind !== 'keyword');
    if (nonKeyword.length > 1)
      errors.push(`sentence ${idx} is claimed by abilities ${nonKeyword.join(', ')}`);
  });
  return { errors, partial };
}

function findUnimplementedOps(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) findUnimplementedOps(v, out);
    return;
  }
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    if (typeof rec.op === 'string' && (UNIMPLEMENTED_OPS as readonly string[]).includes(rec.op))
      out.add(rec.op);
    for (const v of Object.values(rec)) findUnimplementedOps(v, out);
  }
}

/**
 * Full validation pipeline. `unsupported` = schema, agreement or executability failure; `partial` = valid
 * but with unclaimed oracle text or ops the engine does not execute yet. Only `supported` scripts are played.
 */
export function validateScript(
  raw: unknown,
  card: ScryfallCard,
  opts: ValidateOptions = {},
): ValidationResult {
  const parsed = parseCardScript(raw);
  if (!parsed.ok || !parsed.script)
    return {
      status: 'unsupported',
      reasons: parsed.errors.map((e) => `schema: ${e}`),
      script: null,
      definition: null,
      sentences: [],
    };
  const script = parsed.script;
  const reasons: string[] = [];
  if (script.oracleId !== card.oracle_id)
    reasons.push(`oracleId: script "${script.oracleId}" vs Scryfall "${card.oracle_id}"`);
  reasons.push(...checkCharacteristics(script, card));
  const normalized = normalizeOracleText(card.oracle_text, card.name);
  const scriptText = normalizeOracleText(script.text, card.name);
  if (scriptText.sentences.join('\n') !== normalized.sentences.join('\n'))
    reasons.push("text: the script's oracle text differs from Scryfall");
  const coverage = checkTextCoverage(script, normalized.sentences);
  reasons.push(...coverage.errors);
  if (reasons.length > 0)
    return {
      status: 'unsupported',
      reasons,
      script,
      definition: null,
      sentences: normalized.sentences,
    };

  let definition: CardDefinition;
  try {
    definition = toDefinition(script);
  } catch (e) {
    return {
      status: 'unsupported',
      reasons: [`loader: ${(e as Error).message}`],
      script,
      definition: null,
      sentences: normalized.sentences,
    };
  }
  const partial = [...coverage.partial];
  const unimplemented = new Set<string>();
  findUnimplementedOps(script.abilities, unimplemented);
  for (const op of unimplemented) partial.push(`op "${op}" is not implemented by the engine yet`);

  if (!opts.skipSmoke) {
    const smoke = smokeTest(definition, opts.smokeSeeds);
    if (!smoke.ok)
      return {
        status: 'unsupported',
        reasons: smoke.reasons.map((r) => `executability: ${r}`),
        script,
        definition,
        sentences: normalized.sentences,
      };
  }
  if (partial.length > 0)
    return {
      status: 'partial',
      reasons: partial,
      script,
      definition,
      sentences: normalized.sentences,
    };
  return { status: 'supported', reasons: [], script, definition, sentences: normalized.sentences };
}
