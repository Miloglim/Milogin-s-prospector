import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {failure,success,type Result} from '../../core/crm';

export const CONTACT_ASSIGNMENT_GROUP_VERSION='050-contact-assignment-groups';
export const CONTACT_ASSIGNMENT_GROUP_SQL=`
CREATE TABLE IF NOT EXISTS crm_contact_assignment_group_members(
 group_id uuid NOT NULL,
 request_id uuid PRIMARY KEY REFERENCES crm_contact_assignment_requests(request_id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_contact_assignment_group_member ON crm_contact_assignment_group_members(group_id,request_id);
`;

export async function migrateContactAssignmentGroups(c:PoolClient):Promise<Result<void>>{
 const checksum=createHash('sha256').update(CONTACT_ASSIGNMENT_GROUP_SQL).digest('hex');
 const old=await c.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1',[CONTACT_ASSIGNMENT_GROUP_VERSION]);
 if(old.rows.length&&old.rows[0].checksum!==checksum)return failure('CONFLICT','分配组迁移校验不一致');
 if(!old.rows.length){await c.query(CONTACT_ASSIGNMENT_GROUP_SQL);await c.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)',[CONTACT_ASSIGNMENT_GROUP_VERSION,checksum]);}
 return success(undefined);
}
