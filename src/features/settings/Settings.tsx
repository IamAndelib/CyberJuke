import {
  CHECK_EVERY_LABELS,
  CHECK_EVERY_OPTIONS,
  THEME_LABELS,
  IPV4_MODES,
  THEMES,
  settings,
  updateSettings,
  type Ipv4Mode,
  type ThemeId,
} from '../../stores/library';
import { useEffect, useState } from 'preact/hooks';
import { player } from '../../player';
import { block, netStatusText } from '../../stores/block';
import { AuthError, SIGN_UP_URL, auth, authErrorText } from '../../data/auth';
import { toast } from '../../stores/toast';
import { app, checkFailed, checkForUpdates, checking, lastCheck, updateAvailable } from '../../stores/updates';
import { Screen } from '../../ui/components/Screen';
import { openExternal } from '../../ui/links';
import { askConfirm, usePageActive } from '../../ui/nav';

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

/** The full third-party license texts, bundled with the app; loaded when opened. */
function LicenseTexts() {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const load = (open: boolean) => {
    if (!open || text != null) return;
    setFailed(false);
    fetch('./licenses/THIRD-PARTY.txt')
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setText)
      .catch(() => setFailed(true));
  };
  return (
    <details onToggle={(e) => load((e.currentTarget as HTMLDetailsElement).open)} data-testid="license-texts">
      <summary>Full license texts</summary>
      {text != null ? (
        <pre class="license-text">{text}</pre>
      ) : failed ? (
        <p>Couldn't open them. They are also in the source repository.</p>
      ) : (
        <p class="dim">Loading…</p>
      )}
    </details>
  );
}

const IPV4_LABELS: Record<Ipv4Mode, string> = { auto: 'Auto', always: 'Always', off: 'Off' };

/** How the app reaches YouTube, for bug reports ("Tracks stopped playing" asks for it). */
function NetStatusLine() {
  const [text, setText] = useState<string | null>(null);
  const ipv4 = settings.value.ipv4;
  const blocked = block.blocked.value;
  // Tabs stay mounted: ask again each time Settings comes back into view (Auto may have
  // switched meanwhile, without a block).
  const active = usePageActive();
  useEffect(() => {
    if (!active) return;
    let live = true;
    void player.netStatus().then((s) => {
      if (live) setText(netStatusText(s, Date.now()));
    });
    return () => {
      live = false;
    };
  }, [ipv4, blocked, active]);
  if (!text) return null;
  return (
    <p class="setting-desc net-status" data-testid="net-status">
      {text}
    </p>
  );
}

/** "Checked 9 Oct, 14:02": a date and time, which stay true however long the card shows. */
function checkedText(at: number): string {
  const d = new Date(at);
  return `Checked ${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

/** A newer release is out: at the top of Settings (the Settings tab shows a dot meanwhile). */
function UpdateBanner() {
  const r = updateAvailable.value;
  if (!r) return null;
  return (
    <section class="card update-banner" role="status" data-testid="update-banner">
      <div class="setting">
        <div class="setting-text">
          <div class="setting-name">CyberJuke {r.version} is out</div>
          <div class="setting-desc">You have {app.value.version}. Download and install it to update.</div>
        </div>
        <button class="btn primary" onClick={() => openExternal(r.url)} data-testid="update-download">
          Download
        </button>
      </div>
    </section>
  );
}

/** Settings → Updates: check by itself (daily at most), or now. F-Droid installs: F-Droid's job. */
function Updates() {
  const a = app.value;
  const s = settings.value;
  if (a.fdroid) {
    return (
      <section class="card" data-testid="updates">
        <h2 class="card-title">Updates</h2>
        <p class="setting-desc" data-testid="updates-fdroid">
          Installed from F-Droid: updates come through F-Droid.
        </p>
      </section>
    );
  }
  const r = updateAvailable.value;
  const last = lastCheck.value;
  const status = checking.value
    ? 'Checking…'
    : checkFailed.value
      ? "Couldn't check. Try again later."
      : r
        ? `CyberJuke ${r.version} is available.`
        : last.checkedAt
          ? `Up to date (${a.version}). ${checkedText(last.checkedAt)}.`
          : 'Not checked yet.';
  return (
    <section class="card" data-testid="updates">
      <h2 class="card-title">Updates</h2>
      <div class="setting">
        <div class="setting-text">
          <div class="setting-name">Check for updates automatically</div>
        </div>
        <Toggle on={s.checkUpdates} onChange={(v) => updateSettings({ checkUpdates: v })} label="Check for updates automatically" testid="updates-auto" />
      </div>
      <div class="setting">
        <div class="setting-text">
          <div class="setting-desc" aria-live="polite" data-testid="updates-status">
            {status}
          </div>
        </div>
        {r ? (
          <button class="btn primary" onClick={() => openExternal(r.url)} data-testid="updates-download">
            Download
          </button>
        ) : (
          <button class="btn" disabled={checking.value || a.fdroid !== false} onClick={() => void checkForUpdates()} data-testid="updates-check">
            Check now
          </button>
        )}
      </div>
    </section>
  );
}

export function Settings() {
  const s = settings.value;
  return (
    <Screen testid="screen-settings" title="Settings" subtitle={`CyberJuke v${__APP_VERSION__}`} scrollKey="settings" backToTop={false}>
      <UpdateBanner />
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
        <div class="setting stack">
          <div class="setting-text">
            <div class="setting-name">IPv4</div>
            <div class="setting-desc">Auto switches when IPv6 gets blocked.</div>
          </div>
          <div class="seg-grid three" role="radiogroup" aria-label="IPv4">
            {IPV4_MODES.map((m) => (
              <button
                key={m}
                role="radio"
                aria-checked={s.ipv4 === m}
                class={s.ipv4 === m ? 'on' : ''}
                onClick={() => updateSettings({ ipv4: m })}
                data-testid={`ipv4-${m}`}
              >
                {IPV4_LABELS[m]}
              </button>
            ))}
          </div>
        </div>
        <NetStatusLine />
        <div class="setting">
          <div class="setting-text">
            <div class="setting-name">Autoplay</div>
            <div class="setting-desc">Plays similar songs when your list ends.</div>
          </div>
          <Toggle on={s.autoplay} onChange={(v) => updateSettings({ autoplay: v })} label="Autoplay" testid="autoplay-toggle" />
        </div>
        <CheckEvery />
      </section>

      <Updates />

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
          <p data-testid="libraries">
            NewPipeExtractor (GPL-3.0); AndroidX Media3 and other AndroidX libraries, OkHttp, Okio, Kotlin,
            kotlinx.coroutines, Guava, nanojson and Apache Cordova (Apache-2.0); Preact, @preact/signals, Capacitor, the
            Ionic filesystem library and jsoup (MIT); Rhino (MPL-2.0); Protocol Buffers and JSR 305 (BSD-3-Clause);
            desugar_jdk_libs (GPL-2.0 with the Classpath Exception).
          </p>
        </details>
        <LicenseTexts />
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
