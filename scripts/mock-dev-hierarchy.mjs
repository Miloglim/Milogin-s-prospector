import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { PasswordAdapter } from '../dist-server/adapters/password.js';
import { capabilitiesFor } from '../dist-server/core/admin.js';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');
const { buildSync } = require('esbuild');

if (!process.versions.electron) {
  const executable = path.resolve('node_modules/electron/dist/electron.exe');
  if (!fs.existsSync(executable)) fail('找不到项目 Electron，无法使用匹配 ABI 创建本地 Mock 资料');
  const result = spawnSync(executable, [process.argv[1], ...process.argv.slice(2)], {
    cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', windowsHide: true,
  });
  process.exit(result.status ?? 1);
}

const Constructor = require('better-sqlite3');

const DEV_CONFIG = 'C:/ProgramData/MiloginCenter/postgres.json';
const DEV_BASE_URL = 'http://127.0.0.1:55847';
const DEV_DATABASE = 'milogin_center';
const DEV_PORT = 55846;
const ADMIN_EMAIL = 'admin@yqn.com';
const MOCK_EMAIL_PREFIX = 'mock.hierarchy.';
const MOCK_SOURCE = 'mock-dev-hierarchy-20261029';
const CRM_SCHEMA = process.env.PROSPECTOR_MOCK_CRM_SCHEMA || 'public';
if (!/^[a-z_][a-z0-9_]*$/i.test(CRM_SCHEMA)) fail('PROSPECTOR_MOCK_CRM_SCHEMA 不是合法 schema 名称');
const crmTable = table => `${CRM_SCHEMA}.${table}`;
const RETIRED_ORG_UNIT_NAMES = ['Mock 渠道运营中心'];
const ACCOUNT_PROFILE_DIRECTORY = 'prospecting-email-dev';
const MANIFEST = path.resolve('.work/mock-dev-hierarchy/manifest.json');
const SCHEMA_BUNDLE = path.resolve('.work/mock-dev-hierarchy/schema.cjs');
const DAY_MS = 86_400_000;
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 128;
const STATEMENT_TIMEOUT_MS = 30_000;
const REQUIRED_MIGRATION_VERSIONS = [
  '051-team-foundation-public',
  '052-team-tree-public',
  '053-org-supervision-public',
  '054-team-organization-public',
  '054a-legacy-organization-repair',
  '055-organization-canonical',
  '056-organization-assignment-integrity',
  '057-contact-assignment-state',
  '058-lead-ingress-conflict',
  '059-contact-mail-analysis',
  '060-team-attention-task-gating',
  '061-team-monitoring',
  '062-sales-performance-customer-grade',
  '063-public-outbox-fk-repair',
  '064-organization-dissolution',
];

const ACCOUNTS = [
  { key: 'operations', email: 'mock.hierarchy.ops@yqn.com', displayName: 'Mock 管理员', role: 'operations' },
  { key: 'operationsSecondary', email: 'mock.hierarchy.ops.second@yqn.com', displayName: 'Mock 管理员二', role: 'operations' },
  { key: 'supervisorEast', email: 'mock.hierarchy.supervisor.east@yqn.com', displayName: 'Mock 华东主管', role: 'sales' },
  { key: 'supervisorSouth', email: 'mock.hierarchy.supervisor.south@yqn.com', displayName: 'Mock 华南主管', role: 'sales' },
  { key: 'memberAnna', email: 'mock.hierarchy.member.anna@yqn.com', displayName: 'Mock 成员 Anna', role: 'sales' },
  { key: 'memberBen', email: 'mock.hierarchy.member.ben@yqn.com', displayName: 'Mock 成员 Ben', role: 'sales' },
  { key: 'memberCara', email: 'mock.hierarchy.member.cara@yqn.com', displayName: 'Mock 成员 Cara', role: 'sales' },
];

const TEAMS = [
  { key: 'company', name: 'Milogin', kind: 'company', parent: null, leaders: [], members: [] },
  { key: 'operations', name: 'Mock 运营中心', kind: 'operations_group', parent: 'company', leaders: ['operations', 'operationsSecondary'], members: [] },
  { key: 'east', name: 'Mock 华东销售组', kind: 'sales_team', parent: 'operations', leaders: ['supervisorEast'], members: ['memberAnna', 'memberBen'] },
  { key: 'south', name: 'Mock 华南销售组', kind: 'sales_team', parent: 'operations', leaders: ['supervisorSouth'], members: ['memberCara'] },
];

const LEADS = [
  {
    key: 'online-replied', origin: 'operations', owner: 'supervisorEast', createdBy: 'operations', state: 'owned',
    company: { name: 'Mock Atlas Foods', domain: 'atlas-foods.mock', industry: 'Food importer', country: 'Netherlands' },
    contact: { firstName: 'Marta', lastName: 'Vos', title: 'Import Manager', email: 'marta.vos@atlas-foods.mock', stage: 'f2', touch: 'replied' },
    relationshipStage: 'quoting', sourceDetail: '线上线索 / 中心邮件往来', mails: ['sent', 'replied'],
  },
  {
    key: 'online-contacted', origin: 'operations', owner: 'memberAnna', createdBy: 'operations', state: 'owned',
    company: { name: 'Mock Nordic Freight', domain: 'nordic-freight.mock', industry: 'Forwarder', country: 'Norway' },
    contact: { firstName: 'Jonas', lastName: 'Berg', title: 'Operations Lead', email: 'jonas.berg@nordic-freight.mock', stage: 'f1', touch: 'contacted' },
    relationshipStage: 'reaching', sourceDetail: '线上线索 / 首次邮件已发', mails: [
      'sent',
      { kind: 'replied', subject: 'Mock quote request and sailing schedule', preview: 'Please quote 2x40HQ from Ningbo to Rotterdam and confirm the next sailing.' },
    ],
  },
  {
    key: 'online-pool', origin: 'operations', owner: null, createdBy: 'operations', state: 'published',
    company: { name: 'Mock Rhine Parts', domain: 'rhine-parts.mock', industry: 'Auto parts', country: 'Germany' },
    contact: { firstName: 'Lena', lastName: 'Fischer', title: 'Procurement', email: 'lena.fischer@rhine-parts.mock', stage: 'cold', touch: 'uncontacted' },
    relationshipStage: 'cold', sourceDetail: '线上线索 / 待领取', mails: [],
  },
  {
    key: 'online-bounced', origin: 'operations', owner: 'supervisorSouth', createdBy: 'operations', state: 'owned',
    company: { name: 'Mock Pacific Cargo', domain: 'pacific-cargo.mock', industry: 'Freight forwarder', country: 'Singapore' },
    contact: { firstName: 'Diego', lastName: 'Tan', title: 'Commercial Manager', email: 'diego.tan@pacific-cargo.mock', stage: 'f1', touch: 'bounced' },
    relationshipStage: 'reaching', sourceDetail: '线上线索 / 退信待校正', mails: ['sent', 'bounced'],
  },
  {
    key: 'personal-replied', origin: 'personal', owner: 'supervisorEast', createdBy: 'supervisorEast', state: 'owned',
    company: { name: 'Mock BlueWave Logistics', domain: 'bluewave.mock', industry: 'Logistics', country: 'Spain' },
    contact: { firstName: 'Sofia', lastName: 'Lopez', title: 'Branch Manager', email: 'sofia.lopez@bluewave.mock', stage: 'f2', touch: 'replied' },
    relationshipStage: 'quoting', sourceDetail: '本地线索 / 主管自有沉淀', mails: ['sent', 'replied'],
  },
  {
    key: 'personal-autoreply', origin: 'personal', owner: 'memberAnna', createdBy: 'memberAnna', state: 'owned',
    company: { name: 'Mock Coral Import', domain: 'coral-import.mock', industry: 'Importer', country: 'Brazil' },
    contact: { firstName: 'Rafael', lastName: 'Souza', title: 'Buyer', email: 'rafael.souza@coral-import.mock', stage: 'f1', touch: 'autoreply' },
    relationshipStage: 'reaching', sourceDetail: '本地线索 / 成员自有沉淀', mails: ['sent', 'autoreply'],
  },
  {
    key: 'personal-contacted', origin: 'personal', owner: 'memberBen', createdBy: 'memberBen', state: 'owned',
    company: { name: 'Mock Maple Components', domain: 'maple-components.mock', industry: 'Manufacturing', country: 'Canada' },
    contact: { firstName: 'Chloe', lastName: 'Martin', title: 'Supply Chain', email: 'chloe.martin@maple-components.mock', stage: 'f1', touch: 'contacted' },
    relationshipStage: 'reaching', sourceDetail: '本地线索 / 成员自有沉淀', mails: [
      'sent',
      { kind: 'received', subject: 'Internal route digest', preview: 'Internal mock operations digest.', fromEmail: 'mock.hierarchy.member.ben@yqn.com' },
      { kind: 'received', subject: 'Exclusive cargo leads newsletter', preview: 'Bulk marketing message.', fromEmail: 'offers@bulk-mailer.mock' },
    ],
  },
  {
    key: 'personal-uncontacted', origin: 'personal', owner: 'memberCara', createdBy: 'memberCara', state: 'owned',
    company: { name: 'Mock Orchid Trading', domain: 'orchid-trading.mock', industry: 'Trading', country: 'Malaysia' },
    contact: { firstName: 'Mei', lastName: 'Lim', title: 'Director', email: 'mei.lim@orchid-trading.mock', stage: 'cold', touch: 'uncontacted' },
    relationshipStage: 'cold', sourceDetail: '本地线索 / 尚未触达', mails: [],
  },
  {
    key: 'cp2-accepted', origin: 'operations', owner: 'memberAnna', createdBy: 'operations', state: 'owned',
    company: { name: 'Mock Harbor Textiles', domain: 'harbor-textiles.mock', industry: 'Textiles', country: 'Vietnam' },
    contact: { firstName: 'Linh', lastName: 'Nguyen', title: 'Export Manager', email: 'linh.nguyen@harbor-textiles.mock', stage: 'f1', touch: 'contacted' },
    relationshipStage: 'reaching', sourceDetail: '线上线索 / 已接受分配', mails: ['sent'],
  },
  {
    key: 'cp2-expired', origin: 'operations', owner: null, createdBy: 'operations', state: 'published',
    company: { name: 'Mock Cedar Home', domain: 'cedar-home.mock', industry: 'Home goods', country: 'Sweden' },
    contact: { firstName: 'Erik', lastName: 'Nilsson', title: 'Buyer', email: 'erik.nilsson@cedar-home.mock', stage: 'cold', touch: 'uncontacted' },
    relationshipStage: 'cold', sourceDetail: '线上线索 / 已过期分配', mails: [],
  },
  ...Array.from({ length: 5 }, (_, index) => ({
    key: `cp7-won-${index + 1}`,
    origin: 'operations',
    owner: 'memberAnna',
    createdBy: 'operations',
    state: 'owned',
    company: {
      name: `Mock Journey ${index + 1}`,
      domain: `journey-${index + 1}.mock`,
      industry: 'Freight buyer',
      country: ['Italy', 'France', 'Poland', 'Portugal', 'Greece'][index],
    },
    contact: {
      firstName: ['Giulia', 'Hugo', 'Ola', 'Rui', 'Eleni'][index],
      lastName: ['Conti', 'Bernard', 'Nowak', 'Costa', 'Papadaki'][index],
      title: 'Logistics Manager',
      email: `buyer${index + 1}@journey-${index + 1}.mock`,
      stage: 'f3',
      touch: 'replied',
    },
    relationshipStage: 'cooperating',
    sourceDetail: `线上线索 / CP7 有效成交 ${index + 1}`,
    mails: ['sent', 'replied'],
    won: true,
  })),
];

