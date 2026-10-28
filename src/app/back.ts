/**
 * Android back (predictive back). The page takes back only while it has something to close
 * (canGoBack): it tells native whenever that changes, and native turns its back callback on or
 * off (BackPolicy.kt). While on, back comes here as the `backbutton` document event and closes
 * the topmost thing (goBack). At the root, Android 12 and newer take back themselves: the app
 * goes to the background with the system's back-to-home animation. Older Android still send
 * it here, and the app is moved to the background rather than finished (the music plays on and
 * the page stays loaded). Dev/test builds record what native was told, and each move to the
 * background, as `window.__cyberjukeBack` for e2e, where a test sends the event itself.
 */
import { effect } from '@preact/signals';
import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { logError } from '../core/log';
import { TEST_HOOKS, exposeForTests } from '../core/testHooks';
import { JukePlayer } from '../player/native';
import { canGoBack, goBack } from '../ui/nav';

const calls: (boolean | 'background')[] = [];
exposeForTests('__cyberjukeBack', calls);

export function wireBack(): void {
  const native = Capacitor.isNativePlatform();
  effect(() => {
    const can = canGoBack.value;
    if (TEST_HOOKS) calls.push(can);
    if (native) JukePlayer.setCanGoBack({ canGoBack: can }).catch((e: unknown) => logError('canGoBack', e));
  });
  document.addEventListener('backbutton', () => {
    if (goBack()) return;
    // At the root (older Android, or a back sent before native heard the page got there).
    if (TEST_HOOKS) calls.push('background');
    if (native) CapApp.minimizeApp().catch(() => CapApp.exitApp());
  });
}
