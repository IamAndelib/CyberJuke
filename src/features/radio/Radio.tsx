import { computed } from '@preact/signals';
import { isPlaying, player, playContext } from '../../player';
import { BAND_NAMES, STATIONS, stationFreq, stationLabel, stationQueue, stationTracks, type Band, type Station } from '../../player/radio';
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

/** Every station track, for Here on this tab. */
const ALL_TRACKS = STATIONS.flatMap((s) => stationTracks(s));
const allTracks = () => ALL_TRACKS;

/**
 * Tune in: a fresh round of the station, then the next ones (player/radio). The station that's
 * on already opens Now Playing instead (and plays, if paused), so a tap doesn't restart it.
 */
function tuneIn(s: Station): void {
  if (onAir.peek() === s) {
    if (!isPlaying.peek()) void player.play();
    nowPlayingOpen.value = true;
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
  return (
    <li class={'row station' + (on ? ' is-current' : '')} data-testid="station" data-station={s.id} aria-current={on || undefined}>
      <button
        class="row-main"
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
    <Screen testid="screen-radio" title="Signal Radio" subtitle="16 stations by hyphen8d" scrollKey="radio">
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
      <p class="fineprint">Each station plays all its tracks in a shuffle, then another. The stations are hyphen8d's SIGNAL, as Cyberspace's Jukebox plays them.</p>
    </Screen>
  );
}
