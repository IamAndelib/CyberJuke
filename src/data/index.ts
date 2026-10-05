/**
 * The one place that picks the TrackSource implementation.
 * Swap FirestoreSource for an official-API source here.
 */
import { FirestoreSource } from './firestore';
import type { TrackSource } from './source';
import { settings } from '../store/library';

export const source: TrackSource = new FirestoreSource({ showNsfw: () => settings.value.showNsfw });

export type { Track } from './model';
export type { Cursor, Page, TrackSource } from './source';
