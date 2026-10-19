import { createPublicKey, verify } from 'node:crypto';
import { CRM_ROLES } from '../../../server/core/auth';
import { OFFLINE_ACCESS_AUDIENCE, OFFLINE_ACCESS_LIMITS } from '../../../server/core/offline-access';
import type { OfflineAccessGrant, OfflineAccessPayload } from '../../../server/core/offline-access';

const MILLISECONDS_PER_SECOND=1000;
export interface OfflineVerificationContext { trustedPublicKey:string; baseUrl:string; userId:string; lastSeenAt:number; now:number; }
/** Verify raw signed bytes against a separately protected authenticated-online key. */
export function verifyOfflineAccess(grant:OfflineAccessGrant|undefined, context:OfflineVerificationContext):OfflineAccessPayload|null {
  try {
    if(!grant || typeof grant.payload!=='string' || Buffer.byteLength(grant.payload)>OFFLINE_ACCESS_LIMITS.payload_bytes || typeof grant.signature!=='string' || grant.signature.length>OFFLINE_ACCESS_LIMITS.signature_bytes || !/^[A-Za-z0-9_-]+$/.test(grant.signature))return null;
    if(typeof context.trustedPublicKey!=='string' || context.trustedPublicKey.length>OFFLINE_ACCESS_LIMITS.public_key_bytes || grant.publicKey!==context.trustedPublicKey)return null;
    const key=createPublicKey(context.trustedPublicKey);if(key.asymmetricKeyType!=='ed25519' || !verify(null,Buffer.from(grant.payload),key,Buffer.from(grant.signature,'base64url')))return null;
    const payload=JSON.parse(grant.payload) as OfflineAccessPayload;
    if(payload.version!==1 || payload.audience!==OFFLINE_ACCESS_AUDIENCE || payload.issuer!==context.baseUrl)return null;
    const identity=payload.identity;
    if(!identity || identity.userId!==context.userId || typeof identity.displayName!=='string' || typeof identity.email!=='string' || !identity.email || typeof identity.emailVerified!=='boolean' || typeof identity.identityAdmin!=='boolean' || !Array.isArray(identity.crmRoles) || identity.crmRoles.some(role=>!CRM_ROLES.includes(role)) || identity.mustChangePassword)return null;
    if(identity.crmCapabilities!==undefined&&identity.crmCapabilities!==null&&(!Array.isArray(identity.crmCapabilities)||identity.crmCapabilities.some(capability=>typeof capability!=='string')))return null;
    const issued=Date.parse(payload.issuedAt),expires=Date.parse(payload.expiresAt),skew=OFFLINE_ACCESS_LIMITS.clock_skew_seconds*MILLISECONDS_PER_SECOND;
    if(!Number.isFinite(context.now) || !Number.isFinite(context.lastSeenAt) || !Number.isFinite(issued) || !Number.isFinite(expires) || expires<=issued || expires-issued>OFFLINE_ACCESS_LIMITS.validity_seconds*MILLISECONDS_PER_SECOND || issued>context.now+skew || context.now+skew<context.lastSeenAt || Math.max(context.now,context.lastSeenAt)>=expires)return null;
    return payload;
  } catch { /* Untrusted or malformed authorization fails closed without exposing crypto details. */ return null; }
}
