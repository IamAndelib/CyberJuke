package io.github.iamandelib.cyberjuke;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import io.github.iamandelib.cyberjuke.player.JukePlayerPlugin;
import io.github.iamandelib.cyberjuke.player.LaunchOptions;
import io.github.iamandelib.cyberjuke.player.MusicPlugin;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Custom plugins must be registered before super.onCreate() creates the bridge.
        registerPlugin(JukePlayerPlugin.class);
        registerPlugin(MusicPlugin.class);
        LaunchOptions.updateFrom(getIntent());
        super.onCreate(savedInstanceState);
        // CI only (debuggable builds): `--es ci_music_search "<query>"` logs one search result count.
        MusicPlugin.maybeRunCiSearch(this, getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        // e.g. `am start ... --es autoplay latest` while the app is already running
        LaunchOptions.updateFrom(intent);
        super.onNewIntent(intent);
        MusicPlugin.maybeRunCiSearch(this, intent);
    }
}
