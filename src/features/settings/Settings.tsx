import {
  CHECK_EVERY_LABELS,
  CHECK_EVERY_OPTIONS,
  THEME_LABELS,
  THEMES,
  settings,
  updateSettings,
  type ThemeId,
} from '../../stores/library';
import { useState } from 'preact/hooks';
import { AuthError, SIGN_UP_URL, auth, authErrorText } from '../../data/auth';
import { toast } from '../../stores/toast';
import { Screen } from '../../ui/components/Screen';
import { openExternal } from '../../ui/links';
import { askConfirm } from '../../ui/nav';

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

/** Where the code and the releases are (opened in the browser; github.com is allowlisted). */
const REPO_URL = 'https://github.com/IamAndelib/CyberJuke';

function A({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        openExternal(href);
      }}
    >
      {children}
    </a>
  );
}

/** "Check for new tracks": how often Home asks whether anything new was posted. */
function CheckEvery() {
  const cur = settings.value.checkEvery;
  const onKey = (e: KeyboardEvent) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const i = CHECK_EVERY_OPTIONS.indexOf(cur);
    const next = CHECK_EVERY_OPTIONS[(i + d + CHECK_EVERY_OPTIONS.length) % CHECK_EVERY_OPTIONS.length];
    updateSettings({ checkEvery: next });
    (e.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-value="${next}"]`)?.focus();
  };
  return (
    <div class="setting stack">
      <div class="setting-text">
        <div class="setting-name" id="check-every-label">
          Check for new tracks
        </div>
        <div class="setting-desc">Shows a button on Home when new tracks are posted.</div>
      </div>
      <div class="seg-grid" role="radiogroup" aria-labelledby="check-every-label" onKeyDown={onKey} data-testid="check-every">
        {CHECK_EVERY_OPTIONS.map((v) => (
          <button
            key={v}
            role="radio"
            aria-checked={cur === v}
            tabIndex={cur === v ? 0 : -1}
            class={(cur === v ? 'on' : '') + (v === 0 ? ' wide' : '')}
            onClick={() => updateSettings({ checkEvery: v })}
            data-value={v}
            data-testid={`check-every-${v}`}
          >
            {CHECK_EVERY_LABELS[v]}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Settings → Account, signed out: "Sign in with Cyberspace". The password is never kept. */
function SignInForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const user = await auth.signIn(email, password);
      setPassword('');
      toast(
        user.saved
          ? `Signed in as ${user.name}`
          : `Signed in as ${user.name} for this session only: the login couldn't be saved on this phone`,
        user.saved ? 2400 : 5000,
      );
    } catch (err) {
      setError(err instanceof AuthError ? err.message : authErrorText('UNKNOWN'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="signin" onSubmit={submit} noValidate data-testid="signin-form">
      <div class="setting-name">Sign in with Cyberspace</div>
      <p class="setting-desc signin-lead">
        Optional. Signed in, the Jukebox also shows members-only shared tracks, marked <span class="mtag">[members]</span>.
      </p>
      <div class="field">
        <label class="field-label" for="signin-email">
          Email
        </label>
        <input
          id="signin-email"
          class="field-input"
          type="email"
          name="email"
          autocomplete="username"
          inputMode="email"
          autocapitalize="off"
          spellcheck={false}
          value={email}
          onInput={(e) => setEmail((e.currentTarget as HTMLInputElement).value)}
          disabled={busy}
          data-testid="signin-email"
        />
      </div>
      <div class="field">
        <label class="field-label" for="signin-password">
          Password
        </label>
        <span class="field-row">
          <input
            id="signin-password"
            class="field-input"
            // "text" while [show] is on; typed as one variant for Preact's input unions.
            type={(show ? 'text' : 'password') as 'password'}
            name="password"
            autocomplete="current-password"
            autocapitalize="off"
            spellcheck={false}
            value={password}
            onInput={(e) => setPassword((e.currentTarget as HTMLInputElement).value)}
            disabled={busy}
            data-testid="signin-password"
          />
          <button
            type="button"
            class="field-reveal"
            aria-pressed={show}
            aria-label={show ? 'Hide password' : 'Show password'}
            onClick={() => setShow(!show)}
            data-testid="signin-reveal"
          >
            {show ? '[hide]' : '[show]'}
          </button>
        </span>
      </div>
      {error && (
        <p class="signin-error" role="alert" data-testid="signin-error">
          ! {error}
        </p>
      )}
      <button type="submit" class="btn primary signin-submit" disabled={busy} aria-busy={busy} data-testid="signin-submit">
        {busy ? <span class="spinner" aria-hidden="true" /> : null}
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      <p class="setting-desc signin-note" data-testid="signin-note">
        Your password goes only to Cyberspace.
      </p>
      <p class="setting-desc signin-note">
        No account? <A href={SIGN_UP_URL}>Create one on cyberspace.online</A>
      </p>
    </form>
  );
}

/** Settings → Account, signed in. Signing out asks first (M3). */
function SignedIn({ name }: { name: string }) {
  const [busy, setBusy] = useState(false);
  const signOut = async () => {
    setBusy(true);
    try {
      await auth.signOut();
      toast('Signed out of Cyberspace', 2000);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="setting stack account-in" data-testid="signed-in">
      <div class="setting-text">
        <div class="setting-name">
          Signed in as <span data-testid="account-name">{name}</span>
        </div>
        <div class="setting-desc">
          Members-only tracks are marked <span class="mtag">[members]</span>.
        </div>
      </div>
      <button
        class="btn"
        disabled={busy}
        onClick={() =>
          askConfirm({
            title: 'Sign out of Cyberspace?',
            body: 'Members-only tracks will be hidden.',
            confirm: 'Sign out',
            run: signOut,
            testid: 'confirm-signout',
          })
        }
        data-testid="signout"
      >
        Sign out
      </button>
    </div>
  );
}

function Account() {
  const st = auth.state.value;
  return (
    <section class="card" data-testid="account">
      <h2 class="card-title">Account</h2>
      {st.status === 'signedIn' && st.user ? <SignedIn name={st.user.name} /> : <SignInForm />}
    </section>
  );
}

export function Settings() {
  const s = settings.value;
  return (
    <Screen testid="screen-settings" title="Settings" subtitle={`CyberJuke v${__APP_VERSION__}`} scrollKey="settings" backToTop={false}>
      <Account />

      <section class="card">
        <h2 class="card-title">Theme</h2>
        <div class="swatches" data-testid="theme-picker">
          {THEMES.map((id) => (
            <Swatch key={id} id={id} />
          ))}
        </div>
      </section>

      <section class="card">
        <h2 class="card-title">Playback &amp; data</h2>
        <div class="setting">
          <div class="setting-text">
            <div class="setting-name">Show NSFW tracks</div>
            <div class="setting-desc">Hidden by default.</div>
          </div>
          <Toggle on={s.showNsfw} onChange={(v) => updateSettings({ showNsfw: v })} label="Show NSFW tracks" testid="nsfw-toggle" />
        </div>
        <div class="setting">
          <div class="setting-text">
            <div class="setting-name">Audio quality</div>
            <div class="setting-desc">Low saves data.</div>
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
        <div class="setting">
          <div class="setting-text">
            <div class="setting-name">Prefer IPv4</div>
            <div class="setting-desc">Try this if playback is blocked.</div>
          </div>
          <Toggle on={s.preferIpv4} onChange={(v) => updateSettings({ preferIpv4: v })} label="Prefer IPv4" testid="ipv4-toggle" />
        </div>
        <div class="setting">
          <div class="setting-text">
            <div class="setting-name">Autoplay</div>
            <div class="setting-desc">Plays similar songs when your list ends.</div>
          </div>
          <Toggle on={s.autoplay} onChange={(v) => updateSettings({ autoplay: v })} label="Autoplay" testid="autoplay-toggle" />
        </div>
        <CheckEvery />
      </section>

      <section class="card prose" data-testid="about">
        <h2 class="card-title">About</h2>
        <p>
          <b>CyberJuke</b> v{__APP_VERSION__} is an <b>unofficial</b> player for the{' '}
          <A href="https://beta.cyberspace.online/jukebox">Cyberspace Jukebox</A>, not made or endorsed by Cyberspace.
        </p>
        <p>
          <b>Data:</b> public posts with music, read as the site shows them. Nothing is posted. Signing in adds
          members-only tracks.
        </p>
        <p>
          <b>Audio:</b> streamed from where each poster linked it, so some tracks may be skipped.
        </p>
        <p>
          <b>Global:</b> Global search and artist pages look beyond the Jukebox. What they find is never added to it.
        </p>
        <p>
          <b>Credits:</b> Cyberspace and <A href="https://beta.cyberspace.online/genghis_khan">@genghis_khan</A> for the
          Jukebox and its look; everyone who shares music; and{' '}
          <A href="https://github.com/TeamNewPipe/NewPipeExtractor">NewPipeExtractor</A> (GPL-3.0) for playback and
          Global search.
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

      <section class="card prose" data-testid="source-code">
        <h2 class="card-title">Source code</h2>
        <p>CyberJuke is free software. The code, issues and every release are on GitHub:</p>
        <p data-testid="source-repo">
          <A href={REPO_URL}>github.com/IamAndelib/CyberJuke</A>
        </p>
        <p data-testid="source-releases">
          <A href={`${REPO_URL}/releases/latest`}>Latest release</A>
        </p>
      </section>
    </Screen>
  );
}
