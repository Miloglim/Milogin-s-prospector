import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { offlineLocalChannelAllowed } from '../core/offline-local-policy';

export interface DesktopIdentityScope { baseUrl: string; userId: string }
/** Opaque stable key includes center and immutable user ID, never email/password. */
export function accountProfileRoot(parent: string, identity: DesktopIdentityScope): string {
  const key = createHash('sha256').update(JSON.stringify([identity.baseUrl, identity.userId])).digest('hex');
  return path.join(parent, 'accounts', key);
}
interface ProfileBinding { version: 1; owner: DesktopIdentityScope | null }
export type LocalScopeFailure = { success: false; error: string; code: 'UNAUTHORIZED' | 'FORBIDDEN' | 'UNAVAILABLE' };
const BINDING_FILE = 'desktop-local-binding.json';
const PROFILE_VERSION = 1;
const PERSONAL_PATHS = ['data', 'send', 'outputs', 'backups', '.env'];
const DEVELOPMENT_PROFILE_DIRECTORY = 'prospecting-email-dev';

/** R1 never assigns an existing anonymous business store to the next login. */
export class DesktopLocalScope {
  private binding: ProfileBinding | null = null;
  private identity: DesktopIdentityScope | null = null;
  private readonly file: string;

  constructor(private readonly root: string, developerProfile: boolean, private readonly authority?:()=>DesktopIdentityScope|null,
    private readonly onlineReader: () => boolean = () => true) {
    this.file = path.join(root, BINDING_FILE);
    if (!developerProfile) return; // Anonymous legacy stores stay protected; center CRM needs no local unlock.
    if (fs.existsSync(this.file)) {
      try {
        const value: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (this.isBinding(value)) this.binding = value;
      } catch { /* Malformed ownership metadata fails closed; never rewrite it. */ }
      return;
    }
    // Any pre-existing personal store or credentials means this is not a fresh profile.
    if (PERSONAL_PATHS.some(relative => fs.existsSync(path.join(root, relative)))) return;
    fs.mkdirSync(root, { recursive: true });
    this.binding = { version: PROFILE_VERSION, owner: null };
    this.persist();
  }

  private isBinding(value: unknown): value is ProfileBinding {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as ProfileBinding;
    return candidate.version === PROFILE_VERSION && (candidate.owner === null || (
      typeof candidate.owner?.baseUrl === 'string' && !!candidate.owner.baseUrl &&
      typeof candidate.owner?.userId === 'string' && !!candidate.owner.userId));
  }

  private persist(): void {
    // Contains only center identity metadata, never bearer/refresh tokens or credentials.
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.binding), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }

  setIdentity(identity: DesktopIdentityScope | null): void {
    if (this.identity?.baseUrl !== identity?.baseUrl || this.identity?.userId !== identity?.userId) {
      this.identity = identity ? { ...identity } : null;
    }
    if (identity && this.binding && !this.binding.owner) {
      // A fresh marker must not legitimize business data added outside this process.
      if (PERSONAL_PATHS.some(relative => fs.existsSync(path.join(this.root, relative)))) {
        this.binding = null;
        return;
      }
      this.binding.owner = { ...identity };
      try { this.persist(); }
      catch (error) { this.binding = null; throw error; } // A failed durable binding never unlocks local data.
    }
  }

  allowed(): boolean {
    const owner = this.binding?.owner;
    const current=this.authority?this.authority():this.identity;
    return !!owner && !!this.identity && !!current && owner.baseUrl === this.identity.baseUrl && owner.userId === this.identity.userId
      && current.baseUrl===owner.baseUrl && current.userId===owner.userId;
  }

  failure(): LocalScopeFailure {
    return this.identity
      ? { success: false, code: 'FORBIDDEN', error: '此本地功能暂未开放。' }
      : { success: false, code: 'UNAUTHORIZED', error: '请先登录中心账号。' };
  }

  /** Check before invocation and after await so an old identity cannot deliver late data. */
  guard<TArgs extends unknown[], TResult>(handler: (...args: TArgs) => TResult, channel?: string) {
    return async (...args: TArgs): Promise<Awaited<TResult> | LocalScopeFailure> => {
      if (!this.allowed()) return this.failure();
      if (!this.onlineReader() && !offlineLocalChannelAllowed(channel)) {
        return { success: false, code: 'UNAVAILABLE', error: '当前离线，此操作需要连接中心。' };
      }
      const identity = this.identity;
      const result = await handler(...args);
      if (identity !== this.identity || !this.allowed()) return this.failure();
      return result;
    };
  }
}

/** The environment override is explicitly development-only and never interpreted as a relative path. */
export function developerProfileRoot(value: string | undefined, packaged: boolean): string | null {
  if (packaged || !value) return null;
  if (!path.isAbsolute(value)) throw new Error('PROSPECTOR_DEV_PROFILE 必须是绝对路径');
  return path.resolve(value);
}

/** Development clients must never share Electron storage with an installed client. */
export function developmentUserDataRoot(explicitRoot: string | null, packaged: boolean, appData: string): string | null {
  if (packaged) return null;
  return explicitRoot ?? path.join(appData, DEVELOPMENT_PROFILE_DIRECTORY);
}
