import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { PasswordAdapter } from '../dist-server/adapters/password.js';
import { capabilitiesFor } from '../dist-server/core/admin.js';

const require = createRequire(import.meta.url);
if (!process.versions.electron) {
  const executable = path.resolve('node_modules/electron/dist/electron.exe');
  if (!fs.existsSync(executable)) throw new Error('无法找到 Electron 运行时');
  const result = spawnSync(executable, [process.argv[1], ...process.argv.slice(2)], {
    cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', windowsHide: true,
  });
  process.exit(result.status ?? 1);
}
const { Pool } = require('pg');
const Constructor = require('better-sqlite3');
const { buildSync } = require('esbuild');

const CONFIG_PATH = 'C:/ProgramData/MiloginCenter/postgres.json';
const OUTPUT_DIRECTORY = path.resolve('.work/team-canvas-scenario');
const MANIFEST_PATH = path.join(OUTPUT_DIRECTORY, 'manifest.json');
const CREDENTIALS_PATH = path.join(OUTPUT_DIRECTORY, 'credentials.json');
const DATABASE = 'milogin_center';
const PORT = 55846;
const SCENARIO_SOURCE = 'mock-team-canvas-20261116';
const JADE_TEAM_NAME = 'Jade';
const DAISY_TEAM_NAME = 'Daisy';
const MEMBER_COUNT = 12;
const IRIS_TEAM_NAME = 'Iris';
const IRIS_MEMBER_COUNT = 6;
const OLD_TEAM_NAMES = ['test', 'Mock Milogin 运营组', 'Mock Milogin 销售组'];
const DAY_MS = 86_400_000;
const USER_DATA_DIRECTORY = 'prospecting-email-dev';
const LOCAL_SCHEMA_BUNDLE = path.resolve('.work/team-canvas-scenario/schema.cjs');

function log(level, message) {
  process.stdout.write(`[${new Date().toISOString()}] [${level}] [team-canvas-seed] ${message}\n`);
}

function fail(message) {
  throw new Error(message);
}

function readConfig() {
  const value = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (value.marker !== 'milogin-center-postgres-v1' || value.host !== '127.0.0.1'
    || value.port !== PORT || value.database !== DATABASE || value.app !== 'milogin_app') {
    fail('仅允许写入本机开发中心 milogin_center');
  }
  return value;
}

function iso(dayOffset, hour = 9) {
  const value = new Date();
  value.setUTCDate(value.getUTCDate() + dayOffset);
  value.setUTCHours(hour, 0, 0, 0);
  return value.toISOString();
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function searchLatin(value) {
  return String(value ?? '').replace(/[^\p{Script=Latin}\p{N}\s]/gu, ' ');
}

function protectedText(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value, { encoding: 'utf8', mode: 0o600 });
}

async function accountByEmail(client, email) {
  const result = await client.query(`
    SELECT u.user_id AS "userId",u.display_name AS "displayName",e.email
    FROM public.identity_users u JOIN public.identity_login_emails e USING(user_id)
    WHERE lower(e.email)=lower($1) AND u.deleted_at IS NULL`, [email]);
  return result.rows[0] ?? null;
}

async function ensureAccount(client, input, passwordHash) {
  const email = input.email.toLowerCase();
  let account = await accountByEmail(client, email);
  if (account) {
    await client.query('UPDATE public.identity_users SET display_name=$2,active=true,identity_admin=$3,must_change_password=false WHERE user_id=$1',
      [account.userId, input.displayName, input.identityAdmin === true]);
  } else {
    const userId = randomUUID();
    await client.query(`INSERT INTO public.identity_users(user_id,display_name,active,identity_admin,must_change_password)
      VALUES($1,$2,true,$3,false)`, [userId, input.displayName, input.identityAdmin === true]);
    await client.query('INSERT INTO public.identity_login_emails(user_id,email,verified_at) VALUES($1,$2,now())', [userId, email]);
    account = { userId, displayName: input.displayName, email };
  }
  if (passwordHash) {
    await client.query(`INSERT INTO public.identity_credentials(user_id,password_hash,hash_scheme)
      VALUES($1,$2,'scrypt-v1') ON CONFLICT(user_id) DO UPDATE SET password_hash=EXCLUDED.password_hash,hash_scheme='scrypt-v1',changed_at=now()`,
    [account.userId, passwordHash]);
  }
  await client.query("DELETE FROM public.identity_product_grants WHERE user_id=$1 AND product_id='crm'", [account.userId]);
  for (const role of input.roles) {
    await client.query("INSERT INTO public.identity_product_grants(user_id,product_id,role,active) VALUES($1,'crm',$2,true)", [account.userId, role]);
  }
  const scope = input.roles.includes('operations') ? 'shared' : 'own';
  await client.query(`INSERT INTO public.identity_product_access(user_id,product_id,active,scope,capabilities)
    VALUES($1,'crm',true,$2,$3::jsonb) ON CONFLICT(user_id,product_id)
    DO UPDATE SET active=true,scope=EXCLUDED.scope,capabilities=EXCLUDED.capabilities`,
  [account.userId, scope, JSON.stringify(capabilitiesFor(input.roles))]);
  return account;
}

