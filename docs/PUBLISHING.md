# Publishing CyberJuke: the maintainer's steps

What you do on your side, in order. Steps 1–3 are once only. Every command runs in a terminal in your local copy of the repository.

## 1. Install the two tools (once)

You need Java's `keytool` (any JDK 17 or newer) and the GitHub CLI `gh`.

| Your computer | Command |
|---|---|
| Ubuntu / Debian / WSL | `sudo apt install openjdk-21-jdk-headless gh` (if `gh` isn't found: <https://github.com/cli/cli/blob/trunk/docs/install_linux.md>) |
| Fedora | `sudo dnf install java-21-openjdk-devel gh` |
| Mac (Homebrew) | `brew install openjdk@21 gh` |
| Windows | `winget install EclipseAdoptium.Temurin.21.JDK GitHub.cli`, then use **Git Bash** for the next steps |

Then log in to GitHub as the repository owner:

```bash
gh auth login        # GitHub.com → HTTPS → log in with a web browser
```

## 2. Run the setup script (once)

```bash
git pull
bash scripts/setup-publishing.sh
```

It asks before every change. In order, it:

1. Creates two signing keys in `~/cyberjuke-keys/`: `preview.jks` for test builds and `release.jks` for the real app. It asks you for a password for each. The keys never leave your computer, apart from the encrypted GitHub secrets.
2. Sets up two protected **environments** on GitHub:
   - `preview`, which can only run from `main`.
   - `release`, which can only run from `main` and waits for **your approval** every time.
3. Stores each key and its password as secrets in its environment, and removes any old copies stored at repository level.
4. Prints the **release certificate fingerprint** and saves it to `~/cyberjuke-keys/release-cert-sha256.txt`. F-Droid needs it; send it to me when we get to step 7. It isn't secret.
5. Starts the **CyberJuke Preview** test build, waits for it (about 15 minutes), and prints the download link.

Running it again is safe: it skips everything that's already set up. If a key file is missing but GitHub already has that key, it stops rather than make a new one, because a new key would force everyone to reinstall.

## 3. Back up the keys (once, right away)

Copy **both** `.jks` files and **both** passwords to two safe places, for example a password manager and an offline USB drive.

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
3. When the run pauses at **Sign and publish**, open it, click **Review deployments**, tick `release` and **Approve**. This is the protection from step 2.
4. A few minutes later, **Releases** shows **CyberJuke v0.1.0** with `CyberJuke-0.1.0.apk`. That's the real app, signed with your release key.

Later versions work the same way: add a CHANGELOG section, then run Release with the new number (for example `0.1.1`).

## 7. Submit to F-Droid

1. Send me the fingerprint from `~/cyberjuke-keys/release-cert-sha256.txt`. I'll fill in [`docs/fdroid/io.github.iamandelib.cyberjuke.yml`](fdroid/io.github.iamandelib.cyberjuke.yml) with it and the `v0.1.0` commit, and check that the build is reproducible.
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
| Preview run fails at "Check signing secrets" | Run the script again; it adds what's missing. |
| Release run stops at "prepare" with a push error | `main` has a branch rule. Add `github-actions[bot]` to its bypass list (the script warns about this). |
| Lost a key | Restore it from your backup into `~/cyberjuke-keys/` and run the script again. |