function log(level, message) {
  process.stdout.write(`[${new Date().toISOString()}] [${level}] [mock.hierarchy] ${message}\n`);
}

function fail(message) {
  throw new Error(message);
}

function assertDevConfig(config) {
  if (config.marker !== 'milogin-center-postgres-v1' || config.host !== '127.0.0.1'
    || config.port !== DEV_PORT || config.database !== DEV_DATABASE || config.app !== 'milogin_app') {
    fail('开发中心数据库配置不匹配，拒绝执行');
  }
}

function readConfig() {
  const config = JSON.parse(fs.readFileSync(DEV_CONFIG, 'utf8'));
  assertDevConfig(config);
  return config;
}

function userDataRoot() {
  const argument = process.argv.find(value => value.startsWith('--user-data='));
  const root = argument ? path.resolve(argument.slice('--user-data='.length))
    : path.join(process.env.APPDATA || '', ACCOUNT_PROFILE_DIRECTORY);
  if (!process.env.APPDATA && !argument) fail('无法确定开发端 userData，请传入 --user-data');
  return root;
}

function profileRoot(baseUrl, userId) {
  const key = createHash('sha256').update(JSON.stringify([baseUrl, userId])).digest('hex');
  return path.join(userDataRoot(), 'accounts', key);
}

function passwordValue() {
  const value = process.env.PROSPECTOR_MOCK_PASSWORD || '';
  if (value.length < PASSWORD_MIN || value.length > PASSWORD_MAX || !/^[A-Za-z0-9]+$/.test(value)) {
    fail('请通过 PROSPECTOR_MOCK_PASSWORD 提供仅含字母数字的临时密码');
  }
  return value;
}

