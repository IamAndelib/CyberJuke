import { expect, test } from '../fixtures';
import { cssVar, opened, openSettings, playerCalls, recordOpens, seedStorage, SETTINGS_KEY, start, waitForTracks, windowChrome } from '../helpers';

/** Settings: themes, NSFW, the new-tracks interval, the IPv4 setting and the card order. */

test('Settings opens from the icon at the top right of Home, not from the tab bar, and Back returns', async ({ page }) => {
  await start(page);
  await expect(page.getByTestId('tab-settings')).toHaveCount(0);
  const open = page.getByTestId('open-settings');
  await expect(open).toHaveAttribute('aria-label', 'Settings');
  await expect(open).toHaveText('');
  await open.click();
  await expect(page.getByTestId('screen-settings')).toBeVisible();
  // Its own screen: no tab is the current one, and there is no search button here.
  await expect(page.locator('.tabbar [aria-current]')).toHaveCount(0);
  await expect(page.locator('.tabbar .tab.on')).toHaveCount(0);
  await expect(page.getByTestId('search-fab')).toHaveCount(0);
  await page.getByTestId('settings-back').click();
  await expect(page.getByTestId('screen-home')).toBeVisible();
  await expect(page.getByTestId('screen-settings')).toHaveCount(0);
  // Escape (Android back on the web) closes it too.
  await open.click();
  await expect(page.getByTestId('screen-settings')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('screen-home')).toBeVisible();
});

test('Settings and Home are separate: a tab leaves Settings, and Home shows Home, not Settings again', async ({ page }) => {
  await start(page);
  const settings = page.getByTestId('screen-settings');
  const home = page.getByTestId('tab-home');
  await page.getByTestId('open-settings').click();
  await expect(settings).toBeVisible();
  // Another tab, then Home: Home, with Home highlighted.
  await page.getByTestId('tab-genres').click();
  await expect(page.getByTestId('tab-genres')).toHaveAttribute('aria-current', 'page');
  await expect(settings).toHaveCount(0);
  await home.click();
  await expect(page.getByTestId('screen-home')).toBeVisible();
  await expect(home).toHaveAttribute('aria-current', 'page');
  await expect(settings).toHaveCount(0);
  // The Home tab itself, tapped from Settings: Home.
  await page.getByTestId('open-settings').click();
  await expect(settings).toBeVisible();
  await home.click();
  await expect(page.getByTestId('screen-home')).toBeVisible();
  await expect(home).toHaveAttribute('aria-current', 'page');
  await expect(settings).toHaveCount(0);
});

test('switching theme changes the CSS variables and persists', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await cssVar(page, '--color-bg')).toBe('#000');
  expect(await cssVar(page, '--color-fg')).toBe('#efe5c0');
  await openSettings(page);
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

test('the window follows the theme: bar icons light on a dark theme and dark on a light one, and its background kept', async ({ page }) => {
  await start(page);
  expect(await windowChrome(page, 'bars')).toEqual(['dark']);
  expect(await windowChrome(page, 'background')).toEqual(['#000']);
  await openSettings(page);
  await page.getByTestId('theme-light').click();
  await expect.poll(() => windowChrome(page, 'bars')).toEqual(['dark', 'light']);
  expect(await windowChrome(page, 'background')).toEqual(['#000', '#efe5c0']);
  await page.getByTestId('theme-c64').click();
  await expect.poll(() => windowChrome(page, 'bars')).toEqual(['dark', 'light', 'dark']);
  expect(await windowChrome(page, 'background')).toEqual(['#000', '#efe5c0', '#2a2ab8']);
});

