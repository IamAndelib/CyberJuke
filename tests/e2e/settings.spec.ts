import { expect, test } from '../fixtures';
import { cssVar, opened, playerCalls, recordOpens, seedStorage, SETTINGS_KEY, start, waitForTracks } from '../helpers';

/** Settings: themes, NSFW, the new-tracks interval, the IPv4 setting and the card order. */

test('switching theme changes the CSS variables and persists', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await cssVar(page, '--color-bg')).toBe('#000');
  expect(await cssVar(page, '--color-fg')).toBe('#efe5c0');
  await page.getByTestId('tab-settings').click();
  await page.getByTestId('theme-light').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await cssVar(page, '--color-bg')).toBe('#efe5c0');
  expect(await cssVar(page, '--color-fg')).toBe('#000');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(239, 229, 192)');
  await page.getByTestId('theme-c64').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'c64');
  expect(await cssVar(page, '--color-bg')).toBe('#2a2ab8');
  await page.getByTestId('theme-brutalist').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'brutalist');
  expect(await cssVar(page, '--color-bg')).toBe('#080810');
  expect(await cssVar(page, '--color-fg')).toBe('#c0d0e8');
  await expect(page.getByTestId('theme-grid')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'brutalist');
});

test('a saved GRiD theme migrates to Brutalist', async ({ page }) => {
  await seedStorage(page, { [SETTINGS_KEY]: { theme: 'grid', showNsfw: false, quality: 'high' } });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'brutalist');
  expect(await cssVar(page, '--color-bg')).toBe('#080810');
  await page.getByTestId('tab-settings').click();
  await expect(page.getByTestId('theme-brutalist')).toHaveAttribute('aria-pressed', 'true');
});

test('NSFW is hidden by default and the toggle persists', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-settings').click();
  const toggle = page.getByTestId('nsfw-toggle');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page.reload();
  await page.getByTestId('tab-settings').click();
  await expect(page.getByTestId('nsfw-toggle')).toHaveAttribute('aria-checked', 'true');
});

test('"Check for new tracks" interval is a setting that persists', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-settings').click();
  const group = page.getByTestId('check-every');
  await expect(page.getByTestId('check-every-15')).toHaveAttribute('aria-checked', 'true');
  await expect(group.getByRole('radio')).toHaveText(['5 min', '15 min', '30 min', '1 hour', 'Only when I refresh']);
  await page.getByTestId('check-every-0').click();
  await expect(page.getByTestId('check-every-0')).toHaveAttribute('aria-checked', 'true');
  await page.reload();
  await page.getByTestId('tab-settings').click();
  await expect(page.getByTestId('check-every-0')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('check-every-0').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('check-every-5')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('check-every-5')).toBeFocused();
});

test('IPv4: Auto by default, sent to the player at start and on change, and kept', async ({ page }) => {
  await page.goto('/');
  const prefs = async () => (await playerCalls(page)).filter((c) => c[0] === 'setNetworkPrefs').map((c) => c[1]);
  await expect.poll(prefs).toEqual([{ ipv4: 'auto' }]);
  await page.getByTestId('tab-settings').click();
  await expect(page.getByTestId('ipv4-auto')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('screen-settings')).toContainText('Auto switches when IPv6 gets blocked.');
  await page.getByTestId('ipv4-always').click();
  await expect(page.getByTestId('ipv4-always')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('ipv4-auto')).toHaveAttribute('aria-checked', 'false');
  await expect.poll(prefs).toEqual([{ ipv4: 'auto' }, { ipv4: 'always' }]);
  await page.reload();
  await expect.poll(prefs).toEqual([{ ipv4: 'always' }]);
  await page.getByTestId('tab-settings').click();
  await expect(page.getByTestId('ipv4-always')).toHaveAttribute('aria-checked', 'true');
  // No native side, no status line.
  await expect(page.getByTestId('net-status')).toHaveCount(0);
});

