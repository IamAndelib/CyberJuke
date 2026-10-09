import { describe, expect, it } from 'vitest';
import { AUTO_CHECK_MS, RELEASES_URL, RETRY_AFTER_FAILURE_MS, autoCheckDue, isFdroidInstaller, isNewer, parseVersion, releaseOf } from './updates';

describe('versions', () => {
  it('compares x.y.z numerically, ignoring a leading v and a suffix', () => {
    expect(parseVersion('v1.0.10')).toEqual([1, 0, 10]);
    expect(parseVersion('1.0.3-preview')).toEqual([1, 0, 3]);
    expect(parseVersion('1.0')).toBeNull();
    expect(isNewer('1.0.10', '1.0.9')).toBe(true);
    expect(isNewer('v1.1.0', '1.0.99')).toBe(true);
    expect(isNewer('2.0.0', '10.0.0')).toBe(false);
    expect(isNewer('1.0.3', '1.0.3')).toBe(false);
    // The preview app of the same version is not behind its release.
    expect(isNewer('1.0.3', '1.0.3-preview')).toBe(false);
    expect(isNewer('1.0.4', '1.0.3-preview')).toBe(true);
    expect(isNewer('garbage', '1.0.0')).toBe(false);
  });
});

describe('F-Droid installs', () => {
  it('are left to F-Droid (its clients); anything else checks', () => {
    expect(isFdroidInstaller('org.fdroid.fdroid')).toBe(true);
    expect(isFdroidInstaller('com.looker.droidify')).toBe(true);
    expect(isFdroidInstaller('com.android.chrome')).toBe(false);
    expect(isFdroidInstaller(null)).toBe(false);
    expect(isFdroidInstaller(undefined)).toBe(false);
  });
});

describe('automatic checks', () => {
  it('are due when never checked, a day after the last, or when the clock went back', () => {
    const now = 1_800_000_000_000;
    expect(autoCheckDue(0, now)).toBe(true);
    expect(autoCheckDue(now - AUTO_CHECK_MS + 60_000, now)).toBe(false);
    expect(autoCheckDue(now - AUTO_CHECK_MS, now)).toBe(true);
    expect(autoCheckDue(now + 3_600_000, now)).toBe(true);
  });

  it('wait an hour after a failed one', () => {
    const now = 1_800_000_000_000;
    expect(autoCheckDue(0, now, now - 10 * 60_000)).toBe(false);
    expect(autoCheckDue(0, now, now - RETRY_AFTER_FAILURE_MS)).toBe(true);
    expect(autoCheckDue(now - AUTO_CHECK_MS, now, now - 60_000)).toBe(false);
  });
});

describe("GitHub's latest release", () => {
  it('becomes a version and its page; drafts, pre-releases and odd tags are ignored', () => {
    expect(releaseOf({ tag_name: 'v1.0.4', html_url: `${RELEASES_URL}/tag/v1.0.4` })).toEqual({ version: '1.0.4', url: `${RELEASES_URL}/tag/v1.0.4` });
    // A page elsewhere is never opened: the releases page instead.
    expect(releaseOf({ tag_name: 'v1.0.4', html_url: 'https://evil.example/x' })?.url).toBe(`${RELEASES_URL}/latest`);
    expect(releaseOf({ tag_name: 'v1.1.0-beta.1' })).toBeNull();
    expect(releaseOf({ tag_name: 'v1.0.4', prerelease: true })).toBeNull();
    expect(releaseOf({ tag_name: 'v1.0.4', draft: true })).toBeNull();
    expect(releaseOf({ tag_name: 'preview' })).toBeNull();
    expect(releaseOf(null)).toBeNull();
  });
});
