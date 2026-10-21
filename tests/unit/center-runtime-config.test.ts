import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  assertCenterDatabasePool,
  readOnlineDatabaseConfig,
  readProductionDatabaseConfig,
  readTestDatabaseConfig,
} from '../../server/adapters/postgres/config';
import { readOnlineConfig, onlineRuntimeDirectory } from '../../server/adapters/online-config';

const PRODUCTION_DSN = 'postgresql://milogin_app:example-password@127.0.0.1:55846/milogin_center';

describe('center database environment boundary', () => {
  it('keeps the isolated test database as the default', () => {
    expect(readOnlineDatabaseConfig({})).toMatchObject(readTestDatabaseConfig());
    const pool = new Pool(readTestDatabaseConfig());
    expect(() => assertCenterDatabasePool(pool, {})).not.toThrow();
    void pool.end();
  });

  it('requires a separate local application database for production', () => {
    expect(() => readProductionDatabaseConfig({})).toThrow();
    expect(readProductionDatabaseConfig({ PROSPECTOR_CENTER_PG_DSN: PRODUCTION_DSN.replace(':55846/', ':5432/') }))
      .toMatchObject({ host: '127.0.0.1', port: 5432, database: 'milogin_center', user: 'milogin_app' });
    expect(() => readProductionDatabaseConfig({ PROSPECTOR_CENTER_PG_DSN: PRODUCTION_DSN.replace('milogin_center', 'prospector_crm_test') })).toThrow();
    expect(() => readProductionDatabaseConfig({ PROSPECTOR_CENTER_PG_DSN: PRODUCTION_DSN.replace('127.0.0.1', '192.168.1.8') })).toThrow();
    expect(readProductionDatabaseConfig({ PROSPECTOR_CENTER_PG_DSN: PRODUCTION_DSN })).toMatchObject({
      host: '127.0.0.1', port: 55846, database: 'milogin_center', user: 'milogin_app',
    });
  });

  it('rejects pools from the wrong environment and unknown modes', async () => {
    const env = { PROSPECTOR_CENTER_MODE: 'production', PROSPECTOR_CENTER_PG_DSN: PRODUCTION_DSN };
    const testPool = new Pool(readTestDatabaseConfig());
    const productionPool = new Pool(readOnlineDatabaseConfig(env));
    try {
      expect(() => assertCenterDatabasePool(testPool, env)).toThrow();
      expect(() => assertCenterDatabasePool(productionPool, {})).toThrow();
      expect(() => assertCenterDatabasePool(productionPool, env)).not.toThrow();
      expect(() => readOnlineDatabaseConfig({ PROSPECTOR_CENTER_MODE: 'prod' })).toThrow();
    } finally {
      await Promise.all([testPool.end(), productionPool.end()]);
    }
  });

  it('keeps production HTTP and signing state separate from the test node', () => {
    const env = { PROSPECTOR_CENTER_MODE: 'production', PROSPECTOR_CENTER_PUBLIC_ORIGIN: 'https://center.example.test', ProgramData: 'C:\\ProgramData' };
    expect(readOnlineConfig(env)).toMatchObject({ host: '127.0.0.1', port: 55847, test_mode: false, public_origin: 'https://center.example.test' });
    expect(onlineRuntimeDirectory(env)).not.toBe(onlineRuntimeDirectory({}));
    expect(() => readOnlineConfig({ PROSPECTOR_CENTER_MODE: 'production' })).toThrow();
    expect(() => readOnlineConfig({ ...env, PROSPECTOR_CENTER_PUBLIC_ORIGIN: 'http://center.example.test' })).toThrow();
    expect(readOnlineConfig({ ...env, PROSPECTOR_CENTER_PUBLIC_ORIGIN: 'http://127.0.0.1:55847', PROSPECTOR_CENTER_LOCAL_HTTP: '1' }))
      .toMatchObject({ host: '127.0.0.1', port: 55847, public_origin: 'http://127.0.0.1:55847', local_http: true });
    expect(() => readOnlineConfig({ ...env, PROSPECTOR_CENTER_PUBLIC_ORIGIN: 'http://127.0.0.1:55847' })).toThrow();
  });
});