test('an old "Prefer IPv4: on" becomes Always', async ({ page }) => {
  await seedStorage(page, { [SETTINGS_KEY]: { theme: 'dark', preferIpv4: true } });
  await page.goto('/');
  await page.getByTestId('tab-settings').click();
  await expect(page.getByTestId('ipv4-always')).toHaveAttribute('aria-checked', 'true');
});

test('the connection line shows how YouTube is reached, for bug reports', async ({ page }) => {
  await page.addInitScript(() => {
    window.__cyberjukeNetStatus = {
      family: 'IPv4',
      ipv4: 'auto',
      autoIpv4: true,
      lastLimit: { at: Date.now() - 60_000, reason: 'BOT_CHECK', surface: 'playback' },
    };
  });
  await page.goto('/');
  await page.getByTestId('tab-settings').click();
  const line = page.getByTestId('net-status');
  await expect(line).toContainText('Connection: IPv4 (switched by Auto) · last limit ');
  await expect(line).toContainText(', bot check');
  // Selectable, so it can be copied into an issue.
  expect(await line.evaluate((el) => getComputedStyle(el).userSelect)).toBe('text');
});

test('the connection line is fresh each time Settings is shown (Auto may switch without a block)', async ({ page }) => {
  await page.addInitScript(() => {
    window.__cyberjukeNetStatus = { ipv4: 'auto', autoIpv4: false };
  });
  await page.goto('/');
  await page.getByTestId('tab-settings').click();
  await expect(page.getByTestId('net-status')).toHaveText('Connection: not used yet · no limits so far');
  await page.getByTestId('tab-home').click();
  await page.evaluate(() => {
    window.__cyberjukeNetStatus = { family: 'IPv6', ipv4: 'auto', autoIpv4: true };
  });
  await page.getByTestId('tab-settings').click();
  await expect(page.getByTestId('net-status')).toHaveText('Connection: IPv4 (switched by Auto) · no limits so far');
});

test('Account is the first card and says "members-only shared tracks"', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-settings').click();
  const settings = page.getByTestId('screen-settings');
  await expect(settings.locator('.card-title')).toHaveText(['Account', 'Theme', 'Playback & data', 'Updates', 'About', 'Licenses', 'Source code']);
  const account = page.getByTestId('account');
  expect((await account.boundingBox())!.y).toBeLessThan((await page.getByTestId('theme-picker').boundingBox())!.y);
  await expect(account.locator('.signin-lead')).toHaveText('Optional. Signed in, the Jukebox also shows members-only shared tracks, marked [members].');
  await expect(settings).not.toContainText('members-only posts');
  await expect(page.getByTestId('about')).toContainText('Signing in adds members-only tracks.');
});

test('Source code: the last card links to the repository and its latest release', async ({ page }) => {
  await recordOpens(page);
  await page.goto('/');
  await page.getByTestId('tab-settings').click();
  const card = page.getByTestId('source-code');
  await card.scrollIntoViewIfNeeded();
  // The very last card on the page.
  expect(await page.getByTestId('screen-settings').locator('section.card').last().getAttribute('data-testid')).toBe('source-code');
  await card.getByTestId('source-repo').getByRole('link').click();
  await card.getByTestId('source-releases').getByRole('link').click();
  expect(await opened(page)).toEqual(['https://github.com/IamAndelib/CyberJuke', 'https://github.com/IamAndelib/CyberJuke/releases/latest']);
});

test('Licenses: every bundled library is listed and the full texts open in the app', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-settings').click();
  await page.getByText('Libraries', { exact: true }).click();
  for (const name of ['NewPipeExtractor', 'Media3', 'OkHttp', 'Kotlin', 'kotlinx.coroutines', 'Apache Cordova', 'Ionic filesystem', 'Rhino', 'jsoup', 'Protocol Buffers', 'desugar_jdk_libs']) {
    await expect(page.getByTestId('libraries')).toContainText(name);
  }
  await page.getByTestId('license-texts').locator('summary').click();
  const text = page.getByTestId('license-texts').locator('pre');
  for (const t of ['Apache License', 'Mozilla Public License Version 2.0', 'GNU GENERAL PUBLIC LICENSE', 'Version 3, 29 June 2007', 'CLASSPATH', 'Copyright (c) 2015-present Jason Miller', 'Copyright (c) 2025 Ionic', 'Copyright 2008 Google Inc.']) {
    await expect(text).toContainText(t);
  }
});

