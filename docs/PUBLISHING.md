# Publishing CyberJuke: the maintainer's steps

What you do on your side, in order. Steps 1–3 are once only.

## 1. Get the signing keys (once)

The app is signed with two keys: `preview.jks` for test builds and `release.jks` for the real app. There are two ways to get them:

- **Simple route (what was used for CyberJuke):** the keys are generated for you and you receive three files: `preview.jks`, `release.jks` and `CyberJuke-secrets.txt`. The text file holds the 8 secret values and both passwords.
- **Own-computer route:** generate the keys yourself with the setup script, so they never leave your computer. See [Alternative: the setup script](#alternative-the-setup-script) below.

## 2. Add the 8 secrets to GitHub (once)

1. Open <https://github.com/IamAndelib/CyberJuke/settings/secrets/actions>.
2. For each of the 8 entries in `CyberJuke-secrets.txt`, click **New repository secret**. Put the NAME in "Name" and paste the value under it into "Secret". If a name already exists, click its pencil and replace the value.
3. When all 8 are in (`PREVIEW_KEYSTORE_FILE`, `PREVIEW_KEYSTORE_PASSWORD`, `PREVIEW_KEY_ALIAS`, `PREVIEW_KEY_PASSWORD`, `KEYSTORE_FILE`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`), run **Actions → Preview → Run workflow** to make a test build.

**Optional hardening:** under Settings → Environments, open `release` (it appears after the first release run), add yourself as a **required reviewer** and limit it to the `main` branch. Every release then waits for your click.

### Alternative: the setup script

For keys made on your own computer instead. You need Java's `keytool` (any JDK 17 or newer) and the GitHub CLI `gh`:

| Your computer | Command |
|---|---|
| Ubuntu / Debian / WSL | `sudo apt install openjdk-21-jdk-headless gh` (if `gh` isn't found: <https://github.com/cli/cli/blob/trunk/docs/install_linux.md>) |
| Fedora | `sudo dnf install gh java-latest-openjdk-headless` |
| Mac (Homebrew) | `brew install openjdk@21 gh` |
| Windows | `winget install EclipseAdoptium.Temurin.21.JDK GitHub.cli`, then use **Git Bash** |

Then, in a terminal in any folder:

```bash
gh auth login        # GitHub.com → HTTPS → log in with a web browser
curl -fsSLO https://raw.githubusercontent.com/IamAndelib/CyberJuke/main/scripts/setup-publishing.sh
bash setup-publishing.sh
```

The script asks before every change. It:

1. Creates the two keys in `~/cyberjuke-keys/`. You choose a password for each; a generated one stored in a password manager is best.
2. Sets up the protected `preview` and `release` environments: main only, and every release waits for your approval.
3. Stores the keys there as secrets.
4. Prints the release certificate fingerprint F-Droid needs.
5. Starts the test build.

Running it again is safe. If a key file is missing but GitHub already has that key, it stops rather than make a new one.

## 3. Back up the keys (once, right away)

Copy **both** `.jks` files and **both** passwords (with the simple route: the three files you received) to two safe places, for example a password manager and an offline USB drive. Then delete any loose copies, such as the ones in Downloads.

- If you lose `release.jks` or its password, nobody can install an update over the existing app any more. They'd have to uninstall it and lose their likes and history.
- If you lose `preview.jks`, testers have to reinstall the preview. That's annoying but not serious.

## 4. Remove the old test build (once)

On your phone, uninstall the old **CyberJuke** preview. It was signed with a key that used to be in the repository, which is why it's being retired. If you signed in with your Cyberspace account on it, change your Cyberspace password afterwards.

## 5. Test the preview

1. On your phone, open <https://github.com/IamAndelib/CyberJuke/releases/tag/preview>.
2. Download `CyberJuke-preview.apk` and install it. Allow installs from your browser if Android asks.
3. It appears as **CyberJuke Preview**, a separate app from the real CyberJuke.
4. Go through [`docs/TESTING.md`](TESTING.md). Send me whatever looks wrong: what you did, what you saw, and a screenshot or screen recording.

When something gets fixed, a new preview is built with **Actions → Preview → Run workflow**, or I start it. It installs over the old one and keeps your data.

## 6. Release v0.1.0

When the preview has passed testing:

1. Tell me, and I'll move the CHANGELOG's "Unreleased" notes into the 0.1.0 section.
2. On GitHub go to **Actions → Release → Run workflow**, type `0.1.0`, then **Run**.
3. If you added yourself as a required reviewer (step 2, optional), the run pauses at **Sign and publish**: open it, click **Review deployments**, tick `release` and **Approve**. Otherwise it simply carries on.
4. A few minutes later, **Releases** shows **CyberJuke v0.1.0** with `CyberJuke-0.1.0.apk`. That's the real app, signed with your release key.

Later versions work the same way: add a CHANGELOG section, then run Release with the new number (for example `0.1.1`).

## 7. Submit to F-Droid

1. Send me the release certificate fingerprint: the last line of `CyberJuke-secrets.txt`, or `~/cyberjuke-keys/release-cert-sha256.txt` with the script. I'll fill in [`docs/fdroid/io.github.iamandelib.cyberjuke.yml`](fdroid/io.github.iamandelib.cyberjuke.yml) with it and the `v0.1.0` commit, and check that the build is reproducible.
2. Create a free account on <https://gitlab.com> and **fork** <https://gitlab.com/fdroid/fdroiddata>.
3. In your fork, add the file as `metadata/io.github.iamandelib.cyberjuke.yml`.
4. Open a **merge request** using the "App inclusion" template. [`docs/fdroid/README.md`](fdroid/README.md) lists what to mention.
5. F-Droid's volunteers review it. Expect questions and a few days to weeks. The app gets the **NonFreeNet** label, because it uses YouTube and Cyberspace's servers; that's normal for apps like NewPipe.
6. **Reproducible builds:** F-Droid builds the same commit itself, and when its build matches yours, it ships **your** signed APK. So F-Droid and GitHub installs update each other.

## 8. Optional

- **Dependency updates:** install the [Renovate app](https://github.com/apps/renovate) on the repository. It opens a weekly pull request with updates, and opens one sooner when a new NewPipeExtractor commit lands. When YouTube breaks playback, that update is usually the fix. The daily **YouTube canary** run opens an issue when that happens.
- **Dependency checksums:** run **Actions → Gradle verification metadata** once, then ask me to commit the file it produces. After that, every build checks each library's SHA-256.

## If something goes wrong

| Problem | Fix |
|---|---|
| `gh: command not found` / `keytool: command not found` | Step 1. On Windows, use Git Bash, not PowerShell. |
| "is not an admin of IamAndelib/CyberJuke" | Run `gh auth logout`, then `gh auth login` with the owner account. |
| Preview or Release run fails at "Check signing secrets" | The error lists the missing names: add them (step 2), or rerun the script. |
| Release run stops at "prepare" with a push error | `main` has a branch rule. Add `github-actions[bot]` to its bypass list (the script warns about this). |
| Lost a key | Restore it from your backup into `~/cyberjuke-keys/` and run the script again. |
