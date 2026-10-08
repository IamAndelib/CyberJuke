import { describe, expect, it } from 'vitest';
import { isExternalUrl, isPostUrl, youtubeUrl } from './links';

describe('links', () => {
  it('posts open only on beta.cyberspace.online over https', () => {
    expect(isPostUrl('https://beta.cyberspace.online/nightowl/my-post')).toBe(true);
    expect(isPostUrl('https://beta.cyberspace.online/jukebox')).toBe(true);
    for (const bad of [
      'http://beta.cyberspace.online/x/y',
      'https://beta.cyberspace.online.evil.com/x',
      'https://evil.com/beta.cyberspace.online/x',
      'https://user:pw@beta.cyberspace.online/x',
      'https://beta.cyberspace.online:8443/x',
      'javascript:alert(1)',
      'intent://x#Intent;end',
      '',
      'not a url',
    ])
      expect(isPostUrl(bad), bad).toBe(false);
  });

  it('outside links: https and known hosts only', () => {
    expect(isExternalUrl('https://cyberspace.online/?signup=1')).toBe(true);
    expect(isExternalUrl('https://github.com/IamAndelib/CyberJuke/releases')).toBe(true);
    expect(isExternalUrl(youtubeUrl('abcdefghijk'))).toBe(true);
    expect(isExternalUrl('http://github.com/x')).toBe(false);
    expect(isExternalUrl('https://github.com.evil.io/x')).toBe(false);
    expect(isExternalUrl('file:///etc/passwd')).toBe(false);
  });
});
