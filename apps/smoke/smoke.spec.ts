import { expect, test } from '@playwright/test';

/**
 * The smoke (docs/09 §7): a person makes a run with a fixed seed, watches one of its games,
 * bans a card one of its decks holds, and sees the legalisation that ban forces — against a
 * real server with real workers, through the real app, in under a minute or two.
 */

interface Slot {
  readonly oracleId: string;
  readonly count: number;
}

test('a run is made, watched, and a ban in it legalises the deck that held the card', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));

  // Made with a fixed seed, small enough to play quickly.
  await page.goto('/runs/new');
  await page.getByLabel('Name', { exact: true }).fill('smoke');
  await page.getByLabel('Seed (empty for a random one)').fill('7');
  for (const [label, value] of [
    ['Matches per cycle', '2'],
    ['Tiebreak matches', '1'],
    ['Turn cap', '30'],
    ['Shortlist size', '6'],
    ['Trial candidates', '1'],
    ['Trial matches', '1'],
  ] as const) {
    await page.getByLabel(label, { exact: true }).fill(value);
  }
  await page.getByRole('combobox', { name: 'Agent level' }).selectOption('greedy');
  await page.getByRole('button', { name: 'Create run' }).click();
  // Made, it opens on its dashboard.
  await page.waitForURL(
    (url) => /^\/runs\/[^/]+$/.test(url.pathname) && url.pathname !== '/runs/new',
  );
  const runId = decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1) ?? '');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('smoke');

  // Playing, and watched: a game of it on the board with its play-by-play.
  await page.getByRole('button', { name: 'start' }).click();
  await page.getByRole('link', { name: 'Watch live' }).click();
  await expect(page).toHaveURL(`/runs/${encodeURIComponent(runId)}/live`);
  await expect(page.getByTestId('live-game')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('ticker-line').first()).toBeVisible();
  await expect(page.getByTestId('board')).toContainText('Agent A');

  // A card agent A's deck holds, by name.
  const run = await (await request.get(`/api/runs/${encodeURIComponent(runId)}`)).json();
  const main = run.decks.A.deck.main as Slot[];
  const looked = await (
    await request.post('/api/cards/lookup', { data: { oracleIds: main.map((s) => s.oracleId) } })
  ).json();
  const card = (looked.cards as { oracleId: string; name: string; typeLine: string }[]).find(
    (each) => !/\bLand\b/.test(each.typeLine) && !each.name.includes('//'),
  );
  expect(card).toBeDefined();
  const held = main.find((slot) => slot.oracleId === card?.oracleId)?.count ?? 0;

  // Banned from the dashboard, which says first what it will cost.
  await page.goto(`/runs/${encodeURIComponent(runId)}`);
  const bans = page.getByRole('region', { name: 'Ban console' });
  await bans.getByLabel('Search any card').fill(card?.name ?? '');
  await bans
    .getByRole('list', { name: 'Card search results' })
    .getByRole('button', { name: new RegExp(`^${literally(card?.name ?? '')} `) })
    .first()
    .click();
  await expect(bans.getByTestId('ban-effect')).toContainText(
    `Agent A holds ${held} and must cut to 0`,
  );
  await bans.getByRole('button', { name: 'Ban', exact: true }).click();
  await expect(bans.getByRole('list', { name: 'Ban list' })).toContainText(card?.name ?? '');

  // After the game in progress, the ban takes effect and A's deck is legalised.
  const legalisations = bans.getByRole('list', { name: 'Legalisations' });
  await expect(legalisations).toContainText(`− ${held} ${card?.name}`, { timeout: 90_000 });

  await page.getByRole('button', { name: 'pause' }).click();
  expect(errors).toEqual([]);
});

const literally = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
