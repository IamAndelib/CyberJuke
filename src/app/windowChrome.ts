/**
 * The Android window around the page follows the theme: the status and navigation bars'
 * icons are light on a dark theme and dark on a light one. Native only; dev/test builds
 * record the calls as `window.__cyberjukeWindowChrome` so e2e can check them on the web.
 */
import { Capacitor, SystemBars, SystemBarsStyle } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';
import { logError } from '../core/log';
import { TEST_HOOKS, exposeForTests } from '../core/testHooks';

const calls: [string, string][] = [];
exposeForTests('__cyberjukeWindowChrome', calls);

/** Light bar icons on a dark theme, dark ones on a light theme: both bars. */
export function styleSystemBars(dark: boolean): void {
  if (TEST_HOOKS) calls.push(['bars', dark ? 'dark' : 'light']);
  if (!Capacitor.isNativePlatform()) return;
  // SystemBars styles both bars and applies the style again after a configuration change
  // (rotation, the system's dark mode). The StatusBar plugin does the same with its own
  // stored style, so it is told too, or it would put the status bar back to the system's.
  SystemBars.setStyle({ style: dark ? SystemBarsStyle.Dark : SystemBarsStyle.Light }).catch((e: unknown) => logError('systemBars', e));
  StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light }).catch((e: unknown) => logError('statusBar', e));
}
