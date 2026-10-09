# Submitting CyberJuke to F-Droid

[`io.github.iamandelib.cyberjuke.yml`](io.github.iamandelib.cyberjuke.yml) is the recipe for [fdroiddata](https://gitlab.com/fdroid/fdroiddata), in the field order `fdroid rewritemeta` writes and without comments, so it can be pasted as is. It is modelled on Voyager's Capacitor recipe: F-Droid installs JDK 21 and Node 22.22.0 (the tarball checksum is pinned; GitHub's workflows use the same Node), builds the web app, runs `cap sync`, then builds `android/app` with Gradle. `Binaries` and `AllowedAPKSigningKeys` let F-Droid ship the GitHub-signed APK when its own build matches it.

The store listing (title, descriptions, icon, feature graphic, screenshots, per-version changelogs) comes from [`fastlane/metadata/android/en-US/`](../../fastlane/metadata/android/en-US) in this repository. F-Droid reads it from the tagged commit, so nothing about the listing goes in the recipe.

## Before submitting

The recipe holds only the newest release (fdroiddata asks for that until an app is included; after that F-Droid's bot adds each new tag). Every release from **v1.0.1** on is reproducible; 1.0.0's signing re-aligned two files, so F-Droid's build can't match it (see the CHANGELOG). The file is exactly as `fdroid rewritemeta` writes it and passes `fdroid lint`.

1. **Publish the release** with the Release workflow (Actions → Release → version, e.g. `1.0.1`). The workflow commits the version bump if needed, builds an unsigned APK, signs it in the protected `release` environment, checks that the signed APK is the unsigned build plus a signature, and tags the commit `v1.0.1`.
2. **Fill in the recipe:**
   - `commit:` the full hash of the `v1.0.1` tag: `git rev-parse v1.0.1^{commit}`.
   - `AllowedAPKSigningKeys:` already filled in with the release certificate's SHA-256. Check it against the published APK:
     ```bash
     apksigner verify --print-certs CyberJuke-1.0.1.apk | sed -n 's/.*certificate SHA-256 digest: //p'
     ```
3. **Check that the build is reproducible:** run **Actions → Reproducible build check** with the tag `v1.0.1`. It rebuilds the tag unsigned, the way F-Droid does, and compares it with the signed APK on the release. To do the same by hand:
   ```bash
   git clone https://github.com/IamAndelib/CyberJuke && cd CyberJuke && git checkout v1.0.1
   npm ci --ignore-scripts && npm run build && npx cap sync android --deployment
   cd android && ./gradlew assembleRelease
   pipx run apksigcopier==1.1.1 compare CyberJuke-1.0.1.apk --unsigned app/build/outputs/apk/release/*.apk
   ```
   `apksigcopier` calls `apksigner`, so put the SDK build-tools on `PATH` first. `diffoscope` shows the differences if the comparison fails. Use the same JDK (Temurin 21) as CI.
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
   - It is a Capacitor app; `scandelete: node_modules` removes the prebuilt binaries the scanner flags in it, after the web build.
   - Reproducible builds with the developer's signature (`Binaries` + `AllowedAPKSigningKeys`), so F-Droid and GitHub APKs update each other.
   - `NonFreeNet`: YouTube playback through NewPipeExtractor, and Cyberspace's backend (Firestore).
   - NewPipeExtractor comes from JitPack, as in NewPipe's own recipe.
3. The F-Droid CI builds it; fix anything its `fdroid lint`/`build` jobs report.

## Things F-Droid's scanner checks that are already handled

- The app's own update check (Settings → Updates, GitHub's releases API) never runs when F-Droid or another F-Droid client installed the app (detected from the installer package); those installs update through F-Droid.
- No Google Play Services, Firebase SDK or `google-services` plugin (Firebase Auth and Firestore are reached over plain HTTPS from the web code).
- No dependency-metadata block in the APK (`dependenciesInfo` is off in `android/app/build.gradle`).
- No prebuilt binaries in the repository besides the official Gradle wrapper JAR (its checksum is validated in CI).
- The version is literal in `android/app/build.gradle` (`versionCode`/`versionName`), so `AutoUpdateMode: Version` can pick up new tags.

## After inclusion

Each release made with the Release workflow creates a `v<version>` tag with a matching `fastlane/.../changelogs/<versionCode>.txt`. F-Droid's checkupdates bot notices the tag, adds the build entry, and publishes the GitHub-signed APK once its reproducible build matches.

Keep the release signing key safe: F-Droid users can only update with APKs signed by the key in `AllowedAPKSigningKeys`.
