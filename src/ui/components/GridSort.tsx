import type { Signal } from '@preact/signals';
import type { GridSort } from '../../stores/prefs';
import { Rail, type RailItem } from './Rail';

const SORTS: RailItem<GridSort>[] = [
  { id: 'popular', label: 'Popular', testid: 'grid-sort-popular' },
  { id: 'az', label: 'A–Z', testid: 'grid-sort-az' },
];

/** POPULAR | A–Z in a top bar's right slot; the underline sits on the header rule. */
export function GridSortRail({ sort, testid }: { sort: Signal<GridSort>; testid: string }) {
  return (
    <div class="rail-slot">
      <Rail items={SORTS} value={sort.value} onChange={(v) => (sort.value = v)} label="Order" testid={testid} />
    </div>
  );
}

/** Letter + rule heading one A–Z section (read by the fast scroller's letter popup). */
export function AZHead({ letter }: { letter: string }) {
  return (
    <div class="az-head" data-testid="az-head" data-letter={letter}>
      <span class="az-letter">{letter}</span>
      <span class="az-rule" aria-hidden="true" />
    </div>
  );
}
