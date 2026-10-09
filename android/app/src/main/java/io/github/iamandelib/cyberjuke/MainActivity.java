package io.github.iamandelib.cyberjuke;

import android.content.Intent;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import io.github.iamandelib.cyberjuke.bridge.JukePlayerPlugin;
import io.github.iamandelib.cyberjuke.bridge.MusicPlugin;
import io.github.iamandelib.cyberjuke.bridge.SecureStorePlugin;
import io.github.iamandelib.cyberjuke.playback.LaunchOptions;

public class MainActivity extends BridgeActivity {

    private static final String TAG = "CyberJukeActivity";

    /** A renderer that crashed again this soon after the last crash: stop reloading the page. */
    private static final long CRASH_LOOP_MS = 10_000L;

    /** When the page's renderer last crashed (elapsedRealtime); kept across recreations. */
    private static long lastRendererCrashAt = -CRASH_LOOP_MS;

    /** The page's renderer went while the app was in the background: reload on return. */
    private boolean recreateOnResume = false;

    private boolean resumed = false;

    /** Inside onCreate: Capacitor replays the launch intent through onNewIntent there. */
    private boolean creating = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Custom plugins must be registered before super.onCreate() creates the bridge.
        registerPlugin(JukePlayerPlugin.class);
        registerPlugin(MusicPlugin.class);
        registerPlugin(SecureStorePlugin.class);
        LaunchOptions.updateFrom(this, getIntent());
        creating = true;
        try {
            super.onCreate(savedInstanceState);
        } finally {
            creating = false;
        }
        getBridge().addWebViewListener(new RendererWatch());
        // CI only (debuggable builds): ci_music_search / ci_artist / ci_lyrics / ci_artist_page extras log one check each.
        MusicPlugin.maybeRunCiChecks(this, getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        // BridgeActivity.load() passes the launch intent through here during onCreate, which
        // has handled it already: only Capacitor's own handling then.
        if (creating) {
            super.onNewIntent(intent);
            return;
        }
        // e.g. `am start ... --es autoplay latest` while the app is already running (debuggable only)
        LaunchOptions.updateFrom(this, intent);
        // The latest intent is the activity's: a recreated activity (a new page) starts from it,
        // not from the one that first launched the app.
        setIntent(intent);
        super.onNewIntent(intent);
        MusicPlugin.maybeRunCiChecks(this, intent);
        maybeCrashRendererForCi(intent);
    }

    @Override
    public void onPause() {
        resumed = false;
        super.onPause();
    }

    @Override
    public void onResume() {
        super.onResume();
        resumed = true;
        if (recreateOnResume) {
            recreateOnResume = false;
            recreate();
        }
    }

    /**
     * The page's renderer is a separate process. Android may stop it to free memory (mostly in
     * the background) and it can crash; left unhandled, Android then kills the whole app, the
     * music service with it. Here the dead WebView goes and the page loads again (at once if the
     * app is on screen, else when it comes back); playback carries on in the service meanwhile,
     * and the new page picks up its state.
     */
    private final class RendererWatch extends WebViewListener {
        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            boolean crashed = detail.didCrash();
            Log.w(TAG, "WebView renderer gone (" + (crashed ? "crashed" : "stopped by the system") + "): reloading the page");
            ViewGroup parent = (ViewGroup) view.getParent();
            if (parent != null) parent.removeView(view);
            view.destroy();
            long now = SystemClock.elapsedRealtime();
            if (crashed && now - lastRendererCrashAt < CRASH_LOOP_MS) {
                // Crashing on load: give up the page (the music service keeps playing).
                Log.w(TAG, "WebView renderer crashed again: closing the page");
                finish();
                return true;
            }
            if (crashed) lastRendererCrashAt = now;
            if (resumed) {
                recreate();
            } else {
                recreateOnResume = true;
            }
            return true;
        }
    }

    /** CI only (debuggable builds): `--es ci_renderer kill|crash` ends the page's renderer. */
    private void maybeCrashRendererForCi(Intent intent) {
        String url = LaunchOptions.ciRendererUrl(this, intent);
        if (url == null) return;
        intent.removeExtra("ci_renderer"); // once: not again for the recreated activity
        WebView webView = getBridge().getWebView();
        if (webView != null) webView.loadUrl(url);
    }
}
