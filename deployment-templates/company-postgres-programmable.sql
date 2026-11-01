CREATE OR REPLACE FUNCTION prospector.crm_contact_change_capture() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = prospector, public
    AS $_$
BEGIN
 IF NEW.product_id='crm' AND NEW.customer_id IS NOT NULL AND (
   NEW.event_type = ANY(ARRAY[
     'crm.contact.updated','crm.contact.followup','crm.contact.deleted',
     'crm.contact.assignment.requested','crm.contact.assignment.accepted',
     'crm.contact.assignment.rejected','crm.contact.assignment.cancelled',
     'crm.contact.assignment.expired','crm.contact.assignment.transfer_requested',
     'crm.contact.assignment.transferred','crm.contact.assignment.transfer_cancelled',
     'crm.contact.share.accepted','crm.contact.share.revoked','crm.contact.share.updated'
   ]) OR NEW.event_type = ANY(ARRAY['crm.customer.created','crm.customer.updated'])
 ) THEN
  INSERT INTO crm_contact_changes(event_id,recipient_user_id,contact_id,customer_id,event_type,version)
  SELECT NEW.event_id,u.user_id,ct.id,NEW.customer_id,NEW.event_type,COALESCE(NEW.revision,1)
  FROM crm_customer_contacts cc JOIN contacts ct ON ct.id=cc.contact_id CROSS JOIN public.identity_users u
  LEFT JOIN public.identity_product_access pa ON pa.user_id=u.user_id AND pa.product_id='crm' AND pa.active
  LEFT JOIN public.identity_product_grants g ON g.user_id=u.user_id AND g.product_id='crm' AND g.active AND g.role='admin'
  WHERE cc.customer_id=NEW.customer_id
    AND ((NEW.event_type = ANY(ARRAY['crm.customer.created','crm.customer.updated'])) OR ((NEW.payload->>'contactId') ~ '^[0-9]+$' AND ct.id=(NEW.payload->>'contactId')::integer))
    AND u.active AND NOT u.must_change_password AND pa.user_id IS NOT NULL
    AND (u.user_id=NEW.user_id OR u.user_id=ANY(COALESCE(NEW.recipient_user_ids,'{}'::uuid[])) OR (g.user_id IS NOT NULL AND pa.scope IN ('shared','summary') AND (u.identity_admin OR pa.capabilities IS NULL OR jsonb_exists(pa.capabilities, 'leads.read.all'))))
  ON CONFLICT(event_id,recipient_user_id,contact_id) DO NOTHING;
 END IF;
 RETURN NEW;
END $_$;

CREATE OR REPLACE FUNCTION prospector.crm_opportunities_customer_owner_changed() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = prospector, public
    AS $$
BEGIN
 IF OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id THEN
  UPDATE crm_opportunities SET version=version+1,updated_at=clock_timestamp() WHERE customer_id=NEW.customer_id AND stage NOT IN ('closed_won','closed_lost');
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION prospector.crm_opportunity_history_append_only() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = prospector, public
    AS $$
BEGIN RAISE EXCEPTION 'Opportunity stage history is append only' USING ERRCODE='23514'; END $$;

CREATE OR REPLACE FUNCTION prospector.crm_tasks_customer_owner_changed() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = prospector, public
    AS $$
BEGIN
 IF OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id THEN
  UPDATE crm_followup_tasks SET version=version+1,updated_at=clock_timestamp() WHERE customer_id=NEW.customer_id AND status='open';
 END IF;
 RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS crm_contact_change_capture ON public.identity_outbox;
CREATE TRIGGER crm_contact_change_capture AFTER INSERT ON public.identity_outbox FOR EACH ROW EXECUTE FUNCTION prospector.crm_contact_change_capture();

DROP TRIGGER IF EXISTS crm_opportunities_customer_owner_changed ON prospector.crm_customers;
CREATE TRIGGER crm_opportunities_customer_owner_changed AFTER UPDATE OF owner_user_id ON prospector.crm_customers FOR EACH ROW EXECUTE FUNCTION prospector.crm_opportunities_customer_owner_changed();

