# Submitting CyberJuke to F-Droid

`io.github.iamandelib.cyberjuke.yml` is a draft recipe for [fdroiddata](https://gitlab.com/fdroid/fdroiddata). It is modelled on Voyager's Capacitor recipe: F-Droid installs Node, builds the web app, runs `cap sync`, then builds `android/app` with Gradle.

The store listing (title, descriptions, icon, feature graphic, screenshots, per-version changelogs) comes from [`fastlane/metadata/android/en-US/`](../../fastlane/metadata/android/en-US) in this repository. F-Droid reads it from the tagged commit, so nothing about the listing goes in the recipe.

## Before submitting

1. **Publish v1.0.0** with the Release workflow (Actions → Release → version `1.0.0`). The workflow commits the version bump if needed, builds an unsigned APK, signs it in the protected `release` environment and tags the commit `v1.0.0`.
2. **Fill in the recipe:**
   - `commit:` the full hash of the `v1.0.0` tag: `git rev-parse v1.0.0^{commit}`.
   - `AllowedAPKSigningKeys:` already filled in with the release certificate's SHA-256. Check it against the published APK:
     ```bash
     apksigner verify --print-certs CyberJuke-1.0.0.apk | sed -n 's/.*certificate SHA-256 digest: //p'
     ```
3. **Check that the build is reproducible:** run **Actions → Reproducible build check** with the tag `v1.0.0`. It rebuilds the tag unsigned, the way F-Droid does, and compares it with the signed APK on the release. To do the same by hand:
   ```bash
   git clone https://github.com/IamAndelib/CyberJuke && cd CyberJuke && git checkout v1.0.0
   npm ci --ignore-scripts && npm run build && npx cap sync android --deployment
   cd android && ./gradlew assembleRelease
   pipx run apksigcopier==1.1.1 compare CyberJuke-1.0.0.apk --unsigned app/build/outputs/apk/release/*.apk
   ```
   `diffoscope` shows the differences if the comparison fails. Use the same JDK (Temurin 21) as CI.
4. **Lint the recipe** in an fdroiddata checkout, if you have `fdroidserver`:
   ```bash
   cp docs/fdroid/io.github.iamandelib.cyberjuke.yml ../fdroiddata/metadata/
   cd ../fdroiddata
   fdroid readmeta && fdroid rewritemeta io.github.iamandelib.cyberjuke && fdroid lint io.github.iamandelib.cyberjuke
   fdroid checkupdates --allow-dirty io.github.iamandelib.cyberjuke
   fdroid build -v -l io.github.iamandelib.cyberjuke   # needs the Android SDK
   ```

## Submitting

1. Fork [fdroiddata](https://gitlab.com/fdroid/fdroiddata) on GitLab and add `metadata/io.github.iamandelib.cyberjuke.yml`.
2. Open a merge request using the "App inclusion" template. Mention:
   - It is a Capacitor app; `node_modules` is removed by `scandelete` after the web build.
   - Reproducible builds with the developer's signature (`Binaries` + `AllowedAPKSigningKeys`), so F-Droid and GitHub APKs update each other.
   - `NonFreeNet`: YouTube playback through NewPipeExtractor, and Cyberspace's backend (Firestore).
   - NewPipeExtractor comes from JitPack, as in NewPipe's own recipe.
3. The F-Droid CI builds it; fix anything its `fdroid lint`/`build` jobs report.

## Things F-Droid's scanner checks that are already handled

- No Google Play Services, Firebase SDK or `google-services` plugin (Firebase Auth and Firestore are reached over plain HTTPS from the web code).
- No dependency-metadata block in the APK (`dependenciesInfo` is off in `android/app/build.gradle`).
- No prebuilt binaries in the repository besides the official Gradle wrapper JAR (its checksum is validated in CI).
- The version is literal in `android/app/build.gradle` (`versionCode`/`versionName`), so `AutoUpdateMode: Version` can pick up new tags.

## After inclusion

Each release made with the Release workflow creates a `v<version>` tag with a matching `fastlane/.../changelogs/<versionCode>.txt`. F-Droid's checkupdates bot notices the tag, adds the build entry, and publishes the GitHub-signed APK once its reproducible build matches.

Keep the release signing key safe: F-Droid users can only update with APKs signed by the key in `AllowedAPKSigningKeys`.
