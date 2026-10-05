import { THEME_LABELS, THEMES, settings, updateSettings, type ThemeId } from '../../store/library';
import { Screen } from '../components/Screen';
import { openPost } from '../nav';

function Swatch({ id }: { id: ThemeId }) {
  const on = settings.value.theme === id;
  return (
    <button
      class={'swatch' + (on ? ' on' : '')}
      aria-pressed={on}
      aria-label={`${THEME_LABELS[id]} theme`}
      onClick={() => updateSettings({ theme: id })}
      data-testid={`theme-${id}`}
    >
      <span class="swatch-preview" data-theme={id} aria-hidden="true">
        <span class="swatch-art" />
        <span class="swatch-lines">
          <span class="l1" />
          <span class="l2" />
        </span>
      </span>
      <span class="swatch-name">{THEME_LABELS[id]}</span>
    </button>
  );
}

function Toggle({ on, onChange, label, testid }: { on: boolean; onChange: (v: boolean) => void; label: string; testid: string }) {
  return (
    <button class={'toggle' + (on ? ' on' : '')} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} data-testid={testid}>
      <span class="toggle-opt off">OFF</span>
      <span class="toggle-opt on">ON</span>
    </button>
  );
}

function A({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        openPost(href);
      }}
    >
      {children}
    </a>
  );
}

export function Settings() {
  const s = settings.value;
  return (
    <Screen testid="screen-settings" title="Settings" subtitle={`CyberJuke v${__APP_VERSION__}`}>
      <section class="card">
        <h2 class="card-title">Theme</h2>
        <div class="swatches" data-testid="theme-picker">
          {THEMES.map((id) => (
            <Swatch key={id} id={id} />
          ))}
        </div>
      </section>

      <section class="card">
        <h2 class="card-title">Playback</h2>
        <div class="setting">
          <div class="setting-text">
            <div class="setting-name">Show NSFW tracks</div>
            <div class="setting-desc">Posts marked NSFW on Cyberspace are hidden by default.</div>
          </div>
          <Toggle on={s.showNsfw} onChange={(v) => updateSettings({ showNsfw: v })} label="Show NSFW tracks" testid="nsfw-toggle" />
        </div>
        <div class="setting">
          <div class="setting-text">
            <div class="setting-name">Audio quality</div>
            <div class="setting-desc">Low uses less mobile data.</div>
          </div>
          <div class="segmented small" role="radiogroup" aria-label="Audio quality">
            {(['high', 'low'] as const).map((q) => (
              <button
                key={q}
                role="radio"
                aria-checked={s.quality === q}
                class={s.quality === q ? 'on' : ''}
                onClick={() => updateSettings({ quality: q })}
                data-testid={`quality-${q}`}
              >
                {q === 'high' ? 'High' : 'Low'}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section class="card prose" data-testid="about">
        <h2 class="card-title">About</h2>
        <p>
          <b>CyberJuke</b> v{__APP_VERSION__} is an <b>unofficial</b> player for the{' '}
          <A href="https://beta.cyberspace.online/jukebox">Cyberspace Jukebox</A>. It is not made or endorsed by
          Cyberspace.
        </p>
        <p>
          <b>Data:</b> public posts with music attachments, read from Cyberspace's public database exactly as the
          website shows them. Nothing is posted and no account is needed.
        </p>
        <p>
          <b>Audio:</b> tracks are YouTube videos linked by posters. CyberJuke streams them from YouTube; availability
          depends on YouTube, and some tracks may be skipped.
        </p>
        <p>
          <b>Credits:</b> Cyberspace and its creator <A href="https://beta.cyberspace.online/genghis_khan">@genghis_khan</A>
          {' '}for the Jukebox and the look this app borrows; every poster who shares music; and{' '}
          <A href="https://github.com/TeamNewPipe/NewPipeExtractor">NewPipeExtractor</A> (GPL-3.0), which powers
          playback on Android.
        </p>
      </section>

      <section class="card prose" data-testid="licenses">
        <h2 class="card-title">Licenses</h2>
        <details>
          <summary>CyberJuke: GPL-3.0</summary>
          <p>
            Copyright © 2026 IamAndelib. This program is free software: you can redistribute it and/or modify it under
            the terms of the GNU General Public License, version 3, as published by the Free Software Foundation. It
            is distributed WITHOUT ANY WARRANTY. See <A href="https://www.gnu.org/licenses/gpl-3.0.html">gnu.org/licenses/gpl-3.0</A>.
          </p>
        </details>
        <details>
          <summary>Fonts: SIL Open Font License 1.1</summary>
          <p>
            <b>JetBrains Mono</b>, Copyright 2020 The JetBrains Mono Project Authors.
            <br />
            <b>Departure Mono</b>, Copyright 2022–2024 Helena Zhang.
            <br />
            Both are used under the SIL Open Font License 1.1; full text in <code>fonts/OFL.txt</code> and at{' '}
            <A href="https://openfontlicense.org">openfontlicense.org</A>.
          </p>
        </details>
        <details>
          <summary>Libraries</summary>
          <p>Preact (MIT), @preact/signals (MIT), Capacitor (MIT), NewPipeExtractor (GPL-3.0).</p>
        </details>
      </section>
    </Screen>
  );
}