async function ensureTeam(client, input) {
  const existing = await client.query(`
    SELECT unit_id AS "unitId" FROM public.crm_org_units
    WHERE kind=$1 AND parent_unit_id IS NOT DISTINCT FROM $2::uuid AND lower(btrim(name))=lower(btrim($3))
    ORDER BY created_at,unit_id LIMIT 1 FOR UPDATE`, [input.kind, input.parentUnitId, input.name]);
  if (existing.rows.length) {
    const unitId = existing.rows[0].unitId;
    await client.query(`UPDATE public.crm_org_units SET name=$2,kind=$3,parent_unit_id=$4,created_by=$5,
      dissolved_at=NULL,dissolved_by=NULL,version=version+1,updated_at=now() WHERE unit_id=$1`,
    [unitId, input.name, input.kind, input.parentUnitId, input.createdBy]);
    return unitId;
  }
  const unitId = randomUUID();
  await client.query(`INSERT INTO public.crm_org_units(unit_id,kind,parent_unit_id,name,created_by)
    VALUES($1,$2,$3,$4,$5)`, [unitId, input.kind, input.parentUnitId, input.name, input.createdBy]);
  return unitId;
}

async function ensureAssignment(client, userId, unitId, role, primary) {
  const existing = await client.query(`SELECT user_id FROM public.crm_org_assignments
    WHERE user_id=$1 AND unit_id=$2 AND ended_at IS NULL FOR UPDATE`, [userId, unitId]);
  if (existing.rows.length) {
    await client.query(`UPDATE public.crm_org_assignments SET role=$3,is_primary=$4,version=version+1,updated_at=now()
      WHERE user_id=$1 AND unit_id=$2`, [userId, unitId, role, primary]);
  } else {
    await client.query(`INSERT INTO public.crm_org_assignments(user_id,unit_id,role,is_primary)
      VALUES($1,$2,$3,$4)`, [userId, unitId, role, primary]);
  }
}

async function endAssignmentsOutside(client, userIds, keepUnitIds) {
  await client.query(`UPDATE public.crm_org_assignments SET ended_at=now(),version=version+1,updated_at=now()
    WHERE user_id=ANY($1::uuid[]) AND ended_at IS NULL AND NOT (unit_id=ANY($2::uuid[]))`, [userIds, keepUnitIds]);
}

async function dissolveOldTeams(client, companyId, actorId) {
  const old = await client.query(`SELECT unit_id AS "unitId" FROM public.crm_org_units
    WHERE kind<>'company' AND parent_unit_id=$1 AND name=ANY($2::text[]) AND dissolved_at IS NULL FOR UPDATE`, [companyId, OLD_TEAM_NAMES]);
  const oldIds = old.rows.map(row => row.unitId);
  if (!oldIds.length) return 0;
  await client.query(`UPDATE public.crm_org_assignments SET ended_at=now(),version=version+1,updated_at=now()
    WHERE unit_id=ANY($1::uuid[]) AND ended_at IS NULL`, [oldIds]);
  await client.query(`UPDATE public.crm_org_invitations SET status='cancelled',version=version+1,decided_at=now()
    WHERE unit_id=ANY($1::uuid[]) AND status='pending'`, [oldIds]);
  await client.query(`UPDATE public.crm_org_units SET dissolved_at=now(),dissolved_by=$2,version=version+1,updated_at=now()
    WHERE unit_id=ANY($1::uuid[])`, [oldIds, actorId]);
  return oldIds.length;
}

async function ensureCompany(client, name, userId) {
  const rows = await client.query(`SELECT id FROM public.companies WHERE lower(btrim(name))=lower(btrim($1)) ORDER BY id LIMIT 1`, [name]);
  if (rows.rows.length) return rows.rows[0].id;
  const inserted = await client.query(`INSERT INTO public.companies(name,domain,industry,country,crm_created_by)
    VALUES($1,$2,'Mock freight','China',$3) RETURNING id`, [name, `${name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}.mock`, userId]);
  return inserted.rows[0].id;
}

