import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { verifyOfflineAccess } from '../../src/main/adapters/offline-access-verifier.adapter';
import { OFFLINE_ACCESS_AUDIENCE, OFFLINE_ACCESS_LIMITS } from '../../server/core/offline-access';

const baseUrl='http://127.0.0.1:55844';
const now=Date.parse('2026-10-12T00:00:00Z');
const identity={userId:'fixture-owner',displayName:'Fixture',email:'fixture@example.invalid',emailVerified:true,identityAdmin:false,crmRoles:['sales']};
const keys=generateKeyPairSync('ed25519');
const trustedPublicKey=keys.publicKey.export({format:'pem',type:'spki'}).toString();
function grant(change:Record<string,unknown>={}) {
  const payload=JSON.stringify({version:1,audience:OFFLINE_ACCESS_AUDIENCE,issuer:baseUrl,issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+OFFLINE_ACCESS_LIMITS.validity_seconds*1000).toISOString(),identity,...change});
  return {payload,signature:sign(null,Buffer.from(payload),keys.privateKey).toString('base64url'),publicKey:trustedPublicKey};
}
const verify=(value=grant(),lastSeenAt=now,clock=now)=>verifyOfflineAccess(value,{trustedPublicKey,baseUrl,userId:identity.userId,lastSeenAt,now:clock});
describe('offline local authority signature verification',()=>{
  it('accepts exact authenticated Ed25519 identity for 72 hours',()=>expect(verify()?.identity.userId).toBe(identity.userId));
  it('rejects modified signed bytes and substituted self-signed keys',()=>{
    const valid=grant();expect(verify({...valid,payload:valid.payload+' '})).toBeNull();
    const attacker=generateKeyPairSync('ed25519');expect(verify({...valid,signature:sign(null,Buffer.from(valid.payload),attacker.privateKey).toString('base64url'),publicKey:attacker.publicKey.export({format:'pem',type:'spki'}).toString()})).toBeNull();
  });
  it.each([{audience:'crm-api'},{issuer:'http://127.0.0.1:1'},{identity:{...identity,userId:'other'}},{identity:{...identity,mustChangePassword:true}},{version:2}])('rejects wrong scope or restricted identity %j',change=>expect(verify(grant(change))).toBeNull());
  it('rejects expiration, future issuance, excessive lifetime and clock rollback',()=>{
    expect(verify(grant(),now,now+OFFLINE_ACCESS_LIMITS.validity_seconds*1000)).toBeNull();
    expect(verify(grant({issuedAt:new Date(now+61000).toISOString()}))).toBeNull();
    expect(verify(grant({expiresAt:new Date(now+(OFFLINE_ACCESS_LIMITS.validity_seconds+1)*1000).toISOString()}))).toBeNull();
    expect(verify(grant(),now+61000)).toBeNull();
  });
  it('rejects malformed key, signature, dates and identity without throwing',()=>{
    expect(verify({...grant(),publicKey:'malformed'})).toBeNull();
    expect(verify({...grant(),signature:'not a signature'})).toBeNull();
    expect(verify(grant({expiresAt:'invalid'}))).toBeNull();
    expect(verify(grant({identity:{userId:identity.userId}}))).toBeNull();
    expect(verify(grant({identity:{...identity,crmCapabilities:['leads:claim',42]}}))).toBeNull();
  });
});
