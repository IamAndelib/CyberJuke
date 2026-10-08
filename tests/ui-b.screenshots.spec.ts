import { expect, test, type Page } from '@playwright/test';
import { stubMusic, stubYouTube } from './stubs';

/**
 * Screenshots for feedback round 3 (web engineer B), saved to media/web-screenshots/b-*.png:
 * lyrics (synced, right-to-left), Share in the ⋯ menu, Up Next with "Queued by you",
 * history day groups, the new-tracks pill and Settings. Run: npm run screenshots
 */

const OUT = 'media/web-screenshots';
const shot = (page: Page, name: string) => page.screenshot({ path: `${OUT}/b-${name}.png` });

async function settle(page: Page) {
  await expect(page.getByTestId('skeleton')).toHaveCount(0);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
}

async function open(page: Page, theme = 'dark') {
  await page.addInitScript((t) => {
    if (!localStorage.getItem('CapacitorStorage.settings')) localStorage.setItem('CapacitorStorage.settings', JSON.stringify({ theme: t }));
  }, theme);
  await stubYouTube(page);
  await stubMusic(page);
  await page.goto('/');
  await expect(page.getByTestId('track-row').first()).toBeVisible();
  await settle(page);
}

const lyricsMode = (page: Page, m: string) => page.evaluate((x) => ((window as unknown as { __cyberjukeLyricsMode: string }).__cyberjukeLyricsMode = x), m);

for (const theme of ['dark', 'light', 'matrix']) {
  test(`Now Playing lyrics, Share, Up Next (${theme})`, async ({ page }) => {
    await open(page, theme);
    await lyricsMode(page, 'greek');
    await page.getByTestId('track-play').nth(0).click();
    for (const i of [4, 5]) {
      await page.getByTestId('track-more').nth(i).click();
      if (i === 4 && theme === 'dark') {
        await page.waitForTimeout(400);
        await shot(page, `menu-share-${theme}`);
      }
      await page.getByTestId('menu-add-queue').click();
    }
    await page.waitForTimeout(3500); // toasts clear
    await page.getByTestId('mini-open').click();
    await page.waitForTimeout(400);
    await page.getByTestId('np-art').click();
    await expect(page.getByTestId('np-lyrics')).toHaveAttribute('data-kind', 'synced');
    await page.waitForTimeout(1200);
    await shot(page, `lyrics-synced-${theme}`);

    await lyricsMode(page, 'arabic');
    await page.getByTestId('np-next').click(); // plays the first queued track
    await expect(page.getByTestId('np-lyrics')).toContainText('القمر');
    await page.waitForTimeout(1200);
    await shot(page, `lyrics-rtl-${theme}`);

    await lyricsMode(page, 'japanese');
    await page.getByTestId('np-next').click();
    await expect(page.getByTestId('np-lyrics')).toContainText('夜の街');
    await page.waitForTimeout(1200);
    await shot(page, `lyrics-cjk-${theme}`);

    // Queue two more, then look at Up Next.
    await page.getByTestId('np-close').click();
    for (const i of [7, 8]) {
      await page.getByTestId('track-more').nth(i).click();
      await page.getByTestId('menu-add-queue').click();
    }
    await page.waitForTimeout(3500);
    await page.getByTestId('mini-open').click();
    await page.waitForTimeout(400);
    await page.getByTestId('up-next').evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(300);
    await shot(page, `upnext-queued-${theme}`);

    await page.getByTestId('np-more').click();
    await page.waitForTimeout(400);
    await shot(page, `np-menu-share-${theme}`);
  });

  test(`history days, pill, settings (${theme})`, async ({ page }) => {
    await page.addInitScript(() => {
      if (localStorage.getItem('CapacitorStorage.history')) return;
      const now = Date.now();
      const D = 86_400_000;
      const titles = ['Midnight Drive', 'Neon Rain', 'Paper Moons', 'Static Hearts', 'Low Tide', 'Glass Garden', 'Afterglow', 'Echo Park'];
      const ids = ['dQw4w9WgXcQ', 'kJQP7kiw5Fk', '9bZkp7q2f7I', 'fJ9rUzIMcZQ', 'hTWKbfoikeg', 'YQHsXMglC9A', 'RgKAFK5djSk', 'OPf0YbXqDm0'];
      const at = (d: number, h: number) => {
        const x = new Date(now - d * D);
        x.setHours(h, 0, 0, 0);
        return Math.min(now, x.getTime());
      };
      const entries = titles.map((t, i) => ({
        track: { id: 'seed' + i, ytId: ids[i], title: t, artist: ['The Midnight', 'Tycho', 'Khruangbin'][i % 3], genre: ['synthwave', 'ambient', 'funk'][i % 3], by: 'cyberpunk', postTitle: '', postUrl: '', createdAt: '2026-10-01T00:00:00Z', nsfw: false, artworkUrl: `https://i.ytimg.com/vi/${ids[i]}/hqdefault.jpg` },
        playedAt: at(i < 3 ? 0 : i < 5 ? 1 : 3, 20 - i),
      }));
      localStorage.setItem('CapacitorStorage.history', JSON.stringify(entries));
    });
    const future = Date.now() + 3600_000;
    await page.route(/firestore\.googleapis\.com\/.*:runQuery/, async (route) => {
      const q = JSON.parse(route.request().postData() ?? '{}').structuredQuery;
      const fields = q?.select?.fields?.map((f: { fieldPath: string }) => f.fieldPath) ?? [];
      if (fields.length === 1 && fields[0] === 'createdAt') {
        const rows = [0, 1, 2].map((i) => ({ document: { name: `p/new${i}`, fields: { createdAt: { timestampValue: new Date(future - i * 1000).toISOString() } } } }));
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
      }
      return route.continue();
    });
    await open(page, theme);
    await page.evaluate(() => (window as unknown as { __cyberjukeFreshness: { check(): Promise<void> } }).__cyberjukeFreshness.check());
    await expect(page.getByTestId('new-tracks-pill')).toBeVisible();
    await page.waitForTimeout(400);
    await shot(page, `pill-${theme}`);
    await page.getByTestId('screen-home').evaluate((el) => el.scrollTo(0, 700));
    await page.waitForTimeout(400);
    await shot(page, `pill-scrolled-${theme}`);

    await page.getByTestId('tab-library').click();
    await page.getByTestId('lib-recent').click();
    await expect(page.getByTestId('history-day-label')).toHaveCount(3);
    await settle(page);
    await shot(page, `history-days-${theme}`);

    await page.getByTestId('tab-settings').click();
    await page.getByTestId('check-every').scrollIntoViewIfNeeded();
    await page.getByTestId('screen-settings').evaluate((el) => el.scrollBy(0, 120));
    await page.waitForTimeout(300);
    await shot(page, `settings-${theme}`);
  });
}

test('360px wide: lyrics, Up Next, settings', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 760 });
  await open(page);
  await lyricsMode(page, 'spanish');
  await page.getByTestId('track-play').nth(0).click();
  await page.getByTestId('track-more').nth(3).click();
  await page.getByTestId('menu-add-queue').click();
  await page.waitForTimeout(3500);
  await page.getByTestId('mini-open').click();
  await page.waitForTimeout(400);
  await page.getByTestId('np-art').click();
  await page.waitForTimeout(1200);
  await shot(page, 'lyrics-360');
  await page.getByTestId('np-close').click();
  await page.getByTestId('tab-settings').click();
  await page.getByTestId('check-every').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await shot(page, 'settings-360');
});