async function ensureContact(client, input) {
  const rows = await client.query(`SELECT id FROM public.contacts WHERE company_id=$1 AND lower(email)=lower($2) LIMIT 1`, [input.companyId, input.email]);
  if (rows.rows.length) {
    await client.query(`UPDATE public.contacts SET first_name=$2,last_name=$3,title=$4,country=$5,crm_touch_status=$6,updated_at=now() WHERE id=$1`, [
      rows.rows[0].id, input.firstName, input.lastName, input.title, input.country, input.touch,
    ]);
    return rows.rows[0].id;
  }
  const inserted = await client.query(`INSERT INTO public.contacts(
      email,company_id,first_name,last_name,title,country,client_type,language,stage,status,tags,extra,assignee,source,source_detail,
      source_level1,source_level2,created_at,updated_at,crm_touch_status)
    VALUES($1,$2,$3,$4,$5,$6,'agent','en','f2','',$7::jsonb,$8::jsonb,'',$9,$10,'Mock团队画布',$11,now(),now(),$12)
    RETURNING id`, [
    input.email, input.companyId, input.firstName, input.lastName, input.title, input.country,
    JSON.stringify([]), JSON.stringify({ note: input.note }), SCENARIO_SOURCE, input.note, input.key, input.touch,
  ]);
  return inserted.rows[0].id;
}

async function ensureCustomer(client, input) {
  const rows = await client.query(`SELECT customer_id AS "customerId" FROM public.crm_customers
    WHERE source=$1 AND customer_key=$2 FOR UPDATE`, [SCENARIO_SOURCE, input.key]);
  if (rows.rows.length) {
    const customerId = rows.rows[0].customerId;
    await client.query(`UPDATE public.crm_customers SET company_id=$2,owner_user_id=$3,created_by=$4,state='owned',origin='operations',
      source_detail=$5,relationship_stage=$6,version=version+1 WHERE customer_id=$1`, [
      customerId, input.companyId, input.ownerUserId, input.creatorUserId, input.sourceDetail, input.stage,
    ]);
    return customerId;
  }
  const customerId = randomUUID();
  await client.query(`INSERT INTO public.crm_customers(customer_id,company_id,source,customer_key,source_detail,state,owner_user_id,created_by,
      origin,business_type,source_created_at,relationship_stage,created_at)
    VALUES($1,$2,$3,$4,$5,'owned',$6,$7,'operations','Mock freight',now(),$8,now())`, [
    customerId, input.companyId, SCENARIO_SOURCE, input.key, input.sourceDetail, input.ownerUserId, input.creatorUserId, input.stage,
  ]);
  return customerId;
}

async function ensureCustomerContact(client, customerId, contactId) {
  await client.query(`INSERT INTO public.crm_customer_contacts(customer_id,contact_id) VALUES($1,$2)
    ON CONFLICT DO NOTHING`, [customerId, contactId]);
}

async function ensureAssignmentRequest(client, input) {
  const existing = await client.query(`SELECT request_id AS "requestId" FROM public.crm_contact_assignment_requests
    WHERE customer_id=$1 AND contact_id=$2 AND target_user_id=$3 AND status='accepted' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
  [input.customerId, input.contactId, input.targetUserId]);
  let requestId;
  let groupId;
  if (existing.rows.length) {
    requestId = existing.rows[0].requestId;
    const group = await client.query(`SELECT group_id AS "groupId" FROM public.crm_contact_assignment_group_members WHERE request_id=$1 LIMIT 1`, [requestId]);
    groupId = group.rows[0]?.groupId ?? randomUUID();
    if (!group.rows.length) await client.query(`INSERT INTO public.crm_contact_assignment_group_members(group_id,request_id) VALUES($1,$2)`, [groupId, requestId]);
  } else {
    requestId = randomUUID();
    groupId = randomUUID();
    await client.query(`INSERT INTO public.crm_contact_assignment_requests(
        request_id,contact_id,customer_id,target_user_id,actor_id,notify_user_ids,status,version,created_at,decided_at,expires_at,
        supervisor_user_ids,source_org_unit_id,source_org_unit_name)
      VALUES($1,$2,$3,$4,$5,$6::uuid[],'accepted',2,$7,$8,$9,$10::uuid[],$11,$12)`, [
      requestId, input.contactId, input.customerId, input.targetUserId, input.actorId,
      [...new Set([input.targetUserId, input.actorId, ...input.supervisorUserIds])], iso(-4), iso(-3),
      iso(3), input.supervisorUserIds, input.sourceUnitId, input.sourceUnitName,
    ]);
    await client.query(`INSERT INTO public.crm_contact_assignment_group_members(group_id,request_id) VALUES($1,$2)`, [groupId, requestId]);
  }
  const ownership = await client.query(`SELECT ownership_id FROM public.crm_contact_ownership
    WHERE contact_id=$1 AND customer_id=$2 AND owner_user_id=$3 AND ended_at IS NULL LIMIT 1`, [input.contactId, input.customerId, input.targetUserId]);
  if (!ownership.rows.length) {
    await client.query(`INSERT INTO public.crm_contact_ownership(contact_id,customer_id,owner_user_id,assignment_request_id,source_org_unit_id,started_at,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [input.contactId, input.customerId, input.targetUserId, requestId, input.sourceUnitId, iso(-3), input.actorId]);
  }
  await client.query(`INSERT INTO public.crm_assignment_history(customer_id,owner_user_id,actor_id,created_at)
    SELECT $1,$2,$3,$4 WHERE NOT EXISTS (SELECT 1 FROM public.crm_assignment_history WHERE customer_id=$1 AND owner_user_id=$2 AND actor_id=$3 AND created_at=$4)`,
  [input.customerId, input.targetUserId, input.actorId, iso(-3)]);
  return { requestId, groupId };
}

