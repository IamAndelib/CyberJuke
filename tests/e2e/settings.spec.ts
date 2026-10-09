import { expect, test } from '../fixtures';
import { cssVar, playerCalls, seedStorage, SETTINGS_KEY } from '../helpers';

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
    (window as unknown as { __cyberjukeNetStatus: unknown }).__cyberjukeNetStatus = {
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

test('Account is the first card and says "members-only shared tracks"', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-settings').click();
  const settings = page.getByTestId('screen-settings');
  await expect(settings.locator('.card-title')).toHaveText(['Account', 'Theme', 'Playback & data', 'About', 'Licenses', 'Source code']);
  const account = page.getByTestId('account');
  expect((await account.boundingBox())!.y).toBeLessThan((await page.getByTestId('theme-picker').boundingBox())!.y);
  await expect(account.locator('.signin-lead')).toHaveText('Optional. Signed in, the Jukebox also shows members-only shared tracks, marked [members].');
  await expect(settings).not.toContainText('members-only posts');
  await expect(page.getByTestId('about')).toContainText('Signing in adds members-only tracks.');
});

test('Source code: the last card links to the repository and its latest release', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __opened: string[] };
    w.__opened = [];
    window.open = ((url: string) => {
      w.__opened.push(String(url));
      return null;
    }) as typeof window.open;
  });
  await page.goto('/');
  await page.getByTestId('tab-settings').click();
  const card = page.getByTestId('source-code');
  await card.scrollIntoViewIfNeeded();
  // The very last card on the page.
  expect(await page.getByTestId('screen-settings').locator('section.card').last().getAttribute('data-testid')).toBe('source-code');
  await card.getByTestId('source-repo').getByRole('link').click();
  await card.getByTestId('source-releases').getByRole('link').click();
  const opened = await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
  expect(opened).toEqual(['https://github.com/IamAndelib/CyberJuke', 'https://github.com/IamAndelib/CyberJuke/releases/latest']);
});
