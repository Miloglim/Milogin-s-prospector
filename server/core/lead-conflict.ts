export type LeadConflictLevel = 'exact_email' | 'exact_domain' | 'exact_company' | 'strong_company' | 'weak_company' | 'none';

export interface CompanyConflictCandidate {
  companyId: number;
  name: string;
  domain?: string | null;
  country?: string | null;
}

export interface CompanyConflictMatch extends CompanyConflictCandidate {
  score: number;
  level: LeadConflictLevel;
}

const LEGAL_SUFFIXES = new Set(['co', 'company', 'corp', 'corporation', 'inc', 'ltd', 'limited', 'llc', 'sa', 'sas', 'srl', 'gmbh', 'ag', 'bv', 'nv', 'pty', 'plc']);
const COMPANY_STOP_WORDS = new Set(['the', 'group', 'holding', 'holdings', 'international', 'global', 'logistics', 'shipping', 'trade', 'trading', 'import', 'export']);
const STRONG_COMPANY_SCORE = 0.82;
const WEAK_COMPANY_SCORE = 0.68;

export function normalizeLeadEmail(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

export function normalizeLeadCountry(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

export function normalizeCompanyDomain(value: string | null | undefined): string {
  const raw = value?.trim().toLowerCase() ?? '';
  if (!raw) return '';
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return url.hostname.replace(/^www\./, '').replace(/\.$/, '');
  } catch {
    return raw.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]?.replace(/\.$/, '') ?? '';
  }
}

export function normalizeCompanyName(value: string | null | undefined): string {
  const tokens = (value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens.at(-1)!)) tokens.pop();
  return tokens.filter(token => !COMPANY_STOP_WORDS.has(token)).join('');
}

function bigrams(value: string): string[] {
  if (value.length < 2) return value ? [value] : [];
  return Array.from({ length: value.length - 1 }, (_, index) => value.slice(index, index + 2));
}

export function companyNameSimilarity(left: string | null | undefined, right: string | null | undefined): number {
  const a = normalizeCompanyName(left);
  const b = normalizeCompanyName(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const first = bigrams(a);
  const remaining = new Map<string, number>();
  for (const gram of bigrams(b)) remaining.set(gram, (remaining.get(gram) ?? 0) + 1);
  let overlap = 0;
  for (const gram of first) {
    const count = remaining.get(gram) ?? 0;
    if (count > 0) { overlap++; remaining.set(gram, count - 1); }
  }
  return (2 * overlap) / (first.length + bigrams(b).length);
}

export function matchCompanyConflict(input: { companyName: string; domain?: string | null; country?: string | null }, candidates: readonly CompanyConflictCandidate[]): CompanyConflictMatch | null {
  const domain = normalizeCompanyDomain(input.domain);
  const normalizedName = normalizeCompanyName(input.companyName);
  const country = normalizeLeadCountry(input.country);
  let best: CompanyConflictMatch | null = null;
  for (const candidate of candidates) {
    const candidateDomain = normalizeCompanyDomain(candidate.domain);
    if (domain && candidateDomain && domain === candidateDomain) return { ...candidate, score: 1, level: 'exact_domain' };
    const score = companyNameSimilarity(input.companyName, candidate.name);
    const candidateCountry = normalizeLeadCountry(candidate.country);
    const sameCountry = !country || !candidateCountry || country === candidateCountry;
    const differentCountry = !!country && !!candidateCountry && country !== candidateCountry;
    const level: LeadConflictLevel = normalizedName && normalizedName === normalizeCompanyName(candidate.name) && sameCountry
      ? 'exact_company'
      : score >= STRONG_COMPANY_SCORE && sameCountry ? 'strong_company'
        : score >= WEAK_COMPANY_SCORE && !differentCountry ? 'weak_company' : 'none';
    if (level !== 'none' && (!best || score > best.score)) best = { ...candidate, score, level };
  }
  return best;
}