async function ensureMail(client, input) {
  const old = await client.query(`SELECT event_id AS "eventId" FROM public.crm_contact_mail_events WHERE event_key=$1 LIMIT 1`, [input.eventKey]);
  if (old.rows.length) return old.rows[0].eventId;
  const activity = await client.query(`INSERT INTO public.crm_shared_activities(customer_id,interaction_id,actor_id,note,method,occurred_at,recorded_at,created_at,contact_id,contact_status)
    VALUES($1,NULL,$2,$3,'email',$4,$4,$4,$5,$6) RETURNING id::text`, [
    input.customerId, input.ownerUserId, input.subject, input.occurredAt, input.contactId, input.direction === 'inbound' ? 'replied' : 'contacted',
  ]);
  const eventId = randomUUID();
  const fingerprint = digest([eventId, input.eventKey, input.kind, input.direction, input.subject, input.preview, input.fromEmail, input.toEmails]);
  await client.query(`INSERT INTO public.crm_contact_mail_events(
      event_id,actor_id,contact_id,customer_id,event_key,mailbox_key,message_key,kind,direction,occurred_at,subject,preview,
      from_email,to_emails,cc_emails,digest,recorded_at,activity_id,send_stage_advanced)
    VALUES($1,$2,$3,$4,$5,'mock-canvas',$6,$7,$8,$9,$10,$11,$12,$13::jsonb,'[]'::jsonb,$14,$9,$15,$16)`, [
    eventId, input.ownerUserId, input.contactId, input.customerId, input.eventKey, input.messageKey, input.kind, input.direction,
    input.occurredAt, input.subject, input.preview, input.fromEmail, JSON.stringify(input.toEmails), fingerprint, activity.rows[0].id,
    input.kind === 'sent',
  ]);
  return eventId;
}

async function ensureTasksAndOpportunity(client, input) {
  const openTitle = `跟进 ${input.companyName} 的报价确认`;
  await client.query(`INSERT INTO public.crm_followup_tasks(customer_id,title,due_at,status,version,created_by,source_responsible_user_id,source_contact_id)
    SELECT $1,$2,$3,'open',1,$4,$4,$5
    WHERE NOT EXISTS (SELECT 1 FROM public.crm_followup_tasks WHERE customer_id=$1 AND title=$2)`, [
    input.customerId, openTitle, iso(1, 10), input.owner.userId, input.contactId,
  ]);
  if (input.index % 2 === 0) {
    const completedTitle = `完成 ${input.companyName} 首轮报价`;
    await client.query(`INSERT INTO public.crm_followup_tasks(customer_id,title,due_at,status,version,created_by,completed_at,completed_by,feedback,source_responsible_user_id,source_contact_id)
      SELECT $1,$2,$3,'completed',2,$4,$5,$4,'Mock 已完成首轮报价',$4,$6
      WHERE NOT EXISTS (SELECT 1 FROM public.crm_followup_tasks WHERE customer_id=$1 AND title=$2)`, [
      input.customerId, completedTitle, iso(-2, 15), input.owner.userId, iso(-1, 15), input.contactId,
    ]);
  }

  const existing = await client.query(`SELECT opportunity_id AS "opportunityId" FROM public.crm_opportunities
    WHERE customer_id=$1 AND title=$2 LIMIT 1`, [input.customerId, input.title]);
  let opportunityId = existing.rows[0]?.opportunityId;
  if (!opportunityId) {
    opportunityId = randomUUID();
    const closed = input.stage === 'closed_won';
    await client.query(`INSERT INTO public.crm_opportunities(
        opportunity_id,customer_id,title,description,pol,pod,container_type,source,stage,amount,currency,evidence,
        version,created_by,created_at,updated_at,closed_at,closed_by)
      VALUES($1,$2,$3,$4,'Shanghai',$5,'40HQ','Mock 团队画布',$6,$7,'USD',$8,1,$9,$10,$10,$11,$12)`, [
      opportunityId, input.customerId, input.title, 'Mock 全链路报价与订舱机会', input.country, input.stage,
      input.amount, closed ? 'Mock confirmation from customer' : null, input.owner.userId, iso(-2, 11),
      closed ? iso(-1, 17) : null, closed ? input.owner.userId : null,
    ]);
    await client.query(`INSERT INTO public.crm_opportunity_stage_history(
        opportunity_id,from_stage,to_stage,actor_id,occurred_at,amount,currency,evidence)
      VALUES($1,'inquiry',$2,$3,$4,$5,'USD',$6)`, [
      opportunityId, input.stage, input.owner.userId, iso(-1, 12), input.amount,
      input.stage === 'closed_won' ? 'Mock confirmation from customer' : null,
    ]);
  }
}