test('changing a setting other than the theme leaves the theme alone (no restyle)', async ({ page }) => {
  await start(page);
  await openSettings(page);
  await page.evaluate(() => {
    const w = window as unknown as { __themeWrites: number };
    w.__themeWrites = 0;
    new MutationObserver((rs) => (w.__themeWrites += rs.length)).observe(document.documentElement, { attributes: true });
  });
  await page.getByTestId('check-every-5').click();
  await expect(page.getByTestId('check-every-5')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('cache-512').click();
  await expect(page.getByTestId('cache-512')).toHaveAttribute('aria-checked', 'true');
  expect(await page.evaluate(() => (window as unknown as { __themeWrites: number }).__themeWrites)).toBe(0);
});

test('a saved GRiD theme migrates to Brutalist', async ({ page }) => {
  await seedStorage(page, { [SETTINGS_KEY]: { theme: 'grid', showNsfw: false, quality: 'high' } });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'brutalist');
  expect(await cssVar(page, '--color-bg')).toBe('#080810');
  await openSettings(page);
  await expect(page.getByTestId('theme-brutalist')).toHaveAttribute('aria-pressed', 'true');
});

test('NSFW is hidden by default and the toggle persists', async ({ page }) => {
  await page.goto('/');
  await openSettings(page);
  const toggle = page.getByTestId('nsfw-toggle');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page.reload();
  await openSettings(page);
  await expect(page.getByTestId('nsfw-toggle')).toHaveAttribute('aria-checked', 'true');
});

test('"Check for new tracks" interval is a setting that persists', async ({ page }) => {
  await page.goto('/');
  await openSettings(page);
  const group = page.getByTestId('check-every');
  await expect(page.getByTestId('check-every-15')).toHaveAttribute('aria-checked', 'true');
  await expect(group.getByRole('radio')).toHaveText(['5 min', '15 min', '30 min', '1 hour', 'Only when I refresh']);
  await page.getByTestId('check-every-0').click();
  await expect(page.getByTestId('check-every-0')).toHaveAttribute('aria-checked', 'true');
  await page.reload();
  await openSettings(page);
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
  await openSettings(page);
  await expect(page.getByTestId('ipv4-auto')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('screen-settings')).toContainText('Auto switches when IPv6 gets blocked.');
  await page.getByTestId('ipv4-always').click();
  await expect(page.getByTestId('ipv4-always')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('ipv4-auto')).toHaveAttribute('aria-checked', 'false');
  await expect.poll(prefs).toEqual([{ ipv4: 'auto' }, { ipv4: 'always' }]);
  await page.reload();
  await expect.poll(prefs).toEqual([{ ipv4: 'always' }]);
  await openSettings(page);
  await expect(page.getByTestId('ipv4-always')).toHaveAttribute('aria-checked', 'true');
  // No native side, no status line.
  await expect(page.getByTestId('net-status')).toHaveCount(0);
});

test('Audio quality: Auto by default, three choices that say what they do, sent to the player and kept', async ({ page }) => {
  await page.goto('/');
  const sent = async () => (await playerCalls(page)).filter((c) => c[0] === 'setQuality').map((c) => c[1]);
  await expect.poll(sent).toEqual([{ quality: 'auto' }]);
  await openSettings(page);
  const group = page.getByRole('radiogroup', { name: 'Audio quality' });
  await expect(group.getByRole('radio')).toHaveText(['Auto', 'High', 'Low']);
  await expect(page.getByTestId('quality-auto')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('quality-desc')).toHaveText('Best quality the connection can keep up with');
  await page.getByTestId('quality-high').click();
  await expect(page.getByTestId('quality-desc')).toHaveText('Always the best audio');
  await page.getByTestId('quality-low').click();
  await expect(page.getByTestId('quality-low')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('quality-desc')).toHaveText('Uses the least data');
  await expect.poll(sent).toEqual([{ quality: 'auto' }, { quality: 'high' }, { quality: 'low' }]);
  await page.reload();
  await expect.poll(sent).toEqual([{ quality: 'low' }]);
  await openSettings(page);
  await expect(page.getByTestId('quality-low')).toHaveAttribute('aria-checked', 'true');
});