function iso(offsetDays, hour = 10) {
  const value = new Date();
  value.setHours(hour, 0, 0, 0);
  value.setTime(value.getTime() + offsetDays * DAY_MS);
  return value.toISOString();
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function accountMap(rows) {
  return new Map(rows.map(row => [row.key, row]));
}

function teamIdMap(rows) {
  return new Map(rows.map(row => [row.key, row.teamId]));
}

async function findAdmin(client) {
  const result = await client.query(`SELECT u.user_id AS "userId",e.email,u.display_name AS "displayName"
    FROM public.identity_users u JOIN public.identity_login_emails e USING(user_id)
    WHERE e.email=$1 AND u.active AND u.identity_admin AND u.deleted_at IS NULL FOR SHARE OF u`, [ADMIN_EMAIL]);
  if (result.rowCount !== 1) fail('找不到指定的开发端超级管理员账号');
  return result.rows[0];
}

async function ensureAccount(client, spec, passwordHash) {
  const existing = await client.query(`SELECT u.user_id AS "userId" FROM public.identity_users u
    JOIN public.identity_login_emails e USING(user_id) WHERE e.email=$1 FOR UPDATE OF u,e`, [spec.email]);
  const userId = existing.rows[0]?.userId || randomUUID();
  if (existing.rowCount) {
    await client.query(`UPDATE public.identity_users SET display_name=$2,active=true,identity_admin=false,deleted_at=NULL,
      must_change_password=false,security_revision=security_revision+1,management_revision=management_revision+1
      WHERE user_id=$1`, [userId, spec.displayName]);
    await client.query('UPDATE public.identity_login_emails SET verified_at=now() WHERE user_id=$1', [userId]);
  } else {
    await client.query(`INSERT INTO public.identity_users(user_id,display_name,active,identity_admin,must_change_password)
      VALUES($1,$2,true,false,false)`, [userId, spec.displayName]);
    await client.query(`INSERT INTO public.identity_login_emails(user_id,email,verified_at) VALUES($1,$2,now())`, [userId, spec.email]);
  }
  await client.query(`INSERT INTO public.identity_credentials(user_id,password_hash,hash_scheme) VALUES($1,$2,'scrypt-v1')
    ON CONFLICT(user_id) DO UPDATE SET password_hash=EXCLUDED.password_hash,hash_scheme='scrypt-v1',changed_at=now()`, [userId, passwordHash]);
  await client.query("DELETE FROM public.identity_product_grants WHERE user_id=$1 AND product_id='crm'", [userId]);
  await client.query("INSERT INTO public.identity_product_grants(user_id,product_id,role,active) VALUES($1,'crm',$2,true)", [userId, spec.role]);
  const scope = spec.role === 'operations' ? 'shared' : 'own';
  await client.query(`INSERT INTO public.identity_product_access(user_id,product_id,active,scope,capabilities)
    VALUES($1,'crm',true,$2,$3::jsonb) ON CONFLICT(user_id,product_id) DO UPDATE SET active=true,scope=EXCLUDED.scope,capabilities=EXCLUDED.capabilities`,
  [userId, scope, JSON.stringify(capabilitiesFor([spec.role]))]);
  await client.query('UPDATE public.identity_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [userId]);
  return { ...spec, userId };
}

async function ensureTeams(client, accounts) {
  const ids = teamIdMap([]);
  const creatorId = accounts.get('operations').userId;
  const company = (await client.query(`SELECT unit_id AS "unitId" FROM ${CRM_SCHEMA}.crm_org_units
    WHERE kind='company' ORDER BY created_at,unit_id LIMIT 1 FOR UPDATE`)).rows[0];
  const companyId = company?.unitId || randomUUID();
  if (!company) {
    await client.query(`INSERT INTO ${CRM_SCHEMA}.crm_org_units(unit_id,kind,parent_unit_id,name,created_by)
      VALUES($1,'company',NULL,$2,NULL)`, [companyId, TEAMS.find(team => team.key === 'company').name]);
  }
  ids.set('company', companyId);
  for (const team of TEAMS.filter(item => item.kind !== 'company')) {
    const parentId = team.parent ? ids.get(team.parent) : null;
    if (team.parent && !parentId) fail(`团队父节点不存在: ${team.parent}`);
    const existing = await client.query(`SELECT unit_id AS "teamId" FROM ${CRM_SCHEMA}.crm_org_units
      WHERE parent_unit_id IS NOT DISTINCT FROM $1::uuid AND lower(btrim(name))=lower(btrim($2)) FOR UPDATE`, [parentId, team.name]);
    const teamId = existing.rows[0]?.teamId || randomUUID();
    if (existing.rowCount) {
      await client.query(`UPDATE ${CRM_SCHEMA}.crm_org_units SET kind=$2,created_by=$3,version=version+1,updated_at=now() WHERE unit_id=$1`,
        [teamId, team.kind, creatorId]);
    } else {
      await client.query(`INSERT INTO ${CRM_SCHEMA}.crm_org_units(unit_id,kind,parent_unit_id,name,created_by)
        VALUES($1,$2,$3,$4,$5)`, [teamId, team.kind, parentId, team.name, creatorId]);
    }
    ids.set(team.key, teamId);
  }
  const unitIds = TEAMS.filter(team => team.kind !== 'company').map(team => ids.get(team.key));
  if (unitIds.length) {
    await client.query(`DELETE FROM ${CRM_SCHEMA}.crm_org_member_group_members WHERE unit_id=ANY($1::uuid[])`, [unitIds]);
    await client.query(`DELETE FROM ${CRM_SCHEMA}.crm_org_member_groups WHERE unit_id=ANY($1::uuid[])`, [unitIds]);
    await client.query(`DELETE FROM ${CRM_SCHEMA}.crm_org_invitations WHERE unit_id=ANY($1::uuid[])`, [unitIds]);
    await client.query(`DELETE FROM ${CRM_SCHEMA}.crm_org_assignments WHERE unit_id=ANY($1::uuid[])`, [unitIds]);
  }
  for (const team of TEAMS.filter(item => item.kind !== 'company')) {
    const teamId = ids.get(team.key);
    for (const [index, leaderKey] of team.leaders.entries()) {
      await client.query(`INSERT INTO ${CRM_SCHEMA}.crm_org_assignments(user_id,unit_id,role,is_primary)
        VALUES($1,$2,'leader',$3)`, [accounts.get(leaderKey).userId, teamId, index === 0]);
    }
    for (const memberKey of team.members) {
      await client.query(`INSERT INTO ${CRM_SCHEMA}.crm_org_assignments(user_id,unit_id,role,is_primary)
        VALUES($1,$2,'member',false)`, [accounts.get(memberKey).userId, teamId]);
    }
  }
  return ids;
}

async function mockUserIds(client) {
  const result = await client.query(`SELECT u.user_id AS "userId",e.email FROM public.identity_users u
    JOIN public.identity_login_emails e USING(user_id) WHERE e.email LIKE $1`, [`${MOCK_EMAIL_PREFIX}%@yqn.com`]);
  return result.rows;
}

async function setAppendOnlyMockTriggers(client, enabled) {
  const triggers = [
    ['crm_opportunity_stage_history', 'crm_opportunity_history_append_only'],
    ['crm_team_monitoring_audits', 'trg_crm_team_monitoring_audits_immutable'],
    ['crm_customer_grade_override_audits', 'trg_crm_customer_grade_audit_immutable'],
  ];
  for (const [table, trigger] of triggers) {
    const relation = `${CRM_SCHEMA}.${table}`;
    const exists = await client.query(`SELECT EXISTS(
        SELECT 1 FROM pg_trigger trigger
        WHERE trigger.tgrelid=to_regclass($1) AND trigger.tgname=$2 AND NOT trigger.tgisinternal
      ) AS ready`, [relation, trigger]);
    if (exists.rows[0]?.ready) {
      await client.query(`ALTER TABLE ${relation} ${enabled ? 'ENABLE' : 'DISABLE'} TRIGGER ${trigger}`);
    }
  }
}

async function cleanupRows(client, users) {
  if (process.env.PROSPECTOR_MOCK_DEBUG === '1') {
    const rawQuery = client.query.bind(client);
    client.query = async (...args) => {
      try { return await rawQuery(...args); }
      catch (error) {
        if (error instanceof Error) error.message = `${error.message}\nSQL: ${String(args[0]).replace(/\s+/g, ' ').slice(0, 500)}`;
        throw error;
      }
    };
  }
  const userIds = users.map(user => user.userId);
  const customers = await client.query(`SELECT customer_id AS "customerId" FROM ${crmTable('crm_customers')} WHERE source=$1`, [MOCK_SOURCE]);
  const customerIds = customers.rows.map(row => row.customerId);
  const contacts = await client.query(`SELECT c.id FROM ${crmTable('contacts')} c
    JOIN ${crmTable('crm_customer_contacts')} cc ON cc.contact_id=c.id WHERE cc.customer_id=ANY($1::uuid[])`, [customerIds]);
  const contactIds = contacts.rows.map(row => row.id);
  const currentTeamNames = TEAMS.filter(team => team.kind !== 'company').map(team => team.name);
  const knownTeamNames = [...currentTeamNames, ...RETIRED_ORG_UNIT_NAMES];
  const teams = await client.query(`SELECT unit_id AS "teamId",name FROM ${CRM_SCHEMA}.crm_org_units
    WHERE kind<>'company' AND name=ANY($1::text[])`, [knownTeamNames]);
  const teamIds = teams.rows.map(row => row.teamId);
  await setAppendOnlyMockTriggers(client, false);
  try {
    if (customerIds.length) {
      await client.query(`DELETE FROM ${crmTable('crm_team_attention_notifications')}
        WHERE item_id IN (SELECT item_id FROM ${crmTable('crm_team_attention_items')} WHERE customer_id=ANY($1::uuid[]))`, [customerIds]);
      await client.query(`DELETE FROM ${crmTable('crm_team_attention_audits')}
        WHERE item_id IN (SELECT item_id FROM ${crmTable('crm_team_attention_items')} WHERE customer_id=ANY($1::uuid[]))`, [customerIds]);
      await client.query(`DELETE FROM ${crmTable('crm_team_attention_items')} WHERE customer_id=ANY($1::uuid[])`, [customerIds]);
      await client.query(`DELETE FROM ${crmTable('crm_contact_monitor_audits')}
        WHERE customer_id=ANY($1::uuid[]) OR contact_id=ANY($2::int[]) OR actor_id=ANY($3::uuid[])`, [customerIds, contactIds, userIds]);
      await client.query(`DELETE FROM ${crmTable('crm_team_monitoring_audits')}
        WHERE customer_id=ANY($1::uuid[]) OR contact_id=ANY($2::int[]) OR actor_id=ANY($3::uuid[])`, [customerIds, contactIds, userIds]);
      await client.query(`DELETE FROM ${crmTable('crm_customer_grade_override_idempotency')}
        WHERE actor_id=ANY($1::uuid[]) OR response->>'customerId'=ANY($2::text[])`, [userIds, customerIds]);
      await client.query(`DELETE FROM ${crmTable('crm_customer_grade_override_audits')}
        WHERE customer_id=ANY($1::uuid[]) OR actor_id=ANY($2::uuid[])`, [customerIds, userIds]);
      await client.query(`DELETE FROM ${crmTable('crm_customer_grade_overrides')}
        WHERE customer_id=ANY($1::uuid[]) OR actor_id=ANY($2::uuid[])`, [customerIds, userIds]);
      await client.query(`DELETE FROM ${crmTable('crm_task_due_receipts')}
        WHERE task_id IN (SELECT task_id FROM ${crmTable('crm_followup_tasks')} WHERE customer_id=ANY($1::uuid[]))`, [customerIds]);
      await client.query(`DELETE FROM ${crmTable('crm_followup_tasks')}
        WHERE customer_id=ANY($1::uuid[]) OR source_responsible_user_id=ANY($2::uuid[])`, [customerIds, userIds]);
      await client.query(`DELETE FROM ${crmTable('crm_contact_mail_task_suggestions')}
        WHERE customer_id=ANY($1::uuid[]) OR contact_id=ANY($2::int[]) OR actor_id=ANY($3::uuid[])`, [customerIds, contactIds, userIds]);
      await client.query(`DELETE FROM ${crmTable('crm_contact_mail_analyses')}
        WHERE customer_id=ANY($1::uuid[]) OR contact_id=ANY($2::int[]) OR actor_id=ANY($3::uuid[])`, [customerIds, contactIds, userIds]);
      await client.query(`DELETE FROM ${crmTable('crm_contact_ownership')}
        WHERE customer_id=ANY($1::uuid[]) OR contact_id=ANY($2::int[]) OR owner_user_id=ANY($3::uuid[])`, [customerIds, contactIds, userIds]);
      await client.query(`DELETE FROM ${crmTable('crm_contact_assignment_group_members')}
        WHERE request_id IN (SELECT request_id FROM ${crmTable('crm_contact_assignment_requests')}
          WHERE customer_id=ANY($1::uuid[]) OR contact_id=ANY($2::int[]) OR actor_id=ANY($3::uuid[]) OR target_user_id=ANY($3::uuid[])
            OR previous_target_user_id=ANY($3::uuid[]) OR transfer_actor_id=ANY($3::uuid[]))`, [customerIds, contactIds, userIds]);
      await client.query(`DELETE FROM ${crmTable('crm_contact_assignment_requests')}
        WHERE customer_id=ANY($1::uuid[]) OR contact_id=ANY($2::int[]) OR actor_id=ANY($3::uuid[]) OR target_user_id=ANY($3::uuid[])
          OR previous_target_user_id=ANY($3::uuid[]) OR transfer_actor_id=ANY($3::uuid[])`, [customerIds, contactIds, userIds]);
      await client.query(`DELETE FROM ${crmTable('crm_contact_changes')}
        WHERE customer_id=ANY($1::uuid[]) OR contact_id=ANY($2::int[]) OR recipient_user_id=ANY($3::uuid[])`, [customerIds, contactIds, userIds]);
      await client.query(`DELETE FROM ${crmTable('crm_lead_match_decisions')}
        WHERE selected_customer_id=ANY($1::uuid[]) OR selected_contact_id=ANY($2::int[]) OR actor_id=ANY($3::uuid[])`, [customerIds, contactIds, userIds]);
      await client.query(`DELETE FROM ${crmTable('crm_contact_mail_events')}
        WHERE customer_id=ANY($1::uuid[]) OR contact_id=ANY($2::int[]) OR actor_id=ANY($3::uuid[])`, [customerIds, contactIds, userIds]);
      await client.query(`DELETE FROM ${crmTable('crm_contact_shares')}
        WHERE customer_id=ANY($1::uuid[]) OR contact_id=ANY($2::int[])`, [customerIds, contactIds]);
      await client.query(`DELETE FROM ${crmTable('crm_send_authorizations')}
        WHERE customer_id=ANY($1::uuid[]) OR contact_id=ANY($2::int[])`, [customerIds, contactIds]);
      await client.query(`DELETE FROM ${crmTable('crm_shared_activities')}
        WHERE customer_id=ANY($1::uuid[]) OR contact_id=ANY($2::int[])`, [customerIds, contactIds]);
      await client.query(`DELETE FROM ${crmTable('crm_opportunity_stage_history')}
        WHERE opportunity_id IN (SELECT opportunity_id FROM ${crmTable('crm_opportunities')} WHERE customer_id=ANY($1::uuid[]))`, [customerIds]);
      await client.query(`DELETE FROM ${crmTable('crm_opportunities')} WHERE customer_id=ANY($1::uuid[])`, [customerIds]);
      await client.query(`DELETE FROM ${crmTable('crm_assignment_history')} WHERE customer_id=ANY($1::uuid[])`, [customerIds]);
      await client.query(`DELETE FROM ${crmTable('crm_workbook_source_mappings')}
        WHERE customer_id=ANY($1::uuid[]) OR contact_id=ANY($2::int[]) OR actor_id=ANY($3::uuid[])`, [customerIds, contactIds, userIds]);
      await client.query(`DELETE FROM ${crmTable('crm_import_rows')} WHERE customer_id=ANY($1::uuid[])`, [customerIds]);
      await client.query(`DELETE FROM ${crmTable('crm_customer_contacts')}
        WHERE customer_id=ANY($1::uuid[]) OR contact_id=ANY($2::int[])`, [customerIds, contactIds]);
    }
  } finally {
    await setAppendOnlyMockTriggers(client, true);
  }

  const eventIds = await client.query(`SELECT event_id FROM public.identity_outbox
    WHERE user_id=ANY($1::uuid[]) OR customer_id=ANY($2::uuid[])`, [userIds, customerIds]);
  const scopedEventIds = eventIds.rows.map(row => row.event_id);
  if (scopedEventIds.length) {
    await client.query(`DELETE FROM ${crmTable('crm_team_attention_notifications')} WHERE event_id=ANY($1::uuid[])`, [scopedEventIds]);
    await client.query(`DELETE FROM ${crmTable('crm_task_due_receipts')} WHERE event_id=ANY($1::uuid[])`, [scopedEventIds]);
    await client.query(`DELETE FROM ${crmTable('crm_notification_consumed')} WHERE event_id=ANY($1::uuid[])`, [scopedEventIds]);
    await client.query(`DELETE FROM ${crmTable('crm_notification_reads')}
      WHERE user_id=ANY($1::uuid[]) OR delivery_id IN (SELECT delivery_id FROM ${crmTable('crm_event_deliveries')}
        WHERE event_id=ANY($2::uuid[]) OR recipient_user_id=ANY($1::uuid[]))`, [userIds, scopedEventIds]);
    await client.query(`DELETE FROM ${crmTable('crm_event_deliveries')}
      WHERE event_id=ANY($1::uuid[]) OR recipient_user_id=ANY($2::uuid[])`, [scopedEventIds, userIds]);
    await client.query('DELETE FROM public.identity_outbox WHERE event_id=ANY($1::uuid[])', [scopedEventIds]);
  } else {
    await client.query(`DELETE FROM ${crmTable('crm_notification_reads')} WHERE user_id=ANY($1::uuid[])`, [userIds]);
    await client.query(`DELETE FROM ${crmTable('crm_event_deliveries')} WHERE recipient_user_id=ANY($1::uuid[])`, [userIds]);
  }

  if (customerIds.length) {
    await client.query(`DELETE FROM ${crmTable('crm_customers')} WHERE customer_id=ANY($1::uuid[])`, [customerIds]);
  }
  if (contactIds.length) {
    await client.query(`DELETE FROM ${crmTable('interactions')} WHERE contact_id=ANY($1::int[])`, [contactIds]);
    await client.query(`DELETE FROM ${crmTable('crm_relations')} WHERE contact_id_a=ANY($1::int[]) OR contact_id_b=ANY($2::int[])`, [contactIds, contactIds]);
    await client.query(`DELETE FROM ${crmTable('contacts')} WHERE id=ANY($1::int[])`, [contactIds]);
  }
  await client.query(`DELETE FROM ${crmTable('companies')} company WHERE company.name LIKE 'Mock %'
    AND NOT EXISTS (SELECT 1 FROM ${crmTable('contacts')} contact WHERE contact.company_id=company.id)`, []);

  if (teamIds.length) {
    await client.query(`DELETE FROM ${CRM_SCHEMA}.crm_org_member_group_members WHERE unit_id=ANY($1::uuid[])`, [teamIds]);
    await client.query(`DELETE FROM ${CRM_SCHEMA}.crm_org_member_groups WHERE unit_id=ANY($1::uuid[])`, [teamIds]);
    await client.query(`DELETE FROM ${CRM_SCHEMA}.crm_org_invitations WHERE unit_id=ANY($1::uuid[])`, [teamIds]);
    await client.query(`DELETE FROM ${CRM_SCHEMA}.crm_org_assignments WHERE unit_id=ANY($1::uuid[]) OR user_id=ANY($2::uuid[])`, [teamIds, userIds]);
    const idsByName = new Map(teams.rows.map(row => [row.name, row.teamId]));
    for (const name of [...currentTeamNames, ...RETIRED_ORG_UNIT_NAMES].reverse()) {
      const teamId = idsByName.get(name);
      if (teamId) await client.query(`DELETE FROM ${CRM_SCHEMA}.crm_org_units WHERE unit_id=$1 AND kind<>'company'`, [teamId]);
    }
  }
  await client.query(`DELETE FROM ${CRM_SCHEMA}.crm_org_idempotency WHERE actor_id=ANY($1::uuid[])`, [userIds]);
  const legacyTeams = await client.query(`SELECT team_id AS "teamId" FROM ${crmTable('crm_teams')} WHERE name=ANY($1::text[])`, [knownTeamNames]);
  const legacyTeamIds = legacyTeams.rows.map(row => row.teamId);
  if (legacyTeamIds.length) {
    await client.query(`DELETE FROM ${crmTable('crm_team_invitations')} WHERE team_id=ANY($1::uuid[])`, [legacyTeamIds]);
    await client.query(`DELETE FROM ${crmTable('crm_team_members')} WHERE team_id=ANY($1::uuid[]) OR user_id=ANY($2::uuid[])`, [legacyTeamIds, userIds]);
    await client.query(`DELETE FROM ${crmTable('crm_teams')} WHERE team_id=ANY($1::uuid[])`, [legacyTeamIds]);
  }
  await client.query(`DELETE FROM ${crmTable('crm_team_idempotency')} WHERE actor_id=ANY($1::uuid[])`, [userIds]);
  await client.query(`DELETE FROM ${crmTable('crm_device_cursors')} WHERE user_id=ANY($1::uuid[])`, [userIds]);
  await client.query(`DELETE FROM ${crmTable('crm_feed_heads')} WHERE user_id=ANY($1::uuid[])`, [userIds]);
  await client.query(`DELETE FROM ${crmTable('crm_lead_idempotency')} WHERE actor_id=ANY($1::uuid[])`, [userIds]);
  await client.query(`DELETE FROM ${crmTable('crm_workbook_source_mappings')} WHERE actor_id=ANY($1::uuid[])`, [userIds]);
  await client.query(`DELETE FROM ${crmTable('crm_import_rows')}
    WHERE batch_id IN (SELECT batch_id FROM ${crmTable('crm_import_batches')} WHERE actor_id=ANY($1::uuid[]))`, [userIds]);
  await client.query(`DELETE FROM ${crmTable('crm_import_batches')} WHERE actor_id=ANY($1::uuid[])`, [userIds]);
  await client.query('DELETE FROM public.identity_desktop_refresh_tokens WHERE session_id IN (SELECT session_id FROM public.identity_sessions WHERE user_id=ANY($1::uuid[]))', [userIds]);
  await client.query('DELETE FROM public.identity_sessions WHERE user_id=ANY($1::uuid[])', [userIds]);
  await client.query('DELETE FROM public.identity_management_challenges WHERE user_id=ANY($1::uuid[]) OR issuer_id=ANY($1::uuid[])', [userIds]);
  await client.query('DELETE FROM public.identity_management_audit WHERE actor_id=ANY($1::uuid[]) OR target_id=ANY($1::uuid[])', [userIds]);
  await client.query('DELETE FROM public.identity_outbox WHERE user_id=ANY($1::uuid[]) OR customer_id=ANY($2::uuid[])', [userIds, customerIds]);
  await client.query('DELETE FROM public.identity_account_experience_events WHERE user_id=ANY($1::uuid[])', [userIds]);
  await client.query('DELETE FROM public.identity_account_growth_projection WHERE user_id=ANY($1::uuid[])', [userIds]);
  await client.query('DELETE FROM public.identity_login_aliases WHERE user_id=ANY($1::uuid[])', [userIds]);
  await client.query('DELETE FROM public.identity_legacy_account_mappings WHERE center_user_id=ANY($1::uuid[])', [userIds]);
  await client.query('DELETE FROM public.identity_user_profiles WHERE user_id=ANY($1::uuid[])', [userIds]);
  await client.query('DELETE FROM public.identity_audit WHERE user_id=ANY($1::uuid[])', [userIds]);
  await client.query('DELETE FROM public.identity_credentials WHERE user_id=ANY($1::uuid[])', [userIds]);
  await client.query('DELETE FROM public.identity_product_access WHERE user_id=ANY($1::uuid[])', [userIds]);
  await client.query('DELETE FROM public.identity_product_grants WHERE user_id=ANY($1::uuid[])', [userIds]);
  await client.query('DELETE FROM public.identity_login_emails WHERE user_id=ANY($1::uuid[])', [userIds]);
  await client.query('DELETE FROM public.identity_users WHERE user_id=ANY($1::uuid[])', [userIds]);
  return { users: userIds.length, customers: customerIds.length, contacts: contactIds.length, teams: teamIds.length };
}

function contactStatusValue(touch) {
  return touch;
}

async function insertMailFact(client, lead, owner, contactId, customerId, mailInput, index, createdAt) {
  const mail = typeof mailInput === 'string' ? { kind: mailInput } : mailInput;
  const kind = mail.kind;
  const contact = lead.contact;
  const direction = mail.direction || (kind === 'sent' ? 'outbound' : 'inbound');
  const touch = kind === 'sent' ? 'contacted' : ['replied', 'autoreply', 'bounced'].includes(kind) ? kind : null;
  const subject = mail.subject || (kind === 'sent' ? `Mock quotation for ${lead.company.name}` : `Mock reply from ${lead.company.name}`);
  const preview = mail.preview || (kind === 'sent' ? 'Please review the attached mock ocean freight quotation.'
    : kind === 'replied' ? 'Thanks, we reviewed the mock quotation and would like to discuss the schedule.'
    : kind === 'autoreply' ? 'This is an automated mock out-of-office response.'
    : kind === 'bounced' ? 'Mock delivery failed because the recipient mailbox was unavailable.'
    : 'Mock customer message for analysis coverage.');
  const activity = await client.query(`INSERT INTO ${crmTable('crm_shared_activities')}(customer_id,interaction_id,actor_id,note,method,occurred_at,recorded_at,created_at,contact_id,contact_status)
    VALUES($1,NULL,$2,$3,'email',$4,$4,$4,$5,$6) RETURNING id::text`, [customerId, owner.userId, subject, createdAt, contactId, touch]);
  const fromEmail = mail.fromEmail || (direction === 'outbound' ? owner.email : contact.email);
  const toEmails = mail.toEmails || (direction === 'outbound' ? [contact.email] : [owner.email]);
  const eventKey = `${MOCK_SOURCE}:${lead.key}:${kind}:${index}`;
  const messageKey = `mock-message:${lead.key}:${kind}:${index}`;
  const fingerprint = digest([contactId, customerId, eventKey, 'mock-dev', messageKey, kind, direction, createdAt, subject, preview, fromEmail, toEmails, []]);
  const event = await client.query(`INSERT INTO ${crmTable('crm_contact_mail_events')}(
      event_id,actor_id,contact_id,customer_id,event_key,mailbox_key,message_key,kind,direction,occurred_at,subject,preview,
      from_email,to_emails,cc_emails,digest,recorded_at,activity_id,send_stage_advanced)
    VALUES($1,$2,$3,$4,$5,'mock-dev',$6,$7,$8,$9,$10,$11,$12,$13::jsonb,'[]'::jsonb,$14,$9,$15,$16) RETURNING event_id`,
  [randomUUID(), owner.userId, contactId, customerId, eventKey, messageKey, kind, direction, createdAt, subject, preview, fromEmail, JSON.stringify(toEmails), fingerprint, activity.rows[0].id, kind === 'sent' && index === 0]);
  return {
    eventId: event.rows[0].event_id, activityId: activity.rows[0].id, eventKey, messageKey, kind, direction,
    subject, preview, occurredAt: createdAt, contentHash: fingerprint, fromEmail, toEmails,
  };
}

async function seedTask(client, owner, customerId, suffix, title, dueAt, completed = false) {
  const taskId = randomUUID();
  if (completed) {
    await client.query(`INSERT INTO ${crmTable('crm_followup_tasks')}(task_id,customer_id,title,due_at,status,version,created_by,completed_at,completed_by,feedback)
      VALUES($1,$2,$3,$4,'completed',2,$5,$6,$5,$7)`, [taskId, customerId, title, dueAt, owner.userId, iso(-1, 16), 'Mock completed follow-up']);
  } else {
    await client.query(`INSERT INTO ${crmTable('crm_followup_tasks')}(task_id,customer_id,title,due_at,status,version,created_by)
      VALUES($1,$2,$3,$4,'open',1,$5)`, [taskId, customerId, title, dueAt, owner.userId]);
  }
  return { taskId, suffix, completed };
}

async function seedLeads(client, accounts) {
  const operations = accounts.get('operations');
  const records = [];
  for (const [leadIndex, lead] of LEADS.entries()) {
    const owner = lead.owner ? accounts.get(lead.owner) : null;
    const creator = accounts.get(lead.createdBy);
    const company = await client.query(`INSERT INTO ${crmTable('companies')}(name,domain,industry,country,crm_created_by,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$6) RETURNING id`, [lead.company.name, lead.company.domain, lead.company.industry, lead.company.country, operations.userId, iso(-31 + leadIndex)]);
    const companyId = company.rows[0].id;
    const source = lead.origin === 'operations' ? 'mock-online' : 'mock-local';
    const contact = await client.query(`INSERT INTO ${crmTable('contacts')}(
        email,company_id,first_name,last_name,title,country,client_type,language,stage,status,tags,extra,assignee,source,source_detail,
        source_level1,source_level2,created_at,updated_at,crm_touch_status)
      VALUES($1,$2,$3,$4,$5,$6,'agent','en',$7,$8,'[]'::jsonb,$9::jsonb,'',$10,$11,$12,$13,$14,$14,$15) RETURNING id`,
    [lead.contact.email, companyId, lead.contact.firstName, lead.contact.lastName, lead.contact.title, lead.company.country,
      lead.contact.stage, contactStatusValue(lead.contact.touch), JSON.stringify({ note: `Mock hierarchy ${lead.key}` }), source,
      lead.sourceDetail, lead.origin === 'operations' ? 'Mock线上' : 'Mock本地', lead.key, iso(-30 + leadIndex), lead.contact.touch]);
    const contactId = contact.rows[0].id;
    const customerId = randomUUID();
    await client.query(`INSERT INTO ${crmTable('crm_customers')}(customer_id,company_id,source,customer_key,source_detail,state,owner_user_id,created_by,
        origin,business_type,source_created_at,relationship_stage,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [customerId, companyId, MOCK_SOURCE, lead.key, lead.sourceDetail, lead.state, owner?.userId || null, creator.userId,
      lead.origin, lead.company.industry, iso(-30 + leadIndex), lead.relationshipStage, iso(-30 + leadIndex)]);
    await client.query(`INSERT INTO ${crmTable('crm_customer_contacts')}(customer_id,contact_id) VALUES($1,$2)`, [customerId, contactId]);
    if (owner) {
      await client.query(`INSERT INTO ${crmTable('crm_assignment_history')}(customer_id,owner_user_id,actor_id,created_at)
        VALUES($1,$2,$3,$4)`, [customerId, owner.userId, operations.userId, iso(-29 + leadIndex)]);
    }
    const mailRecords = [];
    for (const [mailIndex, mail] of lead.mails.entries()) {
      const occurredAt = iso(-5 + mailIndex, 9 + leadIndex % 8);
      mailRecords.push(await insertMailFact(client, lead, owner || operations, contactId, customerId, mail, mailIndex, occurredAt));
    }
    records.push({ ...lead, companyId, contactId, customerId, ownerEmail: owner?.email || null, creatorEmail: creator.email, mailRecords });
  }

  const byKey = new Map(records.map(record => [record.key, record]));
  const taskSpecs = [
    ['online-replied', '确认 mock 报价与船期', iso(1, 10), false],
    ['online-contacted', '跟进 Nordic Freight 的首封报价', iso(-4, 10), true],
    ['online-bounced', '校正 Pacific Cargo 联系人邮箱', iso(-2, 10), false],
    ['personal-replied', '回复 BlueWave Logistics 的询价问题', iso(2, 10), false],
    ['personal-autoreply', '自动回复后安排电话回访', iso(-1, 10), true],
  ];
  const tasks = [];
  for (const [key, title, dueAt, completed] of taskSpecs) {
    const record = byKey.get(key);
    const owner = accounts.get(record.owner);
    tasks.push({ leadKey: key, customerId: record.customerId, ...(await seedTask(client, owner, record.customerId, key, title, dueAt, completed)) });
  }
  for (const record of records.filter(item => item.won)) {
    const owner = accounts.get(record.owner);
    tasks.push({ leadKey: record.key, customerId: record.customerId, ...(await seedTask(client, owner, record.customerId, record.key, '完成成交交接', iso(-1, 16), true)) });
  }
  return { records, tasks };
}

async function seedOutbox(client, eventType, actorId, version, customerId, payload, recipients, createdAt) {
  const result = await client.query(`INSERT INTO public.identity_outbox(
      event_type,user_id,product_id,revision,customer_id,payload,recipient_user_ids,created_at)
    VALUES($1,$2,'crm',$3,$4,$5::jsonb,$6::uuid[],$7) RETURNING event_id`, [
    eventType, actorId, version, customerId, JSON.stringify(payload), [...new Set(recipients)].sort(), createdAt,
  ]);
  return result.rows[0].event_id;
}

async function seedAssignments(client, accounts, teamIds, records) {
  const byKey = new Map(records.map(record => [record.key, record]));
  const operations = accounts.get('operations');
  const east = accounts.get('supervisorEast');
  const south = accounts.get('supervisorSouth');
  const anna = accounts.get('memberAnna');
  const ben = accounts.get('memberBen');
  const cara = accounts.get('memberCara');
  const sourceOrgUnitId = teamIds.get('operations');
  const fixtures = [
    {
      key: 'pending', leadKey: 'online-pool', target: anna, status: 'pending', previous: null, transferActor: null,
      createdOffset: -2, decidedOffset: null, expiresOffset: 5, supervisors: [east.userId], eventType: 'crm.contact.assignment.requested',
    },
    {
      key: 'accepted', leadKey: 'cp2-accepted', target: anna, status: 'accepted', previous: null, transferActor: null,
      createdOffset: -12, decidedOffset: -11, expiresOffset: 5, supervisors: [east.userId], eventType: 'crm.contact.assignment.accepted',
    },
    {
      key: 'pendingTransfer', leadKey: 'online-replied', target: ben, status: 'pending_transfer', previous: east.userId,
      transferActor: east.userId, createdOffset: -18, decidedOffset: null, expiresOffset: 5, supervisors: [east.userId],
      eventType: 'crm.contact.assignment.transfer_requested',
    },
    {
      key: 'expired', leadKey: 'cp2-expired', target: cara, status: 'expired', previous: null, transferActor: null,
      createdOffset: -12, decidedOffset: -5, expiresOffset: -5, supervisors: [south.userId], eventType: 'crm.contact.assignment.expired',
    },
  ];
  const seeded = new Map();
  for (const fixture of fixtures) {
    const record = byKey.get(fixture.leadKey);
    const requestId = randomUUID();
    const groupId = randomUUID();
    const createdAt = iso(fixture.createdOffset, 9);
    const decidedAt = fixture.decidedOffset === null ? null : iso(fixture.decidedOffset, 11);
    const expiresAt = iso(fixture.expiresOffset, 18);
    const version = fixture.status === 'pending' ? 1 : 2;
    const notifyUserIds = [...new Set([fixture.target.userId, ...fixture.supervisors])];
    await client.query(`INSERT INTO ${crmTable('crm_contact_assignment_requests')}(
        request_id,contact_id,customer_id,target_user_id,actor_id,notify_user_ids,status,version,created_at,decided_at,expires_at,
        previous_target_user_id,transfer_actor_id,transfer_requested_at,supervisor_user_ids,source_org_unit_id,source_org_unit_name)
      VALUES($1,$2,$3,$4,$5,$6::uuid[],$7,$17,$8,$9,$10,$11,$12,$13,$14::uuid[],$15,$16)`, [
      requestId, record.contactId, record.customerId, fixture.target.userId, operations.userId, notifyUserIds, fixture.status,
      createdAt, decidedAt, expiresAt, fixture.previous, fixture.transferActor,
      fixture.status === 'pending_transfer' ? iso(-1, 14) : null, fixture.supervisors, sourceOrgUnitId, TEAMS.find(team => team.key === 'operations').name,
      version,
    ]);
    await client.query(`INSERT INTO ${crmTable('crm_contact_assignment_group_members')}(group_id,request_id) VALUES($1,$2)`, [groupId, requestId]);
    await seedOutbox(client, fixture.eventType, fixture.transferActor || operations.userId, version, record.customerId, {
      requestId, groupId, contactId: record.contactId, customerId: record.customerId, version,
      companyName: record.company.name, contactName: `${record.contact.firstName} ${record.contact.lastName}`,
      assignmentStatus: fixture.status,
    }, [operations.userId, fixture.target.userId, ...fixture.supervisors, ...(fixture.previous ? [fixture.previous] : [])], createdAt);
    seeded.set(fixture.key, { ...fixture, requestId, groupId });
  }
  return seeded;
}

async function seedOwnershipAndWins(client, accounts, teamIds, records, assignments) {
  const operations = accounts.get('operations');
  const byKey = new Map(records.map(record => [record.key, record]));
  const linkedRequests = new Map([
    ['cp2-accepted', assignments.get('accepted').requestId],
    ['online-replied', assignments.get('pendingTransfer').requestId],
  ]);
  const acceptedAt = iso(-11, 11);
  const acceptedRecord = byKey.get('cp2-accepted');
  await client.query(`INSERT INTO ${crmTable('crm_contact_ownership')}(
      contact_id,customer_id,owner_user_id,source_org_unit_id,started_at,ended_at,ended_reason,created_by)
    VALUES($1,$2,$3,$4,$5,$6,'assignment_transfer',$7)`, [
    acceptedRecord.contactId, acceptedRecord.customerId, accounts.get('supervisorEast').userId, teamIds.get('operations'),
    iso(-18, 9), acceptedAt, operations.userId,
  ]);
  for (const [index, record] of records.entries()) {
    if (!record.owner) continue;
    const owner = accounts.get(record.owner);
    const startedAt = record.key === 'cp2-accepted' ? acceptedAt : iso(-20 + index % 8, 11);
    const teamKey = ['memberAnna', 'memberBen', 'supervisorEast'].includes(record.owner) ? 'east' : 'south';
    await client.query(`INSERT INTO ${crmTable('crm_contact_ownership')}(
        contact_id,customer_id,owner_user_id,assignment_request_id,source_org_unit_id,started_at,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [
      record.contactId, record.customerId, owner.userId, linkedRequests.get(record.key) || null,
      teamIds.get(teamKey), startedAt, operations.userId,
    ]);
  }

  const wonRecords = records.filter(record => record.won);
  for (const [index, record] of wonRecords.entries()) {
    const owner = accounts.get(record.owner);
    const wins = index === 0 ? 2 : 1;
    for (let sequence = 0; sequence < wins; sequence += 1) {
      const opportunityId = randomUUID();
      const closedAt = iso(-7 + sequence, 15);
      const title = `Mock repeat shipment ${index + 1}-${sequence + 1}`;
      await client.query(`INSERT INTO ${crmTable('crm_opportunities')}(
          opportunity_id,customer_id,title,description,source,stage,amount,currency,evidence,version,created_by,created_at,updated_at,closed_at,closed_by)
        VALUES($1,$2,$3,'Mock CP7 closed-won booking','mock-dev','closed_won',$4,'USD','Mock signed booking confirmation',3,$5,$6,$7,$7,$5)`, [
        opportunityId, record.customerId, title, 1400 + index * 150 + sequence * 75, owner.userId, iso(-14), closedAt,
      ]);
      await client.query(`INSERT INTO ${crmTable('crm_opportunity_stage_history')}(
          opportunity_id,from_stage,to_stage,actor_id,occurred_at,amount,currency,evidence)
        VALUES($1,'quote_sent','closed_won',$2,$3,$4,'USD','Mock signed booking confirmation')`, [
        opportunityId, owner.userId, closedAt, 1400 + index * 150 + sequence * 75,
      ]);
    }
  }
}

async function seedAnalysis(client, record, mail, actorId, input) {
  const analysisId = randomUUID();
  const createdAt = new Date(new Date(mail.occurredAt).getTime() + input.createdOffsetMinutes * 60_000).toISOString();
  const signals = input.signals || [];
  await client.query(`INSERT INTO ${crmTable('crm_contact_mail_analyses')}(
      analysis_id,actor_id,event_id,contact_id,customer_id,mailbox_key,message_key,content_hash,thread_key,analyzer_version,
      input_sequence,source,relevance,classification,contact_state,summary,signals,requires_action,next_action,priority,
      due_hint,confidence,evidence,human_locked,idempotency_key,request_digest,supersedes_id,is_current,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19,$20,$21,$22,$23::jsonb,$24,$25,$26,$27,$28,$29)`, [
    analysisId, actorId, mail.eventId, record.contactId, record.customerId, 'mock-dev', mail.messageKey, mail.contentHash,
    `mock-thread:${record.key}`, input.analyzerVersion || 'mock-cp4-v1', input.inputSequence, input.source, input.relevance,
    input.classification, input.contactState, input.summary, JSON.stringify(signals), input.requiresAction, input.nextAction || null,
    input.priority || 'normal', input.dueHint || null, input.confidence, JSON.stringify(input.evidence || []),
    input.source === 'human', input.idempotencyKey, digest([input.idempotencyKey, mail.contentHash, input.summary]),
    input.supersedesId || null, input.isCurrent, createdAt,
  ]);
  if (input.isCurrent && input.contactState) {
    await client.query(`UPDATE ${crmTable('contacts')} SET crm_touch_status=$2,updated_at=$3 WHERE id=$1`,
      [record.contactId, input.contactState, new Date().toISOString()]);
  }
  return analysisId;
}

async function seedMailAnalyses(client, accounts, records) {
  const byKey = new Map(records.map(record => [record.key, record]));
  const result = { analyses: [], requestAnalysisId: null, humanAnalysisId: null, internalAnalysisId: null, spamAnalysisId: null };
  const add = async (record, mail, actorKey, input) => {
    const analysisId = await seedAnalysis(client, record, mail, accounts.get(actorKey).userId, input);
    if (input.isCurrent && input.contactState) record.contact.touch = input.contactState;
    const analysis = { analysisId, record, mail, ...input };
    result.analyses.push(analysis);
    return analysis;
  };

  const nordic = byKey.get('online-contacted');
  const requestMail = nordic.mailRecords.find(mail => mail.kind === 'replied');
  const request = await add(nordic, requestMail, 'memberAnna', {
    source: 'rule', relevance: 'customer_business', classification: 'replied', contactState: 'replied',
    summary: '客户询问宁波到鹿特丹的 2x40HQ 报价与下一班船期。', signals: [{ code: 'quote_request', label: '询价' }],
    requiresAction: true, nextAction: '确认报价、舱位与下一班船期', priority: 'important', dueHint: '1 个工作日内',
    confidence: 0.94, evidence: ['客户明确要求报价并询问船期'], inputSequence: 4101, isCurrent: true,
    idempotencyKey: 'mock-cp4:rule:quote-request', createdOffsetMinutes: 2,
  });
  result.requestAnalysisId = request.analysisId;
  await client.query(`INSERT INTO ${crmTable('crm_contact_mail_task_suggestions')}(
      suggestion_id,actor_id,contact_id,customer_id,thread_key,action_code,source_analysis_id,next_action,priority,due_hint,status,version)
    VALUES($1,$2,$3,$4,$5,'quote_request',$6,$7,'important','1 个工作日内','suggested',1)`, [
    randomUUID(), accounts.get('memberAnna').userId, nordic.contactId, nordic.customerId, `mock-thread:${nordic.key}`,
    request.analysisId, '确认报价、舱位与下一班船期',
  ]);

  const coral = byKey.get('personal-replied');
  const humanMail = coral.mailRecords.find(mail => mail.kind === 'replied');
  const priorRule = await add(coral, humanMail, 'supervisorEast', {
    source: 'rule', relevance: 'customer_business', classification: 'replied', contactState: 'replied',
    summary: '规则初判为普通客户回复。', signals: [], requiresAction: false, priority: 'normal', confidence: 0.73,
    evidence: ['邮件包含客户回复'], inputSequence: 4201, isCurrent: false, idempotencyKey: 'mock-cp4:rule:before-human',
    createdOffsetMinutes: 1, analyzerVersion: 'mock-rule-v1',
  });
  const human = await add(coral, humanMail, 'supervisorEast', {
    source: 'human', relevance: 'customer_business', classification: 'replied', contactState: 'replied',
    summary: '人工确认客户要求核对报价有效期与截关时间。', signals: [{ code: 'pricing_question', label: '价格问题' }],
    requiresAction: true, nextAction: '人工回复报价有效期和截关时间', priority: 'urgent', dueHint: '今日',
    confidence: 1, evidence: ['人工确认业务回复'], inputSequence: 4202, supersedesId: priorRule.analysisId,
    isCurrent: true, idempotencyKey: 'mock-cp4:human:locked-reply', createdOffsetMinutes: 2, analyzerVersion: 'mock-human-v1',
  });
  await add(coral, humanMail, 'supervisorEast', {
    source: 'ai', relevance: 'customer_business', classification: 'replied', contactState: 'replied',
    summary: '晚到 AI 草案不得覆盖人工结论。', signals: [], requiresAction: false, priority: 'normal', confidence: 0.66,
    evidence: ['晚到模型结果'], inputSequence: 4300, supersedesId: human.analysisId, isCurrent: false,
    idempotencyKey: 'mock-cp4:ai:late-after-human', createdOffsetMinutes: 30, analyzerVersion: 'mock-ai-v1',
  });
  result.humanAnalysisId = human.analysisId;

  const maple = byKey.get('personal-contacted');
  const internalMail = maple.mailRecords.find(mail => mail.fromEmail.endsWith('@yqn.com'));
  result.internalAnalysisId = (await add(maple, internalMail, 'memberBen', {
    source: 'rule', relevance: 'internal', classification: 'other', contactState: null,
    summary: '内部运营摘要，不触发客户动作。', signals: [], requiresAction: false, priority: 'normal', confidence: 0.99,
    evidence: ['发件域名为公司内部域名'], inputSequence: 4401, isCurrent: true,
    idempotencyKey: 'mock-cp4:rule:internal-no-action', createdOffsetMinutes: 1,
  })).analysisId;
  const spamMail = maple.mailRecords.find(mail => mail.fromEmail.includes('bulk-mailer'));
  result.spamAnalysisId = (await add(maple, spamMail, 'memberBen', {
    source: 'rule', relevance: 'spam', classification: 'other', contactState: null,
    summary: '群发营销邮件，不进入待办。', signals: [], requiresAction: false, priority: 'normal', confidence: 0.98,
    evidence: ['批量营销发件地址'], inputSequence: 4402, isCurrent: true,
    idempotencyKey: 'mock-cp4:rule:spam-no-action', createdOffsetMinutes: 1,
  })).analysisId;

  for (const record of records.filter(item => item.won)) {
    const replyMail = record.mailRecords.find(mail => mail.kind === 'replied');
    await add(record, replyMail, record.owner, {
      source: 'rule', relevance: 'customer_business', classification: 'replied', contactState: 'replied',
      summary: `${record.company.name} 已确认业务回复并完成 mock 成交。`, signals: [{ code: 'booking_confirmed', label: '成交确认' }],
      requiresAction: false, priority: 'normal', confidence: 0.96, evidence: ['客户业务回复'], inputSequence: 5000 + result.analyses.length,
      isCurrent: true, idempotencyKey: `mock-cp7:reply:${record.key}`, createdOffsetMinutes: 1,
    });
  }
  for (const record of records.filter(item => ['bounced', 'autoreply'].includes(item.contact.touch))) {
    const mail = record.mailRecords.find(item => ['bounced', 'autoreply'].includes(item.kind));
    await add(record, mail, record.owner, {
      source: 'rule', relevance: record.contact.touch === 'autoreply' ? 'notification' : 'customer_business',
      classification: record.contact.touch, contactState: record.contact.touch,
      summary: record.contact.touch === 'bounced' ? '邮箱退信，需要校正地址。' : '自动回复，不视为客户业务回复。',
      signals: [], requiresAction: record.contact.touch === 'bounced', nextAction: record.contact.touch === 'bounced' ? '校正联系人邮箱' : null,
      priority: record.contact.touch === 'bounced' ? 'important' : 'normal', confidence: 0.93,
      evidence: ['邮件机械分类'], inputSequence: 5100 + result.analyses.length, isCurrent: true,
      idempotencyKey: `mock-cp4:${record.contact.touch}:${record.key}`, createdOffsetMinutes: 1,
    });
  }
  return result;
}

async function seedTeamAttention(client, accounts, records, mailAnalyses) {
  const byKey = new Map(records.map(record => [record.key, record]));
  const analysisByKey = new Map(mailAnalyses.analyses.filter(item => item.isCurrent).map(item => [item.record.key, item]));
  const supervisor = accounts.get('supervisorEast');
  const member = accounts.get('memberAnna');
  const specs = [
    { key: 'online-contacted', state: 'open', reason: 'important_reply', priority: 'important', note: '重要询价待回复', result: null },
    { key: 'personal-autoreply', state: 'acknowledged', reason: 'unhandled_inquiry', priority: 'normal', note: '主管已确认自动回复', result: null },
    { key: 'cp7-won-1', state: 'resolved', reason: 'quote_overdue', priority: 'urgent', note: '报价超时', result: '已确认报价并完成成交' },
    { key: 'cp7-won-2', state: 'dismissed', reason: 'important_reply', priority: 'normal', note: '重复关注提醒', result: null },
  ];
  const items = [];
  for (const [index, spec] of specs.entries()) {
    const record = byKey.get(spec.key);
    const analysis = analysisByKey.get(spec.key);
    const itemId = randomUUID();
    const version = spec.state === 'open' ? 1 : spec.state === 'acknowledged' || spec.state === 'dismissed' ? 2 : 3;
    const createdAt = iso(-4 + index, 9);
    const acknowledgedAt = spec.state !== 'open' ? iso(-3 + index, 10) : null;
    const resolvedAt = spec.state === 'resolved' ? iso(-2 + index, 11) : null;
    const dismissedAt = spec.state === 'dismissed' ? iso(-2 + index, 11) : null;
    const updatedAt = resolvedAt || dismissedAt || acknowledgedAt || createdAt;
    await client.query(`INSERT INTO ${crmTable('crm_team_attention_items')}(
        item_id,target_member_user_id,source_supervisor_user_id,customer_id,contact_id,mail_event_id,analysis_id,reason,priority,
        status,note,result,version,created_at,updated_at,acknowledged_at,resolved_at,dismissed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$18,$15,$16,$17)`, [
      itemId, member.userId, supervisor.userId, record.customerId, record.contactId, analysis.mail.eventId, analysis.analysisId,
      spec.reason, spec.priority, spec.state, spec.note, spec.result, version, createdAt, acknowledgedAt, resolvedAt, dismissedAt,
      updatedAt,
    ]);
    await client.query(`INSERT INTO ${crmTable('crm_team_attention_audits')}(
        audit_id,item_id,item_version,actor_id,action,from_status,to_status,note,result,created_at)
      VALUES($1,$2,1,$3,'created',NULL,'open',$4,NULL,$5)`, [randomUUID(), itemId, supervisor.userId, spec.note, createdAt]);
    if (version >= 2) {
      await client.query(`INSERT INTO ${crmTable('crm_team_attention_audits')}(
          audit_id,item_id,item_version,actor_id,action,from_status,to_status,note,result,created_at)
        VALUES($1,$2,2,$3,$4,'open',$5,NULL,$6,$7)`, [
        randomUUID(), itemId, supervisor.userId, spec.state === 'dismissed' ? 'dismissed' : 'acknowledged',
        spec.state === 'dismissed' ? 'dismissed' : 'acknowledged', spec.state === 'dismissed' ? null : spec.note, acknowledgedAt,
      ]);
    }
    if (version === 3) {
      await client.query(`INSERT INTO ${crmTable('crm_team_attention_audits')}(
          audit_id,item_id,item_version,actor_id,action,from_status,to_status,note,result,created_at)
        VALUES($1,$2,3,$3,'resolved','acknowledged','resolved',NULL,$4,$5)`, [randomUUID(), itemId, member.userId, spec.result, resolvedAt]);
    }

    const transitions = [{ version: 1, status: 'open', event: 'crm.team.attention.opened', actor: supervisor.userId, recipients: [member.userId, supervisor.userId], at: createdAt }];
    if (version >= 2) transitions.push({
      version: 2, status: spec.state === 'dismissed' ? 'dismissed' : 'acknowledged',
      event: spec.state === 'dismissed' ? 'crm.team.attention.dismissed' : 'crm.team.attention.acknowledged',
      actor: supervisor.userId, recipients: [member.userId], at: acknowledgedAt,
    });
    if (version === 3) transitions.push({
      version: 3, status: 'resolved', event: 'crm.team.attention.resolved', actor: member.userId, recipients: [supervisor.userId], at: resolvedAt,
    });
    for (const transition of transitions) {
      const eventId = await seedOutbox(client, transition.event, transition.actor, transition.version, record.customerId, {
        attentionItemId: itemId, attentionVersion: transition.version, attentionStatus: transition.status,
        targetMemberUserId: member.userId, sourceSupervisorUserId: supervisor.userId, reason: spec.reason,
      }, transition.recipients, transition.at);
      await client.query(`INSERT INTO ${crmTable('crm_team_attention_notifications')}(
          item_id,item_version,status,event_id,recipient_user_ids,created_at)
        VALUES($1,$2,$3,$4,$5::uuid[],$6)`, [itemId, transition.version, transition.status, eventId, transition.recipients, transition.at]);
    }
    items.push({ itemId, key: spec.key, status: spec.state, version });
  }
  return items;
}

async function seedMonitoringAndGradeOverride(client, accounts, teams, records, assignments) {
  const byKey = new Map(records.map(record => [record.key, record]));
  const supervisor = accounts.get('supervisorEast');
  const operations = accounts.get('operations');
  const admin = accounts.get('admin');
  const annaContact = byKey.get('online-contacted');
  const repliedContact = byKey.get('online-replied');
  const annaMail = annaContact.mailRecords.find(mail => mail.kind === 'replied');
  const repliedMail = repliedContact.mailRecords.find(mail => mail.kind === 'replied');

  for (let index = 0; index < 2; index += 1) {
    await client.query(`INSERT INTO ${crmTable('crm_contact_monitor_audits')}(actor_id,contact_id,customer_id,relationship,created_at)
      VALUES($1,$2,$3,'direct_leader',$4)`, [supervisor.userId, annaContact.contactId, annaContact.customerId, iso(-1, 9 + index)]);
  }
  const audits = [
    { actor: supervisor.userId, scope: 'leader', kind: 'contact', target: String(annaContact.contactId), record: annaContact, mail: null, offset: -2 },
    { actor: supervisor.userId, scope: 'leader', kind: 'mail', target: annaMail.eventId, record: annaContact, mail: annaMail, offset: -1 },
    { actor: operations.userId, scope: 'operations', kind: 'contact', target: String(annaContact.contactId), record: annaContact, mail: null, offset: -2 },
    { actor: admin.userId, scope: 'superadmin', kind: 'mail', target: repliedMail.eventId, record: repliedContact, mail: repliedMail, offset: -1 },
  ];
  for (const audit of audits) {
    await client.query(`INSERT INTO ${crmTable('crm_team_monitoring_audits')}(
        audit_id,actor_id,scope,target_kind,target_id,contact_id,customer_id,mail_event_id,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [
      randomUUID(), audit.actor, audit.scope, audit.kind, audit.target, audit.record.contactId, audit.record.customerId,
      audit.mail?.eventId || null, iso(audit.offset, 15),
    ]);
  }

  const overrideRecord = byKey.get('personal-uncontacted');
  const reason = 'Mock 人工确认其为战略试单客户';
  await client.query(`INSERT INTO ${crmTable('crm_customer_grade_overrides')}(customer_id,grade,reason,actor_id,version,created_at,updated_at)
    VALUES($1,'B',$2,$3,1,$4,$4)`, [overrideRecord.customerId, reason, operations.userId, iso(-1, 13)]);
  await client.query(`INSERT INTO ${crmTable('crm_customer_grade_override_audits')}(
      audit_id,customer_id,action,from_grade,to_grade,reason,actor_id,override_version,created_at)
    VALUES($1,$2,'set',NULL,'B',$3,$4,1,$5)`, [randomUUID(), overrideRecord.customerId, reason, operations.userId, iso(-1, 13)]);
  const response = { customerId: overrideRecord.customerId, grade: 'B', version: 1 };
  await client.query(`INSERT INTO ${crmTable('crm_customer_grade_override_idempotency')}(
      actor_id,operation,idempotency_key,digest,response,created_at)
    VALUES($1,'customer-grade-override','mock-cp7:manual-override',$2,$3::jsonb,$4)`, [
    operations.userId, digest(response), JSON.stringify(response), iso(-1, 13),
  ]);
  return { overrideCustomerId: overrideRecord.customerId, teamId: teams.get('east') };
}

function buildLocalSchemaBundle() {
  fs.mkdirSync(path.dirname(SCHEMA_BUNDLE), { recursive: true });
  buildSync({ entryPoints: ['src/main/db/schema-sql.ts'], outfile: SCHEMA_BUNDLE, bundle: true, platform: 'node', format: 'cjs', packages: 'external' });
  delete require.cache[require.resolve(SCHEMA_BUNDLE)];
  return require(SCHEMA_BUNDLE).BASE_SCHEMA_SQL;
}

function safeProfileRoot(account) {
  const root = path.resolve(profileRoot(DEV_BASE_URL, account.userId));
  const accountsRoot = `${path.resolve(userDataRoot(), 'accounts')}${path.sep}`;
  if (!root.startsWith(accountsRoot)) fail('账号资料路径超出开发端隔离目录，拒绝操作');
  return root;
}

function removeLocalProfiles(users) {
  const blocked = [];
  for (const user of users) {
    const root = safeProfileRoot(user);
    if (!fs.existsSync(root)) continue;
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNKNOWN';
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(code)) throw error;
      blocked.push({ email: user.email || '', userId: user.userId, path: root, code });
      log('WARN', `本地 Mock 资料正被应用占用，保留待下次清理: ${user.email || user.userId}`);
    }
  }
  return blocked;
}

function seedLocalProfile(account, records, schemaSql) {
  const root = safeProfileRoot(account);
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  const dataRoot = path.join(root, 'data');
  fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(root, 'send'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, 'desktop-local-binding.json'), JSON.stringify({
    version: 1,
    owner: { baseUrl: DEV_BASE_URL, userId: account.userId },
  }), { encoding: 'utf8', mode: 0o600 });
  const db = new Constructor(path.join(dataRoot, 'prospector.db'));
  try {
    db.pragma('journal_mode=WAL');
    db.pragma('synchronous=FULL');
    db.exec(schemaSql);
    const accountEmail = `mock.inbox.${account.key.toLowerCase()}@yqn.com`;
    db.prepare(`INSERT INTO email_accounts(email,provider,smtp_host,smtp_port,imap_host,imap_port,encrypted_pass,display_name,is_active)
      VALUES(?,?,?,?,?,?,?,?,0)`).run(accountEmail, 'smtp', null, null, null, null, '', `${account.displayName} Mock Inbox`);
    const insertContact = db.prepare(`INSERT INTO contacts(email,company_id,first_name,last_name,title,country,client_type,language,stage,status,tags,extra,assignee,source,source_detail,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertInteraction = db.prepare(`INSERT INTO interactions(contact_id,type,direction,channel,subject,body_preview,message_id,account_id,metadata,created_at)
      VALUES(?,'email',?, 'email',?,?,?,?,?,?)`);
    const insertInbox = db.prepare(`INSERT INTO inbox_messages(account_id,message_id,from_email,from_name,subject,body_preview,classification,"to",my_role,matched_contact_id,is_read,received_at,created_at)
      VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const record of records) {
      const localContact = insertContact.run(record.contact.email, record.companyId, record.contact.firstName, record.contact.lastName,
        record.contact.title, record.company.country, 'agent', 'en', record.contact.stage, contactStatusValue(record.contact.touch), '[]',
        JSON.stringify({ note: `Local mock mirror ${record.key}` }), '', record.origin, record.sourceDetail, iso(-19), iso(-1));
      const localContactId = Number(localContact.lastInsertRowid);
      for (const [index, mail] of record.mailRecords.entries()) {
        const inbound = mail.kind !== 'sent';
        const direction = inbound ? 'inbound' : 'outbound';
        const messageId = `${MOCK_SOURCE}:${account.key}:${record.key}:${index}`;
        const subject = inbound ? `Mock reply from ${record.company.name}` : `Mock quotation for ${record.company.name}`;
        const preview = inbound ? `Mock ${mail.kind} message for ${record.contact.email}` : `Mock quotation sent to ${record.contact.email}`;
        insertInteraction.run(localContactId, direction, subject, preview, messageId, 1, '{}', mail.occurredAt);
        if (inbound) {
          insertInbox.run(messageId, record.contact.email, `${record.contact.firstName} ${record.contact.lastName}`, subject, preview,
            mail.kind, accountEmail, 'to', localContactId, 0, mail.occurredAt, mail.occurredAt);
        }
      }
    }
  } finally {
    db.close();
  }
}

function seedLocalProfiles(accounts, records) {
  const schemaSql = buildLocalSchemaBundle();
  for (const account of ACCOUNTS) {
    const row = accounts.get(account.key);
    const visible = account.role === 'operations'
      ? records.filter(record => record.origin === 'operations')
      : records.filter(record => record.owner === account.key);
    seedLocalProfile(row, visible, schemaSql);
  }
}

function readManifest() {
  if (!fs.existsSync(MANIFEST)) return null;
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); }
  catch { return null; }
}

function localProfileStatus(user) {
  const file = path.join(safeProfileRoot(user), 'data', 'prospector.db');
  if (!fs.existsSync(file)) return { present: false, contacts: 0, inbox: 0, accounts: 0 };
  const db = new Constructor(file, { readonly: true, fileMustExist: true });
  try {
    const count = table => Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() || { n: 0 }).n);
    return { present: true, contacts: count('contacts'), inbox: count('inbox_messages'), accounts: count('email_accounts') };
  } finally {
    db.close();
  }
}

async function databaseStatus(client) {
  const users = await mockUserIds(client);
  const customers = await client.query(`SELECT customer_id AS "customerId" FROM ${crmTable('crm_customers')} WHERE source=$1`, [MOCK_SOURCE]);
  const customerIds = customers.rows.map(row => row.customerId);
  const tableReady = async table => (await client.query('SELECT to_regclass($1) IS NOT NULL AS ready', [`${CRM_SCHEMA}.${table}`])).rows[0].ready;
  const ready = {
    assignments: await tableReady('crm_contact_assignment_requests'),
    analyses: await tableReady('crm_contact_mail_analyses'),
    attention: await tableReady('crm_team_attention_items'),
    monitoring: await tableReady('crm_team_monitoring_audits'),
    grades: await tableReady('crm_customer_grade_overrides'),
  };
  const tasks = (await client.query(`SELECT count(*)::int AS count FROM ${crmTable('crm_followup_tasks')} WHERE customer_id=ANY($1::uuid[])`, [customerIds])).rows[0].count;
  const mailEvents = (await client.query(`SELECT count(*)::int AS count FROM ${crmTable('crm_contact_mail_events')} WHERE customer_id=ANY($1::uuid[])`, [customerIds])).rows[0].count;
  let assignments = null;
  let assignmentNotifications = null;
  if (ready.assignments) {
    const rows = await client.query(`SELECT status,count(*)::int AS count FROM ${crmTable('crm_contact_assignment_requests')}
      WHERE customer_id=ANY($1::uuid[]) GROUP BY status ORDER BY status`, [customerIds]);
    assignments = Object.fromEntries(rows.rows.map(row => [row.status, row.count]));
    assignmentNotifications = (await client.query(`SELECT count(*)::int AS count FROM public.identity_outbox
      WHERE customer_id=ANY($1::uuid[]) AND event_type LIKE 'crm.contact.assignment.%'`, [customerIds])).rows[0].count;
  }
  let analyses = null;
  if (ready.analyses) {
    const row = (await client.query(`SELECT count(*)::int AS total,
        count(*) FILTER(WHERE is_current)::int AS current,
        count(*) FILTER(WHERE human_locked)::int AS "humanLocked",
        count(*) FILTER(WHERE NOT is_current)::int AS suppressed
      FROM ${crmTable('crm_contact_mail_analyses')} WHERE customer_id=ANY($1::uuid[])`, [customerIds])).rows[0];
    analyses = row;
  }
  let attention = null;
  if (ready.attention) {
    const statuses = await client.query(`SELECT status,count(*)::int AS count FROM ${crmTable('crm_team_attention_items')}
      WHERE customer_id=ANY($1::uuid[]) GROUP BY status ORDER BY status`, [customerIds]);
    const audits = (await client.query(`SELECT count(*)::int AS count FROM ${crmTable('crm_team_attention_audits')}
      WHERE item_id IN (SELECT item_id FROM ${crmTable('crm_team_attention_items')} WHERE customer_id=ANY($1::uuid[]))`, [customerIds])).rows[0].count;
    const notifications = (await client.query(`SELECT count(*)::int AS count FROM ${crmTable('crm_team_attention_notifications')}
      WHERE item_id IN (SELECT item_id FROM ${crmTable('crm_team_attention_items')} WHERE customer_id=ANY($1::uuid[]))`, [customerIds])).rows[0].count;
    attention = { ...Object.fromEntries(statuses.rows.map(row => [row.status, row.count])), audits, notifications };
  }
  let monitoringAudits = null;
  if (ready.monitoring) {
    const rows = await client.query(`SELECT 'contact' AS kind,count(*)::int AS count FROM ${crmTable('crm_contact_monitor_audits')}
        WHERE customer_id=ANY($1::uuid[])
      UNION ALL
      SELECT 'team',count(*)::int FROM ${crmTable('crm_team_monitoring_audits')} WHERE customer_id=ANY($1::uuid[])`, [customerIds]);
    monitoringAudits = Object.fromEntries(rows.rows.map(row => [row.kind, row.count]));
  }
  let grades = null;
  if (ready.grades) {
    const rows = await client.query(`SELECT customer.customer_id AS "customerId",
        (SELECT count(DISTINCT analysis.event_id)::int FROM ${crmTable('crm_contact_mail_analyses')} analysis
          JOIN ${crmTable('crm_contact_mail_events')} event ON event.event_id=analysis.event_id AND event.kind='replied' AND event.direction='inbound'
          WHERE analysis.customer_id=customer.customer_id AND analysis.is_current AND analysis.relevance='customer_business' AND analysis.classification='replied') AS replies,
        (SELECT count(DISTINCT history.opportunity_id)::int FROM ${crmTable('crm_opportunities')} opportunity
          JOIN ${crmTable('crm_opportunity_stage_history')} history ON history.opportunity_id=opportunity.opportunity_id AND history.to_stage='closed_won'
          WHERE opportunity.customer_id=customer.customer_id) AS won,
        (SELECT count(*)::int FROM ${crmTable('crm_opportunities')} opportunity WHERE opportunity.customer_id=customer.customer_id
          AND opportunity.stage NOT IN ('closed_won','closed_lost')) AS open,
        override.grade AS "overrideGrade"
      FROM ${crmTable('crm_customers')} customer LEFT JOIN ${crmTable('crm_customer_grade_overrides')} override USING(customer_id)
      WHERE customer.source=$1`, [MOCK_SOURCE]);
    const countGrades = key => ({ A: rows.rows.filter(row => row[key] === 'A').length, B: rows.rows.filter(row => row[key] === 'B').length, C: rows.rows.filter(row => row[key] === 'C').length });
    for (const row of rows.rows) {
      row.computedGrade = Number(row.won) > 0 || Number(row.replies) >= 3 ? 'A' : Number(row.replies) >= 1 || Number(row.open) >= 1 ? 'B' : 'C';
      row.effectiveGrade = row.overrideGrade || row.computedGrade;
    }
    const overrideCount = (await client.query(`SELECT count(*)::int AS count FROM ${crmTable('crm_customer_grade_overrides')} WHERE customer_id=ANY($1::uuid[])`, [customerIds])).rows[0].count;
    const auditCount = (await client.query(`SELECT count(*)::int AS count FROM ${crmTable('crm_customer_grade_override_audits')} WHERE customer_id=ANY($1::uuid[])`, [customerIds])).rows[0].count;
    grades = { derived: countGrades('computedGrade'), effective: countGrades('effectiveGrade'), overrides: overrideCount, audits: auditCount };
  }
  const readiness = await schemaReadiness(client);
  return {
    accounts: users.length,
    localProfiles: users.filter(user => localProfileStatus(user).present).length,
    customers: customerIds.length,
    tasks,
    mailEvents,
    assignments: { available: ready.assignments, byStatus: assignments, notifications: assignmentNotifications },
    analyses: { available: ready.analyses, ...(analyses || {}) },
    attention: { available: ready.attention, ...(attention || {}) },
    monitoringAudits: { available: ready.monitoring, ...(monitoringAudits || {}) },
    grades: { available: ready.grades, ...(grades || {}) },
    migrations: readiness,
  };
}

async function responseResult(response, label = '中心请求') {
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) fail(`${label}失败: ${payload?.error?.code || response.status} ${payload?.error?.message || ''}`.trim());
  return payload.data;
}

async function verifyLogins(password) {
  const results = [];
  for (const account of ACCOUNTS) {
    const login = await responseResult(await fetch(`${DEV_BASE_URL}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: account.email, password }),
    }), `${account.email} 登录`);
    const headers = { authorization: `Bearer ${login.token}` };
    const team = await responseResult(await fetch(`${DEV_BASE_URL}/api/crm/team-context`, { headers }), `${account.email} 团队`);
    const personal = await responseResult(await fetch(`${DEV_BASE_URL}/api/crm/contacts?search=&limit=50&offset=0&scope=personal`, { headers }), `${account.email} 自有线索`);
    const assigned = await responseResult(await fetch(`${DEV_BASE_URL}/api/crm/contacts?search=&limit=50&offset=0&scope=assigned`, { headers }), `${account.email} 分配线索`);
    const all = await responseResult(await fetch(`${DEV_BASE_URL}/api/crm/contacts?search=&limit=50&offset=0&scope=all`, { headers }), `${account.email} 全部线索`);
    const tasks = await responseResult(await fetch(`${DEV_BASE_URL}/api/crm/tasks?limit=50&offset=0`, { headers }), `${account.email} 任务`);
    if (!team.team && !team.canAdmin) fail(`${account.email} 未获得团队视图`);
    if (all.total < 1) fail(`${account.email} 未读取到 Mock 线索`);
    results.push({ email: account.email, role: account.role, team: team.team?.name || '全部团队', personal: personal.total, assigned: assigned.total, contacts: all.total, tasks: tasks.total });
  }
  return results;
}

async function schemaReadiness(client) {
  const migrations = await client.query(`SELECT version FROM ${crmTable('crm_schema_migrations')}
    WHERE version=ANY($1::text[]) ORDER BY version`, [REQUIRED_MIGRATION_VERSIONS]);
  const present = migrations.rows.map(row => row.version);
  const presentSet = new Set(present);
  return { present, missing: REQUIRED_MIGRATION_VERSIONS.filter(version => !presentSet.has(version)) };
}

async function assertCumulativeSchema(client) {
  const readiness = await schemaReadiness(client);
  if (readiness.missing.length) {
    fail(`Mock CP2-CP7 需要先应用迁移: ${readiness.missing.join(', ')}`);
  }
  const requiredTables = [
    'crm_org_units', 'crm_contact_assignment_requests', 'crm_contact_ownership', 'crm_contact_mail_analyses',
    'crm_team_attention_items', 'crm_team_attention_audits', 'crm_team_attention_notifications',
    'crm_team_monitoring_audits', 'crm_customer_grade_overrides', 'crm_customer_grade_override_audits',
  ];
  const tableStatus = await client.query(`SELECT name,to_regclass($1||'.'||name) IS NOT NULL AS ready
    FROM unnest($2::text[]) name`, [CRM_SCHEMA, requiredTables]);
  const missing = tableStatus.rows.filter(row => !row.ready).map(row => row.name);
  if (missing.length) fail(`Mock CP2-CP7 缺少业务表: ${missing.join(', ')}`);
}

async function setup(pool) {
  const password = passwordValue();
  const passwords = new PasswordAdapter(1);
  await passwords.initialize();
  const passwordHash = await passwords.hash(password);
  const client = await pool.connect();
  let existingUsers = [];
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('statement_timeout',$1,true)", [String(STATEMENT_TIMEOUT_MS)]);
    await client.query('SELECT pg_advisory_xact_lock(19042901)');
    await assertCumulativeSchema(client);
    const admin = await findAdmin(client);
    existingUsers = await mockUserIds(client);
    await cleanupRows(client, existingUsers);
    const users = [];
    for (const spec of ACCOUNTS) users.push(await ensureAccount(client, spec, passwordHash));
    const accounts = accountMap(users);
    accounts.set('admin', admin);
    const teams = await ensureTeams(client, accounts);
    const seeded = await seedLeads(client, accounts);
    const assignments = await seedAssignments(client, accounts, teams, seeded.records);
    await seedOwnershipAndWins(client, accounts, teams, seeded.records, assignments);
    const mailAnalyses = await seedMailAnalyses(client, accounts, seeded.records);
    const attentionItems = await seedTeamAttention(client, accounts, seeded.records, mailAnalyses);
    const grades = await seedMonitoringAndGradeOverride(client, accounts, teams, seeded.records, assignments);
    await client.query('COMMIT');

    const blockedProfiles = removeLocalProfiles(existingUsers);
    seedLocalProfiles(accounts, seeded.records);
    const manifest = {
      marker: 'prospector-mock-dev-hierarchy-v3-cumulative',
      createdAt: new Date().toISOString(),
      baseUrl: DEV_BASE_URL,
      source: MOCK_SOURCE,
      accounts: users.map(({ email, displayName, role, userId }) => ({ email, displayName, role, userId })),
      teams: TEAMS.map(team => ({ ...team, teamId: teams.get(team.key) })),
      customers: seeded.records.map(record => ({ key: record.key, customerId: record.customerId, contactId: record.contactId, email: record.contact.email, origin: record.origin, owner: record.owner })),
      tasks: seeded.tasks,
      assignments: [...assignments].map(([key, value]) => ({ key, requestId: value.requestId, status: value.status, leadKey: value.leadKey })),
      analyses: mailAnalyses.analyses.map(item => ({ analysisId: item.analysisId, leadKey: item.record.key, source: item.source, current: item.isCurrent })),
      attentionItems,
      gradeOverrideCustomerId: grades.overrideCustomerId,
      blockedProfiles,
    };
    fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2), { encoding: 'utf8', mode: 0o600 });
    const verification = await verifyLogins(password);
    return { manifest, verification };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* transaction may already be closed */ }
    throw error;
  } finally {
    client.release();
  }
}

