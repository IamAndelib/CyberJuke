import './styles/fonts.css';
import './styles/themes.css';
import './styles/app.css';
import { render } from 'preact';
import { effect } from '@preact/signals';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { StatusBar, Style } from '@capacitor/status-bar';
import { loadLibrary, settings } from './store/library';
import { watchNetwork } from './store/network';
import { goBack } from './ui/nav';
import { JukePlayer } from './player/native';
import { player } from './player';
import { source } from './data';
import { App, Overlays } from './ui/App';

const native = Capacitor.isNativePlatform();

function applyTheme(): void {
  effect(() => {
    const theme = settings.value.theme;
    const root = document.documentElement;
    root.dataset.theme = theme;
    const cs = getComputedStyle(root);
    const bg = cs.getPropertyValue('--color-bg').trim();
    const dark = cs.getPropertyValue('--scheme').trim() !== 'light';
    root.style.colorScheme = dark ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
    if (native) {
      StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light }).catch(() => {});
    }
  });
}

function wireBackButton(): void {
  if (!native) return;
  CapApp.addListener('backButton', () => {
    if (!goBack()) {
      // Keep music playing: background the app instead of finishing the activity.
      CapApp.minimizeApp().catch(() => CapApp.exitApp());
    }
  }).catch(() => {});
}

/** CI smoke-test hook: start playing the newest track on launch. */
async function maybeAutoplay(): Promise<void> {
  let want: string | undefined;
  if (native) {
    want = (await JukePlayer.getLaunchOptions().catch(() => ({}) as { autoplay?: 'latest' })).autoplay;
  } else {
    want = new URLSearchParams(location.search).get('autoplay') ?? undefined;
  }
  if (want !== 'latest') return;
  const page = await source.latest();
  if (page.tracks.length) await player.playList(page.tracks, 0);
}

async function boot(): Promise<void> {
  await loadLibrary().catch(() => {});
  applyTheme();
  watchNetwork();
  wireBackButton();
  const root = document.getElementById('app')!;
  render(
    <>
      <App />
      <Overlays />
    </>,
    root,
  );
  maybeAutoplay().catch((e) => console.warn('autoplay failed', e));
}

void boot();