test('Crossfade: Off by default, four choices, sent to the player and kept', async ({ page }) => {
  await page.goto('/');
  const sent = async () => (await playerCalls(page)).filter((c) => c[0] === 'setCrossfade').map((c) => c[1]);
  await expect.poll(sent).toEqual([{ ms: 0 }]);
  await openSettings(page);
  const group = page.getByRole('radiogroup', { name: 'Crossfade' });
  await expect(group.getByRole('radio')).toHaveText(['Off', '3 s', '6 s', '10 s']);
  await expect(group).toHaveAccessibleDescription('Blends the end of a track into the next.');
  await expect(page.getByTestId('crossfade-0')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('crossfade-6000').click();
  await expect(page.getByTestId('crossfade-6000')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('crossfade-0')).toHaveAttribute('aria-checked', 'false');
  // Arrow keys move the choice, as in the other radio groups.
  await page.getByTestId('crossfade-6000').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('crossfade-10000')).toHaveAttribute('aria-checked', 'true');
  await expect.poll(sent).toEqual([{ ms: 0 }, { ms: 6000 }, { ms: 10000 }]);
  await page.reload();
  await expect.poll(sent).toEqual([{ ms: 10000 }]);
  await openSettings(page);
  await expect(page.getByTestId('crossfade-10000')).toHaveAttribute('aria-checked', 'true');
});

test('Gapless playback: on by default, sent to the player, kept when turned off', async ({ page }) => {
  await page.goto('/');
  const sent = async () => (await playerCalls(page)).filter((c) => c[0] === 'setGapless').map((c) => c[1]);
  await expect.poll(sent).toEqual([{ enabled: true }]);
  await openSettings(page);
  const toggle = page.getByTestId('gapless-toggle');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(toggle).toHaveAccessibleDescription(
    'Tracks follow each other without a pause.',
  );
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect.poll(sent).toEqual([{ enabled: true }, { enabled: false }]);
  await page.reload();
  await expect.poll(sent).toEqual([{ enabled: false }]);
  await openSettings(page);
  await expect(page.getByTestId('gapless-toggle')).toHaveAttribute('aria-checked', 'false');
});

test('saved settings without the Gapless key keep it on', async ({ page }) => {
  await seedStorage(page, { [SETTINGS_KEY]: { theme: 'dark', showNsfw: false, quality: 'low', crossfadeMs: 6000, version: 2 } });
  await page.goto('/');
  await openSettings(page);
  await expect(page.getByTestId('gapless-toggle')).toHaveAttribute('aria-checked', 'true');
});

test('a saved unknown crossfade is Off', async ({ page }) => {
  await seedStorage(page, { [SETTINGS_KEY]: { theme: 'dark', crossfadeMs: 4000, version: 2 } });
  await page.goto('/');
  const sent = async () => (await playerCalls(page)).filter((c) => c[0] === 'setCrossfade').map((c) => c[1]);
  await expect.poll(sent).toEqual([{ ms: 0 }]);
  await openSettings(page);
  await expect(page.getByTestId('crossfade-0')).toHaveAttribute('aria-checked', 'true');
});

test('a saved High (the old default) becomes Auto; a saved Low stays', async ({ page }) => {
  await seedStorage(page, { [SETTINGS_KEY]: { theme: 'dark', showNsfw: false, quality: 'high' } });
  await page.goto('/');
  await openSettings(page);
  await expect(page.getByTestId('quality-auto')).toHaveAttribute('aria-checked', 'true');
  await page.evaluate((k) => localStorage.setItem(k, JSON.stringify({ theme: 'dark', showNsfw: false, quality: 'low' })), SETTINGS_KEY);
  await page.reload();
  await openSettings(page);
  await expect(page.getByTestId('quality-low')).toHaveAttribute('aria-checked', 'true');
});

