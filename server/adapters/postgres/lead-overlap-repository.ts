import type { PoolClient } from 'pg';
import { DEAL_OVERLAP_EVENT } from '../../core/lead-ingress';

export async function recordImportOverlapsIn(
  c: PoolClient,
  customerId: string,
  contactIds: readonly number[],
): Promise<number> {
  if (!contactIds.length) return 0;
  const exact = await c.query(`INSERT INTO crm_lead_overlaps(
    source_contact_id,target_contact_id,source_customer_id,target_customer_id,match_type
  )
  SELECT source.id,target.id,source_customer.customer_id,target_customer.customer_id,'same_email'
  FROM contacts source
  JOIN crm_customers source_customer ON source_customer.customer_id=$1
  JOIN contacts target ON target.id<>source.id AND target.crm_deleted_at IS NULL
    AND lower(btrim(target.email))=lower(btrim(source.email))
  JOIN crm_customer_contacts target_link ON target_link.contact_id=target.id
  JOIN crm_customers target_customer ON target_customer.customer_id=target_link.customer_id
  WHERE source.id=ANY($2::int[]) AND source.crm_deleted_at IS NULL AND source.email IS NOT NULL
    AND target_customer.customer_id<>source_customer.customer_id
    AND NOT(target_customer.origin=source_customer.origin AND target_customer.owner_user_id IS NOT DISTINCT FROM source_customer.owner_user_id)
  ON CONFLICT(source_contact_id,target_contact_id,match_type) DO NOTHING`, [customerId, [...contactIds]]);

  const company = await c.query(`INSERT INTO crm_lead_overlaps(
    source_contact_id,target_contact_id,source_customer_id,target_customer_id,match_type
  )
  SELECT source.id,target.id,source_customer.customer_id,target_customer.customer_id,'same_company_country'
  FROM contacts source
  JOIN crm_customers source_customer ON source_customer.customer_id=$1
  JOIN contacts target ON target.id<>source.id AND target.company_id=source.company_id AND target.crm_deleted_at IS NULL
    AND lower(COALESCE(target.email,'')) IS DISTINCT FROM lower(COALESCE(source.email,''))
  JOIN crm_customer_contacts target_link ON target_link.contact_id=target.id
  JOIN crm_customers target_customer ON target_customer.customer_id=target_link.customer_id
  WHERE source.id=ANY($2::int[]) AND source.crm_deleted_at IS NULL
    AND target_customer.customer_id<>source_customer.customer_id
    AND NOT(target_customer.origin=source_customer.origin AND target_customer.owner_user_id IS NOT DISTINCT FROM source_customer.owner_user_id)
  ON CONFLICT(source_contact_id,target_contact_id,match_type) DO NOTHING`, [customerId, [...contactIds]]);

  return (exact.rowCount ?? 0) + (company.rowCount ?? 0);
}

export async function createDealOverlapNoticesIn(
  c: PoolClient,
  input: { customerId: string; opportunityId: string; actorId: string; version: number; companyName: string; contactName: string },
): Promise<number> {
  const inserted = await c.query<{ notice_id: string; overlap_id: string; recipient_user_id: string; winner_contact_id: number }>(`WITH related AS (
    SELECT ol.overlap_id,
      CASE WHEN ol.source_customer_id=$1 THEN ol.source_contact_id ELSE ol.target_contact_id END AS winner_contact_id,
      CASE WHEN ol.source_customer_id=$1 THEN ol.target_customer_id ELSE ol.source_customer_id END AS other_customer_id
    FROM crm_lead_overlaps ol
    WHERE (ol.source_customer_id=$1 OR ol.target_customer_id=$1) AND ol.status IN ('open','confirmed')
  ), notices AS (
    INSERT INTO crm_deal_overlap_notices(overlap_id,winner_contact_id,recipient_user_id,opportunity_id)
    SELECT related.overlap_id,related.winner_contact_id,other_customer.owner_user_id,$2
    FROM related JOIN crm_customers other_customer ON other_customer.customer_id=related.other_customer_id
    WHERE other_customer.owner_user_id IS NOT NULL AND other_customer.owner_user_id<>$3
    ON CONFLICT(opportunity_id,recipient_user_id,overlap_id) DO NOTHING
    RETURNING notice_id,overlap_id,recipient_user_id,winner_contact_id
  )
  SELECT * FROM notices`, [input.customerId, input.opportunityId, input.actorId]);

  if (inserted.rows.length) {
    await c.query(`INSERT INTO public.identity_outbox(event_type,user_id,product_id,revision,customer_id,payload,recipient_user_ids)
      SELECT $1,$2,'crm',$3,$4::uuid,jsonb_build_object(
        'customerId',$4::text,'version',$3::integer,'opportunityId',$5::text,'noticeId',n.notice_id::text,
        'overlapId',n.overlap_id::text,'contactId',n.winner_contact_id,'companyName',$6::text,'contactName',$7::text
      ),ARRAY[n.recipient_user_id]::uuid[]
      FROM jsonb_to_recordset($8::jsonb) AS n(notice_id uuid,overlap_id uuid,recipient_user_id uuid,winner_contact_id integer)`, [
      DEAL_OVERLAP_EVENT, input.actorId, input.version, input.customerId, input.opportunityId,
      input.companyName, input.contactName, JSON.stringify(inserted.rows),
    ]);
    await c.query(`UPDATE crm_lead_overlaps SET status='won',updated_at=clock_timestamp()
      WHERE overlap_id=ANY($1::uuid[])`, [inserted.rows.map(row => row.overlap_id)]);
  }
  return inserted.rowCount ?? 0;
}
