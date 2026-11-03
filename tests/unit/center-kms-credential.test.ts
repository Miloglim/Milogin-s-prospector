import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { resolvePostgresKmsCredential } from '../../server/adapters/postgres/kms-credential';
import { assertCenterDatabasePool, resolveOnlineDatabaseConfig } from '../../server/adapters/postgres/config';

const ENV = {
  PROSPECTOR_CENTER_MODE: 'production',
  PROSPECTOR_CENTER_PG_HOST: 'pgm-example.pg.rds.aliyuncs.com',
  PROSPECTOR_CENTER_PG_PORT: '5432',
  PROSPECTOR_CENTER_PG_USER: 'stale-user',
  PROSPECTOR_CENTER_PG_PASSWORD: 'stale-password',
  YQN_APOLLO_CLUSTER: 'qa4',
  YQN_APOLLO_APP_ID: '22124',
  'postgres.password': 'pg-data.qax.root',
} as NodeJS.ProcessEnv;

function kmsResponse(secretValue: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ code: 200, data: { secretValue } }),
  };
}

describe('center PostgreSQL KMS credential', () => {
  it('resolves the Apollo secret name through the QA4 KMS endpoint', async () => {
    const request = vi.fn(async () => kmsResponse(JSON.stringify({
      AccountName: 'yqnroot',
      AccountPassword: 'resolved-password',
    })));

    const credential = await resolvePostgresKmsCredential(ENV, request);

    expect(credential).toEqual({ username: 'yqnroot', password: 'resolved-password' });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toBe('http://42069.qa4.yqn.corp:42069/aliyun/kms/secret');
    const body = JSON.parse(String(request.mock.calls[0]?.[1]?.body));
    expect(body.model).toMatchObject({ secretName: 'pg-data.qax.root', env: 'qa4', appId: '22124' });
    expect(body.model.sign).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it('uses the KMS username and password for the fixed production database', async () => {
    const load = vi.fn(async () => ({ username: 'yqnroot', password: 'resolved-password' }));

    const config = await resolveOnlineDatabaseConfig(ENV, load);

    expect(load).toHaveBeenCalledWith(ENV);
    expect(config).toMatchObject({
      host: 'pgm-example.pg.rds.aliyuncs.com',
      port: 5432,
      database: 'milogin_center',
      user: 'yqnroot',
      password: 'resolved-password',
      application_name: 'prospector-center',
      options: '-c search_path=prospector,public',
    });
  });

  it('uses an environment-safe KMS key when Apollo filters dotted keys', async () => {
    const env = {
      ...ENV,
      'postgres.password': undefined,
      PROSPECTOR_CENTER_PG_KMS_SECRET: 'pg-data.qax.root',
      PROSPECTOR_CENTER_PG_PASSWORD: undefined,
    };
    const load = vi.fn(async () => ({ username: 'yqnroot', password: 'resolved-password' }));

    const config = await resolveOnlineDatabaseConfig(env, load);

    expect(load).toHaveBeenCalledWith(env);
    expect(config).toMatchObject({ database: 'milogin_center', user: 'yqnroot' });
  });

  it('accepts the KMS-resolved pool without a legacy plaintext password', async () => {
    const env = {
      ...ENV,
      PROSPECTOR_CENTER_PG_PASSWORD: undefined,
      PROSPECTOR_CENTER_PG_USER: undefined,
    };
    const config = await resolveOnlineDatabaseConfig(env, async () => ({
      username: 'yqnroot',
      password: 'resolved-password',
    }));
    const pool = { options: config } as Pool;

    expect(() => assertCenterDatabasePool(pool, env)).not.toThrow();
  });

  it('fails without exposing the KMS secret name', async () => {
    const request = vi.fn(async () => kmsResponse(JSON.stringify({ AccountName: 'yqnroot' })));

    await expect(resolvePostgresKmsCredential(ENV, request)).rejects.toThrow('中心数据库 KMS 凭据无效');
    await expect(resolvePostgresKmsCredential(ENV, request)).rejects.not.toThrow('pg-data.qax.root');
  });

  it('rejects invalid KMS routing metadata before making a request', async () => {
    const request = vi.fn(async () => kmsResponse(JSON.stringify({
      AccountName: 'yqnroot',
      AccountPassword: 'resolved-password',
    })));

    await expect(resolvePostgresKmsCredential({
      ...ENV,
      YQN_APOLLO_CLUSTER: 'qa4/other-host',
    }, request)).rejects.toThrow('中心数据库 KMS 配置不完整');
    expect(request).not.toHaveBeenCalled();
  });
});