DROP TRIGGER IF EXISTS crm_opportunity_history_append_only ON prospector.crm_opportunity_stage_history;
CREATE TRIGGER crm_opportunity_history_append_only BEFORE DELETE OR UPDATE ON prospector.crm_opportunity_stage_history FOR EACH ROW EXECUTE FUNCTION prospector.crm_opportunity_history_append_only();

DROP TRIGGER IF EXISTS crm_tasks_customer_owner_changed ON prospector.crm_customers;
CREATE TRIGGER crm_tasks_customer_owner_changed AFTER UPDATE OF owner_user_id ON prospector.crm_customers FOR EACH ROW EXECUTE FUNCTION prospector.crm_tasks_customer_owner_changed();

CREATE OR REPLACE FUNCTION prospector.crm_validate_org_unit_hierarchy() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = prospector, public
    AS $$
DECLARE
  parent_kind text;
  cycle_found boolean;
BEGIN
  IF NEW.kind='company' THEN
    IF NEW.parent_unit_id IS NOT NULL THEN RAISE EXCEPTION 'company root cannot have a parent'; END IF;
    RETURN NEW;
  END IF;
  SELECT kind INTO parent_kind FROM prospector.crm_org_units WHERE unit_id=NEW.parent_unit_id;
  IF parent_kind IS NULL THEN RAISE EXCEPTION 'organization parent does not exist'; END IF;
  IF parent_kind='sales_team' THEN RAISE EXCEPTION 'sales teams are leaves'; END IF;
  IF NEW.kind='operations_group' AND parent_kind<>'company' THEN RAISE EXCEPTION 'operations groups must be under the company'; END IF;
  IF NEW.kind='sales_team' AND parent_kind NOT IN ('company','operations_group') THEN RAISE EXCEPTION 'sales teams must be under the company or an operations group'; END IF;
  IF TG_OP='UPDATE' AND NEW.parent_unit_id IS DISTINCT FROM OLD.parent_unit_id THEN
    WITH RECURSIVE ancestors(unit_id,parent_unit_id) AS (
      SELECT unit_id,parent_unit_id FROM prospector.crm_org_units WHERE unit_id=NEW.parent_unit_id
      UNION ALL SELECT u.unit_id,u.parent_unit_id FROM prospector.crm_org_units u JOIN ancestors a ON u.unit_id=a.parent_unit_id
    ) SELECT EXISTS(SELECT 1 FROM ancestors WHERE unit_id=NEW.unit_id) INTO cycle_found;
    IF cycle_found THEN RAISE EXCEPTION 'organization cycle'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION prospector.crm_validate_org_assignment() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = prospector, public
    AS $$
DECLARE unit_kind text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id::text, 0));
  SELECT kind INTO unit_kind FROM prospector.crm_org_units WHERE unit_id=NEW.unit_id AND dissolved_at IS NULL;
  IF unit_kind IS NULL OR unit_kind='company' THEN RAISE EXCEPTION 'organization unit is not assignable'; END IF;
  IF NEW.role='member' THEN
    IF unit_kind<>'sales_team' THEN RAISE EXCEPTION 'only sales teams accept members'; END IF;
    IF EXISTS(SELECT 1 FROM prospector.crm_org_assignments WHERE user_id=NEW.user_id AND role='leader' AND ended_at IS NULL) THEN RAISE EXCEPTION 'leader cannot also be an ordinary member'; END IF;
  ELSIF NEW.role='leader' THEN
    IF EXISTS(SELECT 1 FROM prospector.crm_org_assignments WHERE user_id=NEW.user_id AND role='member' AND ended_at IS NULL) THEN RAISE EXCEPTION 'ordinary member cannot also be a leader'; END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_crm_org_unit_hierarchy ON prospector.crm_org_units;
