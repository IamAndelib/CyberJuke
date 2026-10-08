import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.github.iamandelib.cyberjuke',
  appName: 'CyberJuke',
  webDir: 'dist',
  android: {
    backgroundColor: '#000000',
    // Set explicitly rather than relying on Capacitor's build-type defaults. The same
    // capacitor.config.json is copied into every build type (debug, preview, release), so
    // these also apply to debug builds: JS console output stays out of logcat, and the
    // WebView can't be inspected with chrome://inspect. Native logs are unaffected.
    loggingBehavior: 'none',
    webContentsDebuggingEnabled: false,
  },
};

export default config;
