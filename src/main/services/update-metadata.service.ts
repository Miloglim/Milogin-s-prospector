export interface UpdateRelease {
  version: string;
  name: string;
  publishedAt: string;
  prerelease: boolean;
  htmlUrl: string;
  body: string;
}

const RELEASE_ENTRY = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
const RELEASE_LINK = /<link\b[^>]*href="([^"]*\/releases\/tag\/([^"/]+))"[^>]*\/?>/i;
const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (entity, name: string) => XML_ENTITIES[name.toLowerCase()] ?? entity)
    .trim();
}

function xmlValue(entry: string, tag: string): string {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(entry);
  return match ? decodeXml(match[1]!) : '';
}

function plainText(html: string): string {
  return decodeXml(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
}

export function releaseVersion(tag: string): string {
  return tag.trim().replace(/^v/i, '');
}

export function parseReleaseFeed(xml: string): UpdateRelease[] {
  const releases: UpdateRelease[] = [];
  for (const match of xml.matchAll(RELEASE_ENTRY)) {
    const entry = match[1]!;
    const link = RELEASE_LINK.exec(entry);
    if (!link) continue;
    const version = releaseVersion(link[2]!);
    if (!version) continue;
    releases.push({
      version,
      name: xmlValue(entry, 'title'),
      publishedAt: xmlValue(entry, 'published') || xmlValue(entry, 'updated'),
      prerelease: version.includes('-'),
      htmlUrl: decodeXml(link[1]!),
      body: plainText(xmlValue(entry, 'content')).slice(0, 500),
    });
  }
  return releases;
}

function numericParts(version: string): number[] {
  return version.split(/[+-]/, 1)[0]!.split('.').map(value => Number.parseInt(value, 10) || 0);
}

function prereleaseParts(version: string): string[] {
  const value = version.split('+', 1)[0]!;
  const separator = value.indexOf('-');
  return separator < 0 ? [] : value.slice(separator + 1).split('.');
}

export function compareReleaseVersions(left: string, right: string): number {
  const a = numericParts(releaseVersion(left));
  const b = numericParts(releaseVersion(right));
  for (let index = 0; index < 3; index++) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  const ap = prereleaseParts(releaseVersion(left));
  const bp = prereleaseParts(releaseVersion(right));
  if (!ap.length || !bp.length) return ap.length === bp.length ? 0 : ap.length ? -1 : 1;
  for (let index = 0; index < Math.max(ap.length, bp.length); index++) {
    const x = ap[index];
    const y = bp[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x.localeCompare(y, 'en') < 0 ? -1 : 1;
  }
  return 0;
}

export function latestReleaseForChannel(releases: UpdateRelease[], channel: 'stable' | 'prerelease'): UpdateRelease | null {
  const available = channel === 'prerelease' ? releases : releases.filter(release => !release.prerelease);
  return available.slice().sort((left, right) => compareReleaseVersions(right.version, left.version))[0] ?? null;
}
