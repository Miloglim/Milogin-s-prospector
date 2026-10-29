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
