/**
 * Wires the native YouTube-resilience events (Y1) to the block store. In the browser
 * there is no native side: dev/test builds expose `window.__cyberjukeBlock` so the
 * e2e suite can drive the same states.
 */
import { Capacitor } from '@capacitor/core';
import { logError } from '../core/log';
import { exposeForTests } from '../core/testHooks';
import { block, type BlockStore } from '../stores/block';
import { JukePlayer } from './native';

export function startBlockEvents(store: BlockStore = block): void {
  if (!Capacitor.isNativePlatform()) {
    exposeForTests('__cyberjukeBlock', {
      blocked: (e: { until: number; reason?: string }) => store.onBlocked(e as never),
      unblocked: () => store.onUnblocked(),
      extractorBroken: (e: { message: string }) => store.onExtractorBroken(e),
    });
    return;
  }
  const fail = (e: unknown) => logError('blockEvents', e);
  JukePlayer.addListener('blocked', (e) => store.onBlocked(e)).catch(fail);
  JukePlayer.addListener('unblocked', () => store.onUnblocked()).catch(fail);
  JukePlayer.addListener('extractorBroken', (e) => store.onExtractorBroken(e)).catch(fail);
  JukePlayer.getBlockState()
    .then((s) => {
      if (s && Number(s.until) > 0) store.onBlocked({ until: Number(s.until), reason: s.reason as never });
    })
    .catch(fail);
}