async function seedInteraction(client, input) {
  const owner = input.owner;
  const creator = input.creator;
  const companyId = await ensureCompany(client, input.companyName, creator.userId);
  const contactId = await ensureContact(client, {
    companyId, email: input.contactEmail, firstName: input.firstName, lastName: input.lastName,
    title: 'Commercial Manager', country: input.country, touch: 'replied', key: input.key, note: input.sourceDetail,
  });
  const customerId = await ensureCustomer(client, {
    key: input.key, companyId, ownerUserId: owner.userId, creatorUserId: creator.userId,
    sourceDetail: input.sourceDetail, stage: input.stage,
  });
  await ensureCustomerContact(client, customerId, contactId);
  const assignment = await ensureAssignmentRequest(client, {
    contactId, customerId, targetUserId: owner.userId, actorId: input.actor.userId,
    supervisorUserIds: input.supervisorUserIds, sourceUnitId: input.sourceUnitId, sourceUnitName: JADE_TEAM_NAME,
  });
  const mails = [
    ['sent', 'outbound', `Quotation for ${input.companyName}`, 'Sharing the latest ocean freight quotation and available sailing schedule.'],
    ['replied', 'inbound', `Re: Quotation for ${input.companyName}`, 'Thanks, the rate is workable. Please confirm the booking window and cut-off.'],
    ['sent', 'outbound', `Re: Quotation for ${input.companyName}`, 'Confirmed. I have reserved the proposed sailing window and shared the cut-off details.'],
  ];
  for (const [index, [kind, direction, subject, preview]] of mails.entries()) {
    const occurredAt = iso(-2 + index, 9 + (input.index % 6));
    await ensureMail(client, {
      eventKey: `${SCENARIO_SOURCE}:${input.key}:${kind}:${index}`,
      messageKey: `mock-canvas:${input.key}:${kind}:${index}`,
      customerId, contactId, ownerUserId: owner.userId, kind, direction, occurredAt, subject, preview,
      fromEmail: direction === 'outbound' ? owner.email : input.contactEmail,
      toEmails: direction === 'outbound' ? [input.contactEmail] : [owner.email],
    });
  }
  await ensureTasksAndOpportunity(client, {
    customerId, contactId, owner, companyName: input.companyName, country: input.country,
    index: input.index, title: `${input.companyName} · ${input.key}`,
    stage: input.index % 4 === 0 ? 'closed_won' : input.index % 3 === 0 ? 'negotiation' : 'quote_sent',
    amount: (1800 + input.index * 125.5).toFixed(2),
  });
  return {
    key: input.key, companyId, contactId, customerId, ownerUserId: owner.userId,
    ownerEmail: owner.email, ownerName: owner.displayName, companyName: input.companyName,
    contactEmail: input.contactEmail, contactName: `${input.firstName} ${input.lastName}`,
    country: input.country, sourceDetail: input.sourceDetail, requestId: assignment.requestId, groupId: assignment.groupId,
  };
}

function localUserDataRoot() {
  if (!process.env.APPDATA) fail('无法确定开发端 userData');
  return path.join(process.env.APPDATA, USER_DATA_DIRECTORY);
}

function localProfileRoot(userId) {
  const key = createHash('sha256').update(JSON.stringify(['http://127.0.0.1:55847', userId])).digest('hex');
  return path.join(localUserDataRoot(), 'accounts', key);
}

function buildLocalSchemaBundle() {
  fs.mkdirSync(path.dirname(LOCAL_SCHEMA_BUNDLE), { recursive: true });
  buildSync({ entryPoints: ['src/main/db/schema-sql.ts'], outfile: LOCAL_SCHEMA_BUNDLE, bundle: true, platform: 'node', format: 'cjs', packages: 'external' });
  delete require.cache[require.resolve(LOCAL_SCHEMA_BUNDLE)];
  return require(LOCAL_SCHEMA_BUNDLE).BASE_SCHEMA_SQL;
}

function resetLocalProfiles() {
  const accountsRoot = path.join(localUserDataRoot(), 'accounts');
  if (!fs.existsSync(accountsRoot)) return;
  const resolved = path.resolve(accountsRoot);
  const expected = path.resolve(localUserDataRoot(), 'accounts');
  if (resolved !== expected) fail('本地账号目录校验失败');
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
}

