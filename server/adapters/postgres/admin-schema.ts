export const ADMIN_VERSION="003-management-m1";
export const ADMIN_LOCK=19041003;
export const ADMIN_SQL=`
ALTER TABLE identity.users ADD COLUMN management_revision integer NOT NULL DEFAULT 1;
ALTER TABLE identity.sessions ADD COLUMN session_id uuid UNIQUE NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE identity.sessions ADD COLUMN client text NOT NULL DEFAULT 'api' CHECK (client IN ('api','browser'));
ALTER TABLE identity.product_grants DROP CONSTRAINT product_grants_role_check;
ALTER TABLE identity.product_grants ADD CONSTRAINT product_grants_role_check CHECK (role IN ('admin','operations','sales','auditor'));
CREATE TABLE identity.products (
 product_id text PRIMARY KEY, name text NOT NULL, connected boolean NOT NULL DEFAULT false, description text NOT NULL
);
INSERT INTO identity.products VALUES
 ('crm','Prospector',true,'测试身份与授权已接入；业务交互尚未在线接入'),
 ('navigator','Navigator',false,'成员、交互与管理审计尚未接入；此平台不提供运价查询');
CREATE TABLE identity.product_access (
 user_id uuid NOT NULL REFERENCES identity.users(user_id),product_id text NOT NULL REFERENCES identity.products(product_id),
 active boolean NOT NULL DEFAULT true,scope text NOT NULL CHECK(scope IN ('own','shared','summary')),
 capabilities jsonb CHECK(capabilities IS NULL OR jsonb_typeof(capabilities)='array'),PRIMARY KEY(user_id,product_id)
);
INSERT INTO identity.product_access(user_id,product_id,scope)
 SELECT user_id,'crm',CASE WHEN bool_or(role='admin') THEN 'summary' WHEN bool_or(role='operations') THEN 'shared' ELSE 'own' END
 FROM identity.product_grants GROUP BY user_id;
CREATE TABLE identity.management_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,actor_id uuid NOT NULL REFERENCES identity.users(user_id),
 target_id uuid REFERENCES identity.users(user_id),action text NOT NULL,product_id text REFERENCES identity.products(product_id),
 reason text NOT NULL CHECK(btrim(reason)<>''),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE identity.management_challenges (
 token_hash text PRIMARY KEY CHECK(token_hash~'^[a-f0-9]{64}$'),user_id uuid NOT NULL REFERENCES identity.users(user_id),
 purpose text NOT NULL CHECK(purpose IN ('activate','recover')),issuer_id uuid NOT NULL REFERENCES identity.users(user_id),
 email text NOT NULL,expires_at timestamptz NOT NULL,consumed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE identity.outbox (
 event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_type text NOT NULL,user_id uuid NOT NULL REFERENCES identity.users(user_id),
 product_id text REFERENCES identity.products(product_id),revision integer NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
`;
