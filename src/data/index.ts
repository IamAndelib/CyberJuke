/**
 * The one place that picks the TrackSource implementation.
 * Swap FirestoreSource for an official-API source here.
 */
import { FirestoreSource } from './firestore';
import type { TrackSource } from './source';
import { showNsfw } from '../stores/library';
import { TEST_HOOKS } from '../core/testHooks';
import { auth } from './auth';

declare global {
  interface Window {
    /** e2e: a shorter request timeout (ms), set before the app loads. */
    __cyberjukeRequestTimeoutMs?: number;
  }
}

const testTimeout = TEST_HOOKS && typeof window !== 'undefined' ? window.__cyberjukeRequestTimeoutMs : undefined;

export const source: TrackSource = new FirestoreSource({ showNsfw: () => showNsfw.value, auth, ...(testTimeout && { timeoutMs: testTimeout }) });