function seedLocalProfile(account, records, schemaSql) {
  const root = localProfileRoot(account.userId);
  const dataRoot = path.join(root, 'data');
  fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(root, 'send'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, 'desktop-local-binding.json'), JSON.stringify({
    version: 1, owner: { baseUrl: 'http://127.0.0.1:55847', userId: account.userId },
  }), { encoding: 'utf8', mode: 0o600 });
  const db = new Constructor(path.join(dataRoot, 'prospector.db'));
  try {
    db.pragma('journal_mode=WAL');
    db.pragma('synchronous=FULL');
    db.function('search_latin', { deterministic: true }, searchLatin);
    db.exec(schemaSql);
    db.exec(`CREATE TABLE IF NOT EXISTS inbox_mail_analyses (
      message_id INTEGER PRIMARY KEY REFERENCES inbox_messages(id) ON DELETE CASCADE,
      content_hash TEXT NOT NULL,category TEXT NOT NULL,priority TEXT NOT NULL,requires_action INTEGER NOT NULL DEFAULT 0,
      summary TEXT NOT NULL,next_action TEXT,due_hint TEXT,confidence REAL NOT NULL,evidence_json TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'ai',analyzer_version TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'ready',error TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`);
    db.exec(`CREATE TABLE IF NOT EXISTS inbox_todo_states (
      message_id INTEGER PRIMARY KEY REFERENCES inbox_messages(id) ON DELETE CASCADE,
      state TEXT NOT NULL CHECK(state IN ('open','done')),operation_key TEXT NOT NULL UNIQUE,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`);
    db.prepare(`INSERT OR IGNORE INTO email_accounts(email,provider,smtp_host,smtp_port,imap_host,imap_port,encrypted_pass,display_name,is_active)
      VALUES(?,?,?,?,?,?,?,?,0)`).run(account.email, 'mock', null, null, null, null, '', `${account.displayName} Mock Inbox`);
    const accountId = Number(db.prepare('SELECT id FROM email_accounts WHERE email=?').get(account.email).id);
    const insertContact = db.prepare(`INSERT INTO contacts(email,company_id,first_name,last_name,title,country,client_type,language,stage,status,tags,extra,assignee,source,source_detail,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertInteraction = db.prepare(`INSERT INTO interactions(contact_id,type,direction,channel,subject,body_preview,message_id,account_id,metadata,created_at)
      VALUES(?,'email',?, 'email',?,?,?,?,?,?)`);
    const insertInbox = db.prepare(`INSERT INTO inbox_messages(account_id,message_id,from_email,from_name,subject,body_preview,classification,"to",my_role,matched_contact_id,is_read,received_at,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertAnalysis = db.prepare(`INSERT OR REPLACE INTO inbox_mail_analyses(message_id,content_hash,category,priority,requires_action,summary,next_action,due_hint,confidence,evidence_json,source,analyzer_version,status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'ready')`);
    for (const [recordIndex, record] of records.entries()) {
      const [firstName, ...lastNameParts] = record.contactName.split(' ');
      const localContact = insertContact.run(record.contactEmail, record.companyId, firstName, lastNameParts.join(' '), 'Commercial Manager',
        record.country, 'agent', 'en', 'f2', 'replied', JSON.stringify([]), JSON.stringify({ note: `Mock 团队画布 ${record.key}` }), '',
        'mock-team-canvas', record.sourceDetail, iso(-3), iso(-1));
      const contactId = Number(localContact.lastInsertRowid);
      const mails = [
        ['sent', 'outbound', `Quotation for ${record.companyName}`, 'Sharing the latest ocean freight quotation and sailing schedule.'],
        ['replied', 'inbound', `Re: Quotation for ${record.companyName}`, 'The rate is workable. Please confirm booking window and cut-off.'],
        ['sent', 'outbound', `Re: Quotation for ${record.companyName}`, 'Confirmed. I have reserved the proposed sailing and shared cut-off details.'],
      ];
      for (const [mailIndex, [classification, direction, subject, preview]] of mails.entries()) {
        const messageId = `mock-canvas:${account.userId}:${record.key}:${mailIndex}`;
        const receivedAt = iso(-2 + mailIndex, 9 + (recordIndex % 6));
        const inbound = direction === 'inbound';
        insertInteraction.run(contactId, direction, subject, preview, messageId, accountId, '{}', receivedAt);
        const message = insertInbox.run(accountId, messageId, inbound ? record.contactEmail : account.email,
          inbound ? record.contactName : account.displayName, subject, preview, classification,
          inbound ? account.email : record.contactEmail, inbound ? 'to' : 'from', contactId, inbound ? 0 : 1, receivedAt, receivedAt);
        if (inbound) {
          const localMessageId = Number(message.lastInsertRowid);
          insertAnalysis.run(localMessageId, digest([messageId, subject, preview]), '客户回复', 'high', 1,
            `${record.companyName} 已回复报价并询问订舱窗口`, '确认船期、截关和订舱窗口', '今天',
            0.93, JSON.stringify(['inbound', 'quotation', 'booking_window']), 'rule', 'mock-canvas-v1');
          db.prepare(`INSERT OR REPLACE INTO inbox_todo_states(message_id,state,operation_key) VALUES(?,'open',?)`)
            .run(localMessageId, `mock-canvas:${messageId}:todo`);
        }
      }
    }
  } finally {
    db.close();
  }
}

function seedAllLocalProfiles(accounts, records) {
  const schemaSql = buildLocalSchemaBundle();
  for (const account of accounts) {
    const visible = account.roles.includes('admin') || account.roles.includes('operations')
      ? records
      : records.filter(record => record.ownerUserId === account.userId);
    seedLocalProfile(account, visible, schemaSql);
  }
}

async function main() {
  const resetAll = process.argv.includes('--reset-all');
  const config = readConfig();
  const passwords = new PasswordAdapter(1);
  await passwords.initialize();
  const sharedPassword = randomBytes(24).toString('hex');
  const passwordHash = await passwords.hash(sharedPassword);
  const pool = new Pool({ host: config.host, port: config.port, database: config.database, user: config.app, password: config.appPassword, max: 2, application_name: 'seed-team-canvas-scenario' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('statement_timeout','30000',true)");
    await client.query('SELECT pg_advisory_xact_lock(19042903)');
    if (resetAll) {
      await client.query('TRUNCATE TABLE public.identity_users, public.crm_org_units, public.companies, public.contacts RESTART IDENTITY CASCADE');
      log('WARN', '已按 --reset-all 清空本机开发中心账号、团队、联系人和关联业务数据');
    }

    const admin = await ensureAccount(client, { email: 'admin@yqn.com', displayName: 'Zayne', roles: ['admin'], identityAdmin: true }, passwordHash);
    const jade = await ensureAccount(client, { email: 'jade_zhou@yqn.com', displayName: 'Jade', roles: ['operations'], identityAdmin: false }, passwordHash);
    const milogin = await ensureAccount(client, { email: 'milogin@qq.com', displayName: 'milogin', roles: ['sales'], identityAdmin: false }, passwordHash);
    const iris = await ensureAccount(client, { email: 'iris_li@yqn.com', displayName: 'Iris', roles: ['sales'], identityAdmin: false }, passwordHash);

    const members = [];
    const irisMembers = [];
    const credentials = { marker: 'prospector-team-canvas-credentials-v1', accounts: [
      { email: admin.email, password: sharedPassword, role: 'admin' },
      { email: jade.email, password: sharedPassword, role: 'operations' },
      { email: milogin.email, password: sharedPassword, role: 'sales' },
      { email: iris.email, password: sharedPassword, role: 'sales' },
    ] };
    for (let index = 1; index <= MEMBER_COUNT; index += 1) {
      const suffix = String(index).padStart(2, '0');
      const account = await ensureAccount(client, {
        email: `mock.canvas.member.${suffix}@yqn.com`, displayName: `Mock 画布成员 ${suffix}`,
        roles: ['sales'], identityAdmin: false,
      }, passwordHash);
      members.push(account);
      credentials.accounts.push({ email: account.email, password: sharedPassword, role: 'sales' });
    }
    for (let index = 1; index <= IRIS_MEMBER_COUNT; index += 1) {
      const suffix = String(index).padStart(2, '0');
      const account = await ensureAccount(client, {
        email: `mock.iris.member.${suffix}@yqn.com`, displayName: `Mock Iris 成员 ${suffix}`,
        roles: ['sales'], identityAdmin: false,
      }, passwordHash);
      irisMembers.push(account);
      credentials.accounts.push({ email: account.email, password: sharedPassword, role: 'sales' });
    }

    let company = (await client.query(`SELECT unit_id AS "unitId" FROM public.crm_org_units WHERE kind='company' AND dissolved_at IS NULL ORDER BY created_at LIMIT 1 FOR UPDATE`)).rows[0];
    if (!company) {
      company = { unitId: randomUUID() };
      await client.query(`INSERT INTO public.crm_org_units(unit_id,kind,parent_unit_id,name,created_by)
        VALUES($1,'company',NULL,'Milogin',$2)`, [company.unitId, admin.userId]);
    }
    const dissolved = await dissolveOldTeams(client, company.unitId, admin.userId);
    const jadeTeamId = await ensureTeam(client, { name: JADE_TEAM_NAME, kind: 'operations_group', parentUnitId: company.unitId, createdBy: jade.userId });
    const daisyTeamId = await ensureTeam(client, { name: DAISY_TEAM_NAME, kind: 'sales_team', parentUnitId: jadeTeamId, createdBy: milogin.userId });
    const irisTeamId = await ensureTeam(client, { name: IRIS_TEAM_NAME, kind: 'sales_team', parentUnitId: jadeTeamId, createdBy: iris.userId });

    const allCanvasUsers = [jade.userId, milogin.userId, iris.userId, ...members.map(member => member.userId), ...irisMembers.map(member => member.userId)];
    await endAssignmentsOutside(client, allCanvasUsers, [jadeTeamId, daisyTeamId, irisTeamId]);
    await ensureAssignment(client, jade.userId, jadeTeamId, 'leader', true);
    await ensureAssignment(client, milogin.userId, daisyTeamId, 'leader', true);
    await ensureAssignment(client, iris.userId, irisTeamId, 'leader', true);
    for (const member of members) await ensureAssignment(client, member.userId, daisyTeamId, 'member', false);
    for (const member of irisMembers) await ensureAssignment(client, member.userId, irisTeamId, 'member', false);

    const records = [];
    records.push(await seedInteraction(client, {
      key: 'milogin-jade-route', companyName: 'Mock Jade Logistics', contactEmail: 'amelia.route@jade-logistics.mock',
      firstName: 'Amelia', lastName: 'Route', country: 'Chile', sourceDetail: 'Jade 分配给 milogin 的南美客户线索',
      stage: 'quoting', index: 0, owner: milogin, creator: jade, actor: jade,
      supervisorUserIds: [jade.userId], sourceUnitId: jadeTeamId,
    }));
    for (const [index, member] of members.entries()) {
      const suffix = String(index + 1).padStart(2, '0');
      records.push(await seedInteraction(client, {
        key: `member-${suffix}`, companyName: `Mock Canvas Client ${suffix}`,
        contactEmail: `contact.${suffix}@canvas-client.mock`, firstName: 'Canvas', lastName: `Contact ${suffix}`,
        country: ['Mexico','Brazil','India','Pakistan','Vietnam','Turkey','Egypt','Chile','Peru','Colombia','Morocco','Ghana'][index] ?? 'China',
        sourceDetail: `milogin 从 ${JADE_TEAM_NAME} 线索池分配给 ${member.displayName}`,
        stage: index % 3 === 0 ? 'trial' : 'quoting', index: index + 1,
        owner: member, creator: jade, actor: milogin,
        supervisorUserIds: [jade.userId, milogin.userId], sourceUnitId: jadeTeamId,
      }));
    }
    records.push(await seedInteraction(client, {
      key: 'iris-jade-route', companyName: 'Mock Iris Logistics', contactEmail: 'ethan.quote@iris-logistics.mock',
      firstName: 'Ethan', lastName: 'Quote', country: 'United Arab Emirates', sourceDetail: 'Jade 分配给 Iris 的中东客户线索',
      stage: 'quoting', index: 13, owner: iris, creator: jade, actor: jade,
      supervisorUserIds: [jade.userId], sourceUnitId: jadeTeamId,
    }));
    for (const [index, member] of irisMembers.entries()) {
      const suffix = String(index + 1).padStart(2, '0');
      records.push(await seedInteraction(client, {
        key: `iris-member-${suffix}`, companyName: `Mock Iris Client ${suffix}`,
        contactEmail: `contact.${suffix}@iris-client.mock`, firstName: 'Iris', lastName: `Contact ${suffix}`,
        country: ['Saudi Arabia','United Arab Emirates','Oman','Qatar','Kuwait','Jordan'][index] ?? 'China',
        sourceDetail: `Iris 从 ${JADE_TEAM_NAME} 线索池分配给 ${member.displayName}`,
        stage: index % 2 === 0 ? 'trial' : 'quoting', index: index + 14,
        owner: member, creator: jade, actor: iris,
        supervisorUserIds: [jade.userId, iris.userId], sourceUnitId: jadeTeamId,
      }));
    }

    await client.query('COMMIT');
    fs.mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
    const manifest = {
      marker: 'prospector-team-canvas-scenario-v1', createdAt: new Date().toISOString(), source: SCENARIO_SOURCE,
      admin, jade, milogin, iris, teams: [{ name: JADE_TEAM_NAME, teamId: jadeTeamId }, { name: DAISY_TEAM_NAME, teamId: daisyTeamId }, { name: IRIS_TEAM_NAME, teamId: irisTeamId }],
      members: members.map(member => ({ userId: member.userId, displayName: member.displayName, email: member.email })),
      irisMembers: irisMembers.map(member => ({ userId: member.userId, displayName: member.displayName, email: member.email })),
      records, dissolvedOldTeams: dissolved,
    };
    protectedText(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
    protectedText(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2));
    const localAccounts = [
      { ...admin, roles: ['admin'] },
      { ...jade, roles: ['operations'] },
      { ...milogin, roles: ['sales'] },
      { ...iris, roles: ['sales'] },
      ...members.map(member => ({ ...member, roles: ['sales'] })),
      ...irisMembers.map(member => ({ ...member, roles: ['sales'] })),
    ];
    if (resetAll) resetLocalProfiles();
    seedAllLocalProfiles(localAccounts, records);
    log('INFO', `完成：Jade=${jadeTeamId} Daisy=${daisyTeamId} Iris=${irisTeamId} 成员=${members.length + irisMembers.length} 线索=${records.length}`);
    process.stdout.write(JSON.stringify({ ok: true, ...manifest, credentialsFile: CREDENTIALS_PATH }, null, 2));
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* transaction may already be closed */ }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(error => {
  log('ERROR', error instanceof Error ? error.stack || error.message : '写入失败');
  process.exitCode = 1;
});
