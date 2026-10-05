package io.github.iamandelib.cyberjuke;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import io.github.iamandelib.cyberjuke.player.JukePlayerPlugin;
import io.github.iamandelib.cyberjuke.player.LaunchOptions;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Custom plugins must be registered before super.onCreate() creates the bridge.
        registerPlugin(JukePlayerPlugin.class);
        LaunchOptions.updateFrom(getIntent());
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        // e.g. `am start ... --es autoplay latest` while the app is already running
        LaunchOptions.updateFrom(intent);
        super.onNewIntent(intent);
    }
}
