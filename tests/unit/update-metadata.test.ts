import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareReleaseVersions, latestReleaseForChannel, parseReleaseFeed } from '../../src/main/services/update-metadata.service';

const feed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>v0.59.0-alpha.2</title>
    <link rel="alternate" type="text/html" href="https://github.com/Miloglim/Milogin-s-prospector/releases/tag/v0.59.0-alpha.2"/>
    <published>2026-10-26T08:00:00Z</published>
    <content type="html">&lt;p&gt;Preview &amp;amp; fixes&lt;/p&gt;</content>
  </entry>
  <entry>
    <title>v0.58.1</title>
    <link rel="alternate" type="text/html" href="https://github.com/Miloglim/Milogin-s-prospector/releases/tag/v0.58.1"/>
    <updated>2026-10-25T08:00:00Z</updated>
    <content type="html">Stable release</content>
  </entry>
  <entry>
    <title>v0.58.0</title>
    <link rel="alternate" type="text/html" href="https://github.com/Miloglim/Milogin-s-prospector/releases/tag/v0.58.0"/>
    <published>2026-10-24T08:00:00Z</published>
    <content type="html">Older stable</content>
  </entry>
</feed>`;

describe('GitHub Release Atom metadata', () => {
  it('parses stable and preview releases without GitHub REST API data', () => {
    const releases = parseReleaseFeed(feed);
    expect(releases).toHaveLength(3);
    expect(releases[0]).toMatchObject({ version: '0.59.0-alpha.2', prerelease: true, publishedAt: '2026-10-26T08:00:00Z', body: 'Preview & fixes' });
    expect(releases[1]).toMatchObject({ version: '0.58.1', prerelease: false, publishedAt: '2026-10-25T08:00:00Z' });
  });

  it('selects the correct latest release for each channel', () => {
    const releases = parseReleaseFeed(feed);
    expect(latestReleaseForChannel(releases, 'stable')?.version).toBe('0.58.1');
    expect(latestReleaseForChannel(releases, 'prerelease')?.version).toBe('0.59.0-alpha.2');
  });

  it('compares prerelease numbers instead of treating the whole core version as equal', () => {
    expect(compareReleaseVersions('0.59.0-alpha.2', '0.59.0-alpha.1')).toBe(1);
    expect(compareReleaseVersions('0.58.0', '0.59.0-alpha.1')).toBe(-1);
    expect(compareReleaseVersions('0.59.0', '0.59.0-alpha.2')).toBe(1);
  });

  it('removes the unauthenticated GitHub REST API dependency from updater checks', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/main/updater.ts'), 'utf8');
    expect(source).toContain('releases.atom');
    expect(source).not.toContain('api.github.com');
  });
});
