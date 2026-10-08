# Security policy

## Reporting a vulnerability

Please report security problems **privately**, not in a public issue:

1. Go to the repository's **Security** tab → **Report a vulnerability** ([direct link](https://github.com/IamAndelib/CyberJuke/security/advisories/new)).
2. Describe the problem, the affected version (Settings → About shows it), and how to reproduce it. A proof of concept helps but isn't required.

You should get a first answer within a week. Once a fix is released, the advisory is published with credit to you, unless you'd rather stay anonymous.

Things that are in scope, for example:

- Leaking the Cyberspace login token or other stored data (to other apps, logs, backups or the network).
- Other apps controlling CyberJuke beyond play/pause/skip through its media session, or reading what it plays.
- Loading or running content from anywhere other than CyberJuke's own bundle (WebView, links, intents).
- Problems in how releases are built, signed or published.

Out of scope: YouTube or Cyberspace blocking requests, bugs in YouTube, Cyberspace or NewPipeExtractor themselves (report those upstream), and attacks that need a rooted or already compromised phone.

## Supported versions

Only the latest release gets security fixes. The `preview` pre-release is a separate test app built from `main`.

## Verifying what you install

Releases are built from a tagged commit by GitHub Actions and signed in a separate, protected job. The README explains how to check an APK's checksum and signing certificate: [Verifying a release APK](README.md#verifying-a-release-apk).
