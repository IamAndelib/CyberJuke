/**
 * The one place that picks the TrackSource implementation.
 * Swap FirestoreSource for an official-API source here.
 */
import { FirestoreSource } from './firestore';
export { shuffled } from './firestore';
import type { TrackSource } from './source';
import { showNsfw } from '../store/library';
import { auth } from './auth';

export const source: TrackSource = new FirestoreSource({ showNsfw: () => showNsfw.value, auth });

export type { Track } from './model';
export type { Cursor, Page, TrackSource } from './source';
