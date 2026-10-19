import { failure } from '../core/crm';
import { CONTACT_CHANGE_LIMITS, contactChangeQuery, type ContactChangeRepository } from '../core/contact-change-feed';
import type { TokenPort } from '../core/auth';
export function createContactChangeService(repo: ContactChangeRepository, tokens: TokenPort) { return { feed(token: string, input: unknown) { const query = contactChangeQuery(input); if (!query.ok) return Promise.resolve(query); if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return Promise.resolve(failure('UNAUTHORIZED', '会话无效')); return repo.feed(tokens.hash(token), query.data); } }; }
export type ContactChangeService = ReturnType<typeof createContactChangeService>;