const LATEST = 'https://api.github.com/repos/IamAndelib/CyberJuke/releases/latest';
const latest = (tag: string) => ({ tag_name: tag, html_url: `https://github.com/IamAndelib/CyberJuke/releases/tag/${tag}`, draft: false, prerelease: false });

test('Updates: Check now finds a newer release (banner, dot on the tab), or says it is up to date, or that it could not check', async ({ page }) => {
  let answer: { status: number; body?: unknown } = { status: 200, body: latest('v99.0.0') };
  await page.route(LATEST, (route) => route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body ?? {}) }));
  await start(page);
  await page.getByTestId('tab-settings').click();
  const card = page.getByTestId('updates');
  await expect(card.getByTestId('updates-auto')).toHaveAttribute('aria-checked', 'true');
  await expect(card.getByTestId('updates-status')).toHaveText('Not checked yet.');
  await expect(page.getByTestId('settings-update-dot')).toHaveCount(0);

  await card.getByTestId('updates-check').click();
  await expect(card.getByTestId('updates-status')).toHaveText('CyberJuke 99.0.0 is available.');
  await expect(page.getByTestId('update-banner')).toContainText('CyberJuke 99.0.0 is out');
  await expect(page.getByTestId('update-download')).toBeVisible();
  await expect(page.getByTestId('settings-update-dot')).toBeVisible();
  await expect(page.getByTestId('tab-settings')).toHaveAttribute('aria-label', 'Settings (update available)');
  // Remembered: still shown after a restart, without asking again.
  await page.reload();
  await waitForTracks(page);
  await expect(page.getByTestId('settings-update-dot')).toBeVisible();

  // The latest release is not newer than this version: up to date, no banner, no dot.
  // (While an update is shown, Download replaces Check now: start afresh.)
  answer = { status: 200, body: latest('v0.0.1') };
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await waitForTracks(page);
  await page.getByTestId('tab-settings').click();
  await page.getByTestId('updates').getByTestId('updates-check').click();
  await expect(page.getByTestId('updates-status')).toHaveText(/^Up to date \(\d+\.\d+\.\d+\)\. Checked \S+ \S+, \d{1,2}:\d{2}( [AP]M)?\.$/);
  await expect(page.getByTestId('update-banner')).toHaveCount(0);
  await expect(page.getByTestId('settings-update-dot')).toHaveCount(0);

  // GitHub unreachable: says so; nothing else changes.
  answer = { status: 503 };
  await page.getByTestId('updates').getByTestId('updates-check').click();
  await expect(page.getByTestId('updates-status')).toHaveText("Couldn't check. Try again later.");
});

test('Updates: the automatic check is a setting that persists', async ({ page }) => {
  await start(page);
  await page.getByTestId('tab-settings').click();
  const auto = page.getByTestId('updates-auto');
  await auto.click();
  await expect(auto).toHaveAttribute('aria-checked', 'false');
  await page.reload();
  await waitForTracks(page);
  await page.getByTestId('tab-settings').click();
  await expect(page.getByTestId('updates-auto')).toHaveAttribute('aria-checked', 'false');
});

test('radio groups and the Library tabs are one Tab stop each, worked with the arrow keys', async ({ page }) => {
  await start(page);
  await page.getByTestId('tab-settings').click();
  await page.getByTestId('quality-high').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('quality-low')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('quality-low')).toBeFocused();
  await expect(page.getByTestId('quality-high')).toHaveAttribute('tabindex', '-1');
  await page.getByTestId('ipv4-auto').focus();
  await page.keyboard.press('End');
  await expect(page.locator('[data-testid^="ipv4-"]').last()).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('tab-library').click();
  await page.getByTestId('lib-liked').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('lib-recent')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('lib-recent')).toBeFocused();
});
