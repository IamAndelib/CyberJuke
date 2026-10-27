/**
 * The Android window around the page (MainActivity) follows the theme: the status and
 * navigation bars' icons are light on a dark theme and dark on a light one, and the theme's
 * background is kept natively, so the next start opens in it (not black on a light theme).
 * The launch splash stays until the first screen has rendered. Native only; dev/test builds
 * record the calls as `window.__cyberjukeWindowChrome` so e2e can check them on the web.
 */
import { Capacitor, SystemBars, SystemBarsStyle } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';
import { logError } from '../core/log';
import { TEST_HOOKS, exposeForTests } from '../core/testHooks';
import { JukePlayer } from '../player/native';

const calls: [string, string][] = [];
exposeForTests('__cyberjukeWindowChrome', calls);

const native = Capacitor.isNativePlatform();

/** Light bar icons on a dark theme, dark ones on a light theme: both bars. */
export function styleSystemBars(dark: boolean): void {
  if (TEST_HOOKS) calls.push(['bars', dark ? 'dark' : 'light']);
  if (!native) return;
  // SystemBars styles both bars and applies the style again after a configuration change
  // (rotation, the system's dark mode). The StatusBar plugin does the same with its own
  // stored style, so it is told too, or it would put the status bar back to the system's.
  SystemBars.setStyle({ style: dark ? SystemBarsStyle.Dark : SystemBarsStyle.Light }).catch((e: unknown) => logError('systemBars', e));
  StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light }).catch((e: unknown) => logError('statusBar', e));
}

/** The theme's background (its `--color-bg`, `#rgb` or `#rrggbb`), for the window natively. */
export function keepThemeBackground(color: string): void {
  if (TEST_HOOKS) calls.push(['background', color]);
  if (!native) return;
  JukePlayer.setThemeBackground({ color }).catch((e: unknown) => logError('themeBackground', e));
}

/** The first screen (or the start's error screen) has rendered: the launch splash may go. */
export function firstScreenShown(): void {
  if (TEST_HOOKS) calls.push(['firstScreen', '']);
  if (!native) return;
  JukePlayer.firstScreenShown().catch((e: unknown) => logError('firstScreen', e));
}