async function cleanup(pool, dryRun) {
  const client = await pool.connect();
  let users = [];
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('statement_timeout',$1,true)", [String(STATEMENT_TIMEOUT_MS)]);
    await client.query('SELECT pg_advisory_xact_lock(19042901)');
    users = await mockUserIds(client);
    const manifest = readManifest();
    const profileUsers = users.length ? users : (manifest?.accounts || []);
    const removed = await cleanupRows(client, users);
    if (dryRun) await client.query('ROLLBACK');
    else await client.query('COMMIT');
    if (!dryRun) {
      const blockedProfiles = removeLocalProfiles(profileUsers);
      if (!blockedProfiles.length && fs.existsSync(MANIFEST)) fs.unlinkSync(MANIFEST);
      return { ...removed, dryRun, blockedProfiles };
    }
    return { ...removed, dryRun };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* transaction may already be closed */ }
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const command = process.argv[2];
  if (!['setup', 'status', 'cleanup'].includes(command)) fail('用法: node scripts/mock-dev-hierarchy.mjs setup|status|cleanup [--dry-run]');
  const config = readConfig();
  const pool = new Pool({ host: config.host, port: config.port, database: config.database, user: config.app, password: config.appPassword, max: 2, application_name: 'prospector-mock-dev-hierarchy' });
  try {
    if (command === 'setup') {
      const result = await setup(pool);
      log('INFO', `Mock 层级已创建；${result.manifest.accounts.length} 个账号，${result.manifest.customers.length} 条线索`);
      process.stdout.write(JSON.stringify({ ok: true, ...result }, null, 2) + '\n');
    } else if (command === 'cleanup') {
      const result = await cleanup(pool, process.argv.includes('--dry-run'));
      log('INFO', result.dryRun ? 'Mock 数据清理演练完成并已回滚' : 'Mock 数据与账号已清理');
      process.stdout.write(JSON.stringify({ ok: true, ...result }, null, 2) + '\n');
    } else {
      const client = await pool.connect();
      try {
        const result = await databaseStatus(client);
        process.stdout.write(JSON.stringify({ ok: true, ...result }, null, 2) + '\n');
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  log('ERROR', error instanceof Error ? error.message : 'Mock 层级操作失败');
  process.exitCode = 1;
});
