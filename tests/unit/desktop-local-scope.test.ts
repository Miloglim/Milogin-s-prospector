import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DesktopLocalScope, developerProfileRoot, accountProfileRoot } from '../../src/main/adapters/desktop-local-scope.adapter';
import { IPC } from '../../src/main/contract';

const roots: string[] = [];
const alice = { baseUrl: 'http://127.0.0.1:55844', userId: 'synthetic-alice' };
const bob = { ...alice, userId: 'synthetic-bob' };
function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'prospector-local-scope-'));
  roots.push(value);
  return value;
}
afterEach(() => { for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true }); });

describe('R1 desktop personal store ownership', () => {
  it('retains offline local reads and draft/material/settings writes but blocks network and CRM work', async () => {
    let online = false;
    let active: typeof alice | null = alice;
    const scope = new DesktopLocalScope(root(), true, () => active, () => online);
    scope.setIdentity(alice);
    const allowed = [IPC.CONTACTS.LIST_FOR_MATCH, IPC.INBOX.LIST, IPC.INBOX.GET_BODY, IPC.HISTORY.LIST, IPC.TEMPLATES.UPSERT,
      IPC.SYSTEM.UPDATE_CONFIG, IPC.SEND.CAMPAIGN_UPDATE_DRAFT];
    for (const channel of allowed) {
      const handler = vi.fn(() => 'local');
      expect(await scope.guard(handler, channel)()).toBe('local');
      expect(handler).toHaveBeenCalledOnce();
    }
    const denied = [IPC.SEND.START, IPC.SEND.TEST, IPC.SEND.RESUME_INTERRUPTED_BATCH,
      IPC.SEND.CAMPAIGN_CREATE, IPC.SEND.CAMPAIGN_CONTROL, IPC.INBOX.FETCH, IPC.CONTACTS.UPSERT,
      IPC.CRM.ADD_NOTE, IPC.AGENT.CHAT, IPC.AGENT.RUN_ACTION, IPC.AGENT.RESOLVE_APPROVAL,
      IPC.AI.PROFILE_TEST, IPC.AI.GENERATE_DRAFT, IPC.RATES.OPTIONS, IPC.KB.DISPATCH, 'inbox:newRead', undefined];
    for (const channel of denied) {
      const handler = vi.fn();
      expect(await scope.guard(handler, channel)()).toMatchObject({ success: false, code: 'UNAVAILABLE' });
      expect(handler).not.toHaveBeenCalled();
    }
    online = true;
    expect(await scope.guard(() => 'online', IPC.SEND.START)()).toBe('online');
    online = false;
    active = null; // Expired/revoked offline authority cannot expose even cached mail.
    expect(await scope.guard(() => 'private', IPC.INBOX.LIST)()).toMatchObject({ success: false });
    active = bob;
    expect(await scope.guard(() => 'private', IPC.INBOX.LIST)()).toMatchObject({ success: false });
    scope.setIdentity(null);
    expect(await scope.guard(() => 'private', IPC.INBOX.LIST)()).toMatchObject({ code: 'UNAUTHORIZED' });
  });
  it('uses stable opaque account roots and separates users and centers', () => {
    const parent = root();
    const first = accountProfileRoot(parent, alice);
    expect(accountProfileRoot(parent, { ...alice })).toBe(first);
    expect(accountProfileRoot(parent, bob)).not.toBe(first);
    expect(accountProfileRoot(parent, { ...alice, baseUrl: 'http://another-center' })).not.toBe(first);
    expect(path.dirname(first)).toBe(path.join(parent, 'accounts'));
    expect(first).not.toContain(alice.userId);
    const scope = new DesktopLocalScope(first, true);
    scope.setIdentity(alice);
    expect(scope.allowed()).toBe(true);
    scope.setIdentity(bob);
    expect(scope.allowed()).toBe(false);
  });
  it('locks local calls as soon as the global authority disappears, before restart observers run',async()=>{
    let active:typeof alice|null=alice;const scope=new DesktopLocalScope(root(),true,()=>active);scope.setIdentity(alice);
    expect(scope.allowed()).toBe(true);active=null;expect(scope.allowed()).toBe(false);
    const handler=vi.fn();expect(await scope.guard(handler)()).toMatchObject({success:false});expect(handler).not.toHaveBeenCalled();
  });
  it('never infers an old anonymous database owner from a successful login', async () => {
    const profile = root();
    fs.mkdirSync(path.join(profile, 'data'));
    const db = path.join(profile, 'data', 'prospector.db');
    fs.writeFileSync(db, 'synthetic legacy data');
    const before = fs.readFileSync(db);
    const scope = new DesktopLocalScope(profile, true);
    const localRead = vi.fn(() => 'must not run');
    scope.setIdentity(alice);
    expect(await scope.guard(localRead)()).toMatchObject({ success: false, code: 'FORBIDDEN' });
    expect(localRead).not.toHaveBeenCalled();
    expect(fs.readFileSync(db)).toEqual(before);
    expect(fs.existsSync(path.join(profile, 'desktop-local-binding.json'))).toBe(false);
  });

  it('keeps even empty normal profiles locked pending explicit R2 mapping', () => {
    const scope = new DesktopLocalScope(root(), false);
    scope.setIdentity(alice);
    expect(scope.allowed()).toBe(false);
  });

  it('binds only explicitly fresh developer data to one center and one user across restart', () => {
    const profile = root();
    const scope = new DesktopLocalScope(profile, true);
    expect(scope.failure().code).toBe('UNAUTHORIZED');
    scope.setIdentity(alice);
    expect(scope.allowed()).toBe(true);
    fs.mkdirSync(path.join(profile, 'data'));
    fs.writeFileSync(path.join(profile, 'data', 'prospector.db'), 'synthetic alice database');
    const restarted = new DesktopLocalScope(profile, true);
    restarted.setIdentity(bob);
    expect(restarted.allowed()).toBe(false);
    restarted.setIdentity({ ...alice, baseUrl: 'http://127.0.0.1:55845' });
    expect(restarted.allowed()).toBe(false);
    restarted.setIdentity(alice);
    expect(restarted.allowed()).toBe(true);
    restarted.setIdentity(null);
    expect(restarted.allowed()).toBe(false);
  });

  it('blocks a stale successful result after logout or account switch', async () => {
    const scope = new DesktopLocalScope(root(), true);
    scope.setIdentity(alice);
    let finish!: (value: string) => void;
    const pending = scope.guard(() => new Promise<string>(resolve => { finish = resolve; }))();
    scope.setIdentity(bob);
    finish('alice private result');
    expect(await pending).toMatchObject({ success: false, code: 'FORBIDDEN' });
  });

  it('does not let a fresh marker adopt data added before the first authenticated login', () => {
    const profile = root();
    const scope = new DesktopLocalScope(profile, true);
    fs.mkdirSync(path.join(profile, 'send'));
    fs.writeFileSync(path.join(profile, 'send', 'config.json'), '{}');
    scope.setIdentity(alice);
    expect(scope.allowed()).toBe(false);
  });

  it('keeps in-flight work valid when a status poll confirms the same identity', async () => {
    const scope = new DesktopLocalScope(root(), true);
    scope.setIdentity(alice);
    let finish!: (value: string) => void;
    const pending = scope.guard(() => new Promise<string>(resolve => { finish = resolve; }))();
    scope.setIdentity({ ...alice });
    finish('same user result');
    expect(await pending).toBe('same user result');
  });

  it('locks malformed binding metadata without rewriting it', () => {
    const profile = root();
    const file = path.join(profile, 'desktop-local-binding.json');
    fs.writeFileSync(file, '{broken');
    const scope = new DesktopLocalScope(profile, true);
    scope.setIdentity(alice);
    expect(scope.allowed()).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
  });

  it('isolates developer roots and ignores their override in packaged clients', () => {
    const first = root();
    const second = root();
    expect(developerProfileRoot(first, false)).toBe(path.resolve(first));
    expect(developerProfileRoot(second, false)).not.toBe(developerProfileRoot(first, false));
    expect(developerProfileRoot(first, true)).toBeNull();
    expect(() => developerProfileRoot('relative-profile', false)).toThrow('绝对路径');
  });
});