CREATE TRIGGER trg_crm_org_unit_hierarchy BEFORE INSERT OR UPDATE OF parent_unit_id,kind ON prospector.crm_org_units
FOR EACH ROW EXECUTE FUNCTION prospector.crm_validate_org_unit_hierarchy();

DROP TRIGGER IF EXISTS trg_crm_org_assignment_kind ON prospector.crm_org_assignments;
CREATE TRIGGER trg_crm_org_assignment_kind BEFORE INSERT OR UPDATE OF user_id,unit_id,role ON prospector.crm_org_assignments
FOR EACH ROW EXECUTE FUNCTION prospector.crm_validate_org_assignment();

CREATE OR REPLACE FUNCTION prospector.crm_reject_team_monitoring_audit_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = prospector, public
    AS $$
BEGIN
  RAISE EXCEPTION 'team monitoring audits are append-only';
END
$$;
DROP TRIGGER IF EXISTS trg_crm_team_monitoring_audits_immutable ON prospector.crm_team_monitoring_audits;
CREATE TRIGGER trg_crm_team_monitoring_audits_immutable
BEFORE UPDATE OR DELETE ON prospector.crm_team_monitoring_audits
FOR EACH ROW EXECUTE FUNCTION prospector.crm_reject_team_monitoring_audit_change();

CREATE OR REPLACE FUNCTION prospector.crm_reject_customer_grade_audit_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = prospector, public
    AS $$
BEGIN
  RAISE EXCEPTION 'customer grade audit is append only';
END
$$;
DROP TRIGGER IF EXISTS trg_crm_customer_grade_audit_immutable ON prospector.crm_customer_grade_override_audits;
CREATE TRIGGER trg_crm_customer_grade_audit_immutable
BEFORE UPDATE OR DELETE ON prospector.crm_customer_grade_override_audits
FOR EACH ROW EXECUTE FUNCTION prospector.crm_reject_customer_grade_audit_change();

CREATE OR REPLACE FUNCTION prospector.crm_reject_org_dissolution_audit_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = prospector, public
    AS $$
BEGIN
  RAISE EXCEPTION 'organization dissolution audits are append-only';
END
$$;
DROP TRIGGER IF EXISTS trg_crm_org_dissolution_audits_immutable ON prospector.crm_org_dissolution_audits;
CREATE TRIGGER trg_crm_org_dissolution_audits_immutable
BEFORE UPDATE OR DELETE ON prospector.crm_org_dissolution_audits
FOR EACH ROW EXECUTE FUNCTION prospector.crm_reject_org_dissolution_audit_change();

CREATE OR REPLACE VIEW navigator.freight_rates AS
 SELECT id,
    content_key,
    record_type,
    pol,
    pod,
    route,
    carrier,
    container_type,
    price_usd,
    vessel_voyage,
    cutoff_raw,
    box_desc,
    box_qty,
    space_type,
    validity_raw,
    valid_from,
    valid_to,
    etd,
    free_days,
    dead_freight,
    transit_days,
    remark,
    source_group,
    sender,
    message_time,
    message_text,
    image_url,
    status,
    overridden_time,
    synced_at,
    mid,
    image_file,
    supersedes,
    origin,
    ai_flag,
    price_usd AS freight_usd
   FROM navigator.freight_items
  WHERE (record_type = 'rates'::text);

CREATE OR REPLACE VIEW navigator.space_records AS
 SELECT id,
    content_key,
    record_type,
    pol,
    pod,
    route,
    carrier,
    container_type,
    price_usd,
    vessel_voyage,
    cutoff_raw,
    box_desc,
    box_qty,
    space_type,
    validity_raw,
    valid_from,
    valid_to,
    etd,
    free_days,
    dead_freight,
    transit_days,
    remark,
    source_group,
    sender,
    message_time,
    message_text,
    image_url,
    status,
    overridden_time,
    synced_at,
    mid,
    image_file,
    supersedes,
    origin,
    ai_flag
   FROM navigator.freight_items
  WHERE (record_type = 'space'::text);
