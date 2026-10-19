import { scrypt, pbkdf2, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import type { PasswordPort, TokenPort } from "../core/auth";

// OWASP scrypt option N=2^17, r=8, p=1; Node default maxmem is too small for it.
export const PASSWORD_PARAMETERS = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } as const;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const TOKEN_BYTES = 32;
const HASH_PREFIX = "scrypt-v1$131072$8$1";
const HASH_PATTERN = /^scrypt-v1\$131072\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{64})$/;
const LEGACY_HASH_PATTERN = /^pbkdf2_sha256\$(\d+)\$([a-f0-9]{32})\$([a-f0-9]{64})$/;
const LEGACY_HASH_BYTES = 32;
const LEGACY_HASH_DIGEST = "sha256";
const LEGACY_MIN_ITERATIONS = 100000;
const LEGACY_MAX_ITERATIONS = 1000000;
export class PasswordAdapter implements PasswordPort {
  private active = 0;
  private dummyHash = "";
  constructor(private readonly maxConcurrent: number) {}
  async initialize() { this.dummyHash = await this.hash(randomBytes(TOKEN_BYTES).toString("hex")); }
  private async derive(password: string, salt: Buffer): Promise<Buffer> {
    if(this.active >= this.maxConcurrent) throw new Error("密码校验并发已满");
    this.active++;
    try { return await new Promise<Buffer>((resolve,reject) => scrypt(password,salt,HASH_BYTES,PASSWORD_PARAMETERS,(error,key) => error ? reject(error) : resolve(key))); }
    finally { this.active--; }
  }
  private async deriveLegacy(password: string, salt: string, iterations: number): Promise<Buffer> {
    if(this.active >= this.maxConcurrent) throw new Error("密码校验并发已满");
    this.active++;
    try {
      return await new Promise<Buffer>((resolve, reject) => pbkdf2(password, salt, iterations, LEGACY_HASH_BYTES, LEGACY_HASH_DIGEST,
        (error, key) => error ? reject(error) : resolve(key)));
    } finally { this.active--; }
  }
  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES), key = await this.derive(password,salt);
    return `${HASH_PREFIX}$${salt.toString("hex")}$${key.toString("hex")}`;
  }
  async verify(password: string, hash: string): Promise<boolean> {
    const match = HASH_PATTERN.exec(hash);
    if(match) {
      const actual = await this.derive(password,Buffer.from(match[1]!,"hex"));
      return timingSafeEqual(actual,Buffer.from(match[2]!,"hex"));
    }
    const legacy = LEGACY_HASH_PATTERN.exec(hash);
    if(legacy) {
      const iterations = Number(legacy[1]);
      if(!Number.isSafeInteger(iterations) || iterations < LEGACY_MIN_ITERATIONS || iterations > LEGACY_MAX_ITERATIONS) return false;
      const actual = await this.deriveLegacy(password,legacy[2]!,iterations);
      return timingSafeEqual(actual,Buffer.from(legacy[3]!,"hex"));
    }
    if(!HASH_PATTERN.exec(this.dummyHash)) throw new Error("密码校验器未初始化");
    await this.derive(password,Buffer.alloc(SALT_BYTES));
    return false;
  }
}
export const tokenAdapter: TokenPort = {
  create: () => randomBytes(TOKEN_BYTES).toString("base64url"),
  hash: token => createHash("sha256").update(token).digest("hex"),
};
