import { computed } from '@preact/signals';
import { online } from '../../core/network';
import { currentPlaysOffline, isPlaying, player, playContext } from '../../player';
import { BAND_NAMES, STATIONS, stationFreq, stationLabel, stationQueue, stationTracks, type Band, type Station } from '../../player/radio';
import type { Track } from '../../data/model';
import { Icon } from '../../ui/icons';
import { Screen } from '../../ui/components/Screen';
import { askConfirm, nowPlayingOpen, useSearchContext } from '../../ui/nav';
import { list, playFrom } from '../../ui/playAll';
import { plural } from '../../core/text';

const BANDS: readonly Band[] = ['ym', 'zm'];

/** The station playing now (the list was started from it), or null. */
const onAir = computed<Station | null>(() => {
  const label = playContext.value?.label;
  return label ? (STATIONS.find((s) => stationLabel(s) === label) ?? null) : null;
});

/** Every station track, for Here on this tab: built the first time Search asks. */
let allStationTracks: Track[] | null = null;
const allTracks = () => (allStationTracks ??= STATIONS.flatMap((s) => stationTracks(s)));

/**
 * Tune in: a fresh round of the station, then the next ones (player/radio). The station that's
 * on already doesn't restart: playing, Now Playing opens; paused, it plays (as a track row does,
 * so offline a refused play opens nothing).
 */
function tuneIn(s: Station): void {
  if (onAir.peek() === s) {
    if (isPlaying.peek()) nowPlayingOpen.value = true;
    else void player.play();
    return;
  }
  void playFrom(stationQueue(s), 0, list(stationLabel(s)));
}

function showInfo(s: Station): void {
  askConfirm({
    title: `${s.callsign} · ${stationFreq(s)}`,
    body: `${plural(s.tracks.length, 'track')} · ${s.desc}`,
    confirm: onAir.peek() === s ? 'Open Now Playing' : `Tune in to ${s.callsign}`,
    run: () => tuneIn(s),
  });
}

function StationRow({ s, on }: { s: Station; on: boolean }) {
  const freq = stationFreq(s);
  // Offline, as a track row (TrackRow): a station needs the network, so it dims; only the one on
  // air stays bright while its track still plays. A tap on a dimmed one is refused with the
  // reason; ⓘ still opens.
  const off = !online.value && !(on && currentPlaysOffline.value);
  return (
    <li class={'row station' + (on ? ' is-current' : '') + (off ? ' off' : '')} data-testid="station" data-station={s.id} aria-current={on || undefined}>
      <button
        class="row-main"
        aria-disabled={off || undefined}
        onClick={() => tuneIn(s)}
        aria-label={on ? `${s.callsign}, ${freq}, on air: open Now Playing` : `Tune in to ${s.callsign}, ${freq}`}
        data-testid="station-tune"
      >
        <span class="station-freq" aria-hidden="true">
          {freq}
        </span>
        <div class="row-text">
          <div class="row-title" data-testid="station-callsign">
            {s.callsign}
          </div>
          <div class="row-artist">{s.tagline}</div>
        </div>
        {on && (
          <span class="station-on" data-testid="station-on">
            <Icon name="radio" size={20} />
          </span>
        )}
      </button>
      <button class="icon-btn row-more" aria-label={`About ${s.callsign}`} aria-haspopup="dialog" onClick={() => showInfo(s)} data-testid="station-info">
        <Icon name="info" />
      </button>
    </li>
  );
}

/** The Radio tab: Signal Radio's stations, by band and frequency. */
export function Radio() {
  useSearchContext({ label: 'Signal Radio', tracks: allTracks });
  const on = onAir.value;
  return (
    <Screen testid="screen-radio" title="Signal Radio" subtitle="by hyphen8d" scrollKey="radio">
      {BANDS.map((b) => {
        const stations = STATIONS.filter((s) => s.band === b);
        return (
          <section key={b} data-testid={`band-${b}`} aria-labelledby={`band-${b}-title`}>
            <div class="section-head">
              <h2 class="section-title" id={`band-${b}-title`}>
                {BAND_NAMES[b]}
              </h2>
              <span class="dim small">{plural(stations.length, 'station')}</span>
            </div>
            <ul class="list">
              {stations.map((s) => (
                <StationRow key={s.id} s={s} on={s === on} />
              ))}
            </ul>
          </section>
        );
      })}
    </Screen>
  );
}
