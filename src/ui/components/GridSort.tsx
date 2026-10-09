import type { Signal } from '@preact/signals';
import type { ComponentChild } from 'preact';
import { useMemo } from 'preact/hooks';
import type { GridSort } from '../../stores/prefs';
import { groupAZ } from '../azSections';
import { takeSections, useChunks } from '../useChunks';
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

/** Grid tiles per chunk: the first screens render at once, the rest in idle time. */
const GRID_CHUNK = 120;

/** Every genre or artist as tiles, Popular (the list's order) or A–Z, rendered in chunks. */
export function TileGrid<T>(props: {
  list: T[];
  sort: GridSort;
  nameOf: (item: T) => string;
  /** One tile, keyed. */
  tile: (item: T) => ComponentChild;
  testid: string;
  /** Its chunk progress, kept per sort (useChunks). */
  chunkKey: string;
}) {
  const { list, sort, nameOf, tile, testid, chunkKey } = props;
  const sections = useMemo(() => (sort === 'az' ? groupAZ(list, nameOf) : null), [list, sort, nameOf]);
  const { shown } = useChunks(list.length, `${chunkKey}:${sort}`, GRID_CHUNK, { fill: true });
  if (sections) {
    return (
      <div data-testid={testid} data-sort="az">
        {takeSections(sections, shown).map((sec) => (
          <section class="az-section" key={sec.letter} data-testid="az-section" data-letter={sec.letter}>
            <AZHead letter={sec.letter} />
            <div class="genre-grid">
              {sec.items.map(tile)}
            </div>
          </section>
        ))}
      </div>
    );
  }
  return (
    <div class="genre-grid" data-testid={testid} data-sort="popular">
      {list.slice(0, shown).map(tile)}
    </div>
  );
}

/** The grid's placeholder while the catalog loads. */
export function TileSkeleton({ testid }: { testid: string }) {
  return (
    <div class="genre-grid" aria-hidden="true" data-testid={testid}>
      {Array.from({ length: 10 }, (_, i) => (
        <div class="genre-tile skel-block" key={i} />
      ))}
    </div>
  );
}
