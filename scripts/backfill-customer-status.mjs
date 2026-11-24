import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(process.env.PROGRAMDATA || '', 'MiloginCenter');
const configPath = path.join(runtime, 'postgres.json');
if (!fs.existsSync(configPath)) throw new Error('本机中心数据库配置不存在');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const apply = process.argv.includes('--apply');
const customerIds = process.argv.filter(argument => argument.startsWith('--customer=')).map(argument => argument.slice('--customer='.length));
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
if (customerIds.some(id => !UUID.test(id))) throw new Error('--customer 必须是客户 UUID');

const pool = new pg.Pool({ host: config.host, port: config.port, user: config.app, password: config.appPassword, database: config.database, max: 1 });
try {
  const { backfillCustomerStatuses } = await import('../dist-server/adapters/postgres/customer-status-backfill.js');
  const result = await backfillCustomerStatuses(pool, { apply, ...(customerIds.length ? { customerIds } : {}) });
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  const reportPath = path.join(root, '.work', 'status-backfill-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(result.data, null, 2));
  process.stdout.write(JSON.stringify({ ok: true, apply, customers: result.data.customers, lockedCustomers: result.data.lockedCustomers, plannedEvents: result.data.plannedEvents, insertedEvents: result.data.insertedEvents, report: reportPath }, null, 2) + '\n');
} finally {
  await pool.end();
}
