/**
 * `pnpm cards:new "<name>" ["<name>" ...]` — scaffold a hand script from the printed card
 * (docs/03 "Hand-script workflow").
 *
 * Two things come back from Scryfall and both are written down. The card's
 * characteristics go into the skeleton, because a script that disagrees with the printed
 * card is unsupported and there is no reason to retype a mana cost by hand and find that
 * out later. And the projection goes into a committed fixture, because the validator has
 * to run in CI, where there is no network and no 500 MB bulk file.
 *
 * The oracle text is written into the skeleton as numbered comments: those numbers are
 * what `covers:` claims, and every one of them has to be claimed by exactly one ability.
 *
 * Existing scripts are never overwritten — the skeleton is the start of the work, not the
 * work, and clobbering a finished script would throw it away.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CardProjection } from '@mtg/cards';
import { sentencesOf } from '@mtg/cards';
import { project } from './fetch-scryfall.js';

const USER_AGENT = 'mtg-1v1-agents/0.1 (https://github.com/MarkJG94/mtg-1v1-agents)';
const FIXTURE = 'packages/cards/fixtures/scryfall.json';
const SCRIPTS = 'packages/cards/scripts';

/** Scryfall asks for no more than ten requests a second; this is well inside that. */
const POLITE_DELAY_MS = 250;

const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const pathFor = (name: string): string => {
  const slug = slugOf(name);
  return join(SCRIPTS, slug.slice(0, 1), `${slug}.yaml`);
};

const readFixture = (): Record<string, CardProjection> =>
  existsSync(FIXTURE)
    ? (JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, CardProjection>)
    : {};

const writeFixture = (fixture: Record<string, CardProjection>): void => {
  mkdirSync(dirname(FIXTURE), { recursive: true });
  const ordered = Object.fromEntries(
    Object.entries(fixture).sort(([, left], [, right]) => left.name.localeCompare(right.name)),
  );
  writeFileSync(FIXTURE, `${JSON.stringify(ordered, null, 2)}\n`);
};

const quote = (value: string): string => `"${value.replace(/"/g, '\\"')}"`;

const skeletonFor = (card: CardProjection): string => {
  const lines = [
    `# ${card.name}`,
    '#',
    '# Sentences to claim with `covers:`, numbered as the validator numbers them:',
    ...(sentencesOf(card.oracleText).length === 0
      ? ['#   (no rules text)']
      : sentencesOf(card.oracleText).map((sentence, index) => `#   ${index}. ${sentence}`)),
    '',
    `oracleId: ${card.oracleId}`,
    `name: ${quote(card.name)}`,
    `manaCost: ${quote(card.manaCost ?? '')}`,
  ];

  const [left = '', right = ''] = card.typeLine.split('—').map((part) => part.trim());
  const words = left.split(/\s+/).filter(Boolean);
  const supers = words.filter((word) => ['Basic', 'Legendary', 'Snow', 'World'].includes(word));
  const types = words.filter((word) => !supers.includes(word));

  lines.push(`types: [${types.map((type) => type.toLowerCase()).join(', ')}]`);
  if (supers.length > 0) {
    lines.push(`supertypes: [${supers.map((type) => type.toLowerCase()).join(', ')}]`);
  }
  if (right.length > 0) {
    lines.push(
      `subtypes: [${right
        .split(/\s+/)
        .map((type) => type.toLowerCase())
        .join(', ')}]`,
    );
  }
  lines.push(`colours: [${card.colors.join(', ')}]`);
  if (card.power !== null) lines.push(`power: ${card.power}`);
  if (card.toughness !== null) lines.push(`toughness: ${card.toughness}`);
  if (card.loyalty !== null) lines.push(`loyalty: ${card.loyalty}`);
  lines.push(`text: ${quote(card.oracleText.replace(/\n/g, ' '))}`, '', 'abilities: []');

  return `${lines.join('\n')}\n`;
};

const main = async (): Promise<void> => {
  const names = process.argv.slice(2);
  if (names.length === 0) throw new Error('usage: pnpm cards:new "<card name>" [...]');

  const fixture = readFixture();

  for (const [index, name] of names.entries()) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, POLITE_DELAY_MS));

    const url = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}`;
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!response.ok) {
      console.error(`${name}: ${response.status} ${response.statusText}`);
      process.exitCode = 1;
      continue;
    }

    const card = project((await response.json()) as Parameters<typeof project>[0]);
    if (card === null) {
      console.error(`${name}: Scryfall returned something that is not a playable card`);
      process.exitCode = 1;
      continue;
    }

    fixture[card.oracleId] = card;

    const path = pathFor(card.name);
    if (existsSync(path)) {
      console.log(`${card.name}: fixture updated, script left alone (${path})`);
      continue;
    }

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, skeletonFor(card));
    console.log(`${card.name}: ${path}`);
  }

  writeFixture(fixture);
  console.log(`\n${Object.keys(fixture).length} cards in ${FIXTURE}`);
};

await main();
