import type { Identity } from './auth';

/** This grant unlocks an account's local profile; it is never an API bearer. */
export const OFFLINE_ACCESS_LIMITS = { validity_seconds: 72 * 60 * 60, clock_skew_seconds: 60, payload_bytes: 16384, public_key_bytes: 4096, signature_bytes: 256 } as const;
export const OFFLINE_ACCESS_AUDIENCE = 'prospector-local' as const;
export interface OfflineAccessPayload {
  version: 1; audience: typeof OFFLINE_ACCESS_AUDIENCE; issuer: string;
  issuedAt: string; expiresAt: string; identity: Identity;
}
export interface OfflineAccessGrant { payload: string; signature: string; publicKey: string; }
export interface OfflineAccessIssuer { issue(identity: Identity, now: number, absoluteExpiresAt?: number): OfflineAccessGrant | undefined; }
export const isCenterUnavailable = (code: string): boolean => ['UNAVAILABLE', 'DATABASE_ERROR', 'TIMEOUT'].includes(code);
