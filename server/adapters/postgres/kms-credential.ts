import { createHash, randomInt } from 'node:crypto';

const KMS_SALT = 'default_salt';
const KMS_RANDOM_ALPHABET = '1234567890!@#$%^&*()_+=-';
const KMS_RANDOM_LENGTH = 6;

export type PostgresKmsCredential = { username: string; password: string };
export type KmsRequest = (
  input: string,
  init: RequestInit,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function postgresKmsSecretName(env: NodeJS.ProcessEnv): string {
  return text(env.PROSPECTOR_CENTER_PG_KMS_SECRET) || text(env['postgres.password']);
}

function randomNonce(): string {
  let value = '';
  for (let index = 0; index < KMS_RANDOM_LENGTH; index += 1) {
    value += KMS_RANDOM_ALPHABET[randomInt(KMS_RANDOM_ALPHABET.length)];
  }
  return value;
}

function credentialFromSecret(raw: string): PostgresKmsCredential {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error('中心数据库 KMS 凭据无效'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('中心数据库 KMS 凭据无效');
  }
  const record = value as Record<string, unknown>;
  const username = text(record.AccountName) || text(record.username);
  const password = text(record.AccountPassword) || text(record.password);
  if (!username || !password) throw new Error('中心数据库 KMS 凭据无效');
  return { username, password };
}

export async function resolvePostgresKmsCredential(
  env: NodeJS.ProcessEnv = process.env,
  request: KmsRequest = (input, init) => fetch(input, init),
): Promise<PostgresKmsCredential> {
  const secretName = postgresKmsSecretName(env);
  const cluster = text(env.YQN_APOLLO_CLUSTER);
  const appId = text(env.YQN_APOLLO_APP_ID) || text(env.APP_PORT);
  if (!secretName || !/^[a-z0-9][a-z0-9-]{0,62}$/i.test(cluster) || !/^\d{1,10}$/.test(appId)) {
    throw new Error('中心数据库 KMS 配置不完整');
  }

  const timestamp = String(Date.now());
  const random = randomNonce();
  const sign = createHash('sha256')
    .update([appId, cluster, timestamp, random, KMS_SALT].join('|'))
    .digest('base64');
  const endpoint = `http://42069.${cluster}.yqn.corp:42069/aliyun/kms/secret`;

  let response: Awaited<ReturnType<KmsRequest>>;
  let body: unknown;
  try {
    response = await request(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        header: {},
        model: { secretName, env: cluster, appId, timestamp, random, sign },
      }),
    });
    body = await response.json();
  } catch {
    throw new Error('中心数据库 KMS 请求失败');
  }
  if (!response.ok || !body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('中心数据库 KMS 请求失败');
  }
  const result = body as Record<string, unknown>;
  const data = result.data;
  if (result.code !== 200 || !data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('中心数据库 KMS 请求失败');
  }
  const secretValue = text((data as Record<string, unknown>).secretValue);
  if (!secretValue) throw new Error('中心数据库 KMS 凭据无效');
  return credentialFromSecret(secretValue);
}