test('an old "Prefer IPv4: on" becomes Always', async ({ page }) => {
  await seedStorage(page, { [SETTINGS_KEY]: { theme: 'dark', preferIpv4: true } });
  await page.goto('/');
  await openSettings(page);
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
  await openSettings(page);
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
  await openSettings(page);
  await expect(page.getByTestId('net-status')).toHaveText('Connection: not used yet · no limits so far');
  await page.getByTestId('tab-home').click();
  await page.evaluate(() => {
    window.__cyberjukeNetStatus = { family: 'IPv6', ipv4: 'auto', autoIpv4: true };
  });
  await openSettings(page);
  await expect(page.getByTestId('net-status')).toHaveText('Connection: IPv4 (switched by Auto) · no limits so far');
});

test('Account is the first card and says "members-only shared tracks"', async ({ page }) => {
  await page.goto('/');
  await openSettings(page);
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
  await openSettings(page);
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
  await openSettings(page);
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

test('Updates: Check now finds a newer release (banner, dot on the Settings button), or says it is up to date, or that it could not check', async ({ page }) => {
  let answer: { status: number; body?: unknown } = { status: 200, body: latest('v99.0.0') };
  await page.route(LATEST, (route) => route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body ?? {}) }));
  await start(page);
  await openSettings(page);
  const card = page.getByTestId('updates');
  // Opt-in: off until turned on, so nothing has asked GitHub.
  await expect(card.getByTestId('updates-auto')).toHaveAttribute('aria-checked', 'false');
  await expect(card).toContainText('Off unless you turn it on');
  await expect(card.getByTestId('updates-status')).toHaveText('Not checked yet.');
  await expect(page.getByTestId('settings-update-dot')).toHaveCount(0);

  await card.getByTestId('updates-check').click();
  await expect(card.getByTestId('updates-status')).toHaveText('CyberJuke 99.0.0 is available.');
  await expect(page.getByTestId('update-banner')).toContainText('CyberJuke 99.0.0 is out');
  await expect(page.getByTestId('update-download')).toBeVisible();
  // The dot is on Home's Settings button.
  await page.getByTestId('settings-back').click();
  await expect(page.getByTestId('settings-update-dot')).toBeVisible();
  await expect(page.getByTestId('open-settings')).toHaveAttribute('aria-label', 'Settings (update available)');
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
  await openSettings(page);
  await page.getByTestId('updates').getByTestId('updates-check').click();
  await expect(page.getByTestId('updates-status')).toHaveText(/^Up to date \(\d+\.\d+\.\d+\)\. Checked \S+ \S+, \d{1,2}:\d{2}( [AP]M)?\.$/);
  await expect(page.getByTestId('update-banner')).toHaveCount(0);
  await expect(page.getByTestId('settings-update-dot')).toHaveCount(0);

  // GitHub unreachable: says so; nothing else changes.
  answer = { status: 503 };
  await page.getByTestId('updates').getByTestId('updates-check').click();
  await expect(page.getByTestId('updates-status')).toHaveText("Couldn't check. Try again later.");
});

test('Updates: the automatic check is off until turned on, and stays as set', async ({ page }) => {
  await start(page);
  await openSettings(page);
  const auto = page.getByTestId('updates-auto');
  await expect(auto).toHaveAttribute('aria-checked', 'false');
  await auto.click();
  await expect(auto).toHaveAttribute('aria-checked', 'true');
  await page.reload();
  await waitForTracks(page);
  await openSettings(page);
  await expect(page.getByTestId('updates-auto')).toHaveAttribute('aria-checked', 'true');
});

test('radio groups and the Library tabs are one Tab stop each, worked with the arrow keys', async ({ page }) => {
  await start(page);
  await openSettings(page);
  await page.getByTestId('quality-auto').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('quality-high')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('quality-high')).toBeFocused();
  await expect(page.getByTestId('quality-auto')).toHaveAttribute('tabindex', '-1');
  await page.getByTestId('ipv4-auto').focus();
  await page.keyboard.press('End');
  await expect(page.locator('[data-testid^="ipv4-"]').last()).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('tab-library').click();
  await page.getByTestId('lib-liked').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('lib-recent')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('lib-recent')).toBeFocused();
});
