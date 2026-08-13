-- AI retrieval rows contain customer notes, quote scope, embeddings, and audit
-- metadata. Application filters remain mandatory, while these policies make a
-- missed filter fail closed at the PostgreSQL boundary.

ALTER TABLE "AiRetrievalDocument" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiRetrievalDocument" FORCE ROW LEVEL SECURITY;

ALTER TABLE "AiRetrievalChunk" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiRetrievalChunk" FORCE ROW LEVEL SECURITY;

ALTER TABLE "AiRetrievalAuditEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiRetrievalAuditEvent" FORCE ROW LEVEL SECURITY;

-- Keep migrations on the owning role, but require the API to use a dedicated
-- login that cannot bypass RLS. Neon creates this role only when it is absent;
-- operators set/rotate LOGIN credentials outside migrations.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'quotefly_runtime') THEN
        CREATE ROLE quotefly_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    END IF;
END
$$;

ALTER ROLE quotefly_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
-- A reused role must not retain membership in a more privileged role. NOINHERIT
-- blocks implicit privileges, but an existing membership could still permit
-- SET ROLE after a credential compromise.
DO $$
DECLARE
    granted_role RECORD;
BEGIN
    FOR granted_role IN
        SELECT parent.rolname
        FROM pg_auth_members membership
        INNER JOIN pg_roles parent ON parent.oid = membership.roleid
        INNER JOIN pg_roles member_role ON member_role.oid = membership.member
        WHERE member_role.rolname = 'quotefly_runtime'
    LOOP
        EXECUTE format('REVOKE %I FROM quotefly_runtime', granted_role.rolname);
    END LOOP;
END
$$;
DO $$
BEGIN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO quotefly_runtime', current_database());
END
$$;
GRANT USAGE ON SCHEMA public TO quotefly_runtime;
REVOKE CREATE ON SCHEMA public FROM quotefly_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO quotefly_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO quotefly_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO quotefly_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO quotefly_runtime;

ALTER TABLE "AiUsageEvent"
    DROP CONSTRAINT IF EXISTS "AiUsageEvent_retrievalAuditEventId_fkey";

DROP INDEX IF EXISTS "AiUsageEvent_retrievalAuditEventId_key";

ALTER TABLE "AiUsageEvent"
    ADD COLUMN "retrievalAuditTenantId" TEXT;

UPDATE "AiUsageEvent"
SET "retrievalAuditTenantId" = "tenantId"
WHERE "retrievalAuditEventId" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "AiRetrievalAuditEvent_id_tenantId_key"
    ON "AiRetrievalAuditEvent"("id", "tenantId");

CREATE UNIQUE INDEX IF NOT EXISTS "AiUsageEvent_retrievalAuditEventId_retrievalAuditTenantId_key"
    ON "AiUsageEvent"("retrievalAuditEventId", "retrievalAuditTenantId");

ALTER TABLE "AiUsageEvent"
    ADD CONSTRAINT "AiUsageEvent_retrieval_audit_tenant_match_check"
    CHECK (
        ("retrievalAuditEventId" IS NULL AND "retrievalAuditTenantId" IS NULL)
        OR
        ("retrievalAuditEventId" IS NOT NULL AND "retrievalAuditTenantId" = "tenantId")
    );

ALTER TABLE "AiUsageEvent"
    ADD CONSTRAINT "AiUsageEvent_retrievalAuditEventId_retrievalAuditTenantId_fkey"
    FOREIGN KEY ("retrievalAuditEventId", "retrievalAuditTenantId")
    REFERENCES "AiRetrievalAuditEvent"("id", "tenantId")
    ON DELETE SET NULL ON UPDATE CASCADE;

DROP POLICY IF EXISTS "AiRetrievalDocument_tenant_isolation" ON "AiRetrievalDocument";
CREATE POLICY "AiRetrievalDocument_tenant_isolation"
    ON "AiRetrievalDocument"
    FOR ALL
    USING (
        "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')
    )
    WITH CHECK (
        "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')
    );

DROP POLICY IF EXISTS "AiRetrievalChunk_tenant_isolation" ON "AiRetrievalChunk";
CREATE POLICY "AiRetrievalChunk_tenant_isolation"
    ON "AiRetrievalChunk"
    FOR ALL
    USING (
        "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')
    )
    WITH CHECK (
        "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')
    );

DROP POLICY IF EXISTS "AiRetrievalAuditEvent_tenant_isolation" ON "AiRetrievalAuditEvent";
CREATE POLICY "AiRetrievalAuditEvent_tenant_isolation"
    ON "AiRetrievalAuditEvent"
    FOR ALL
    USING (
        "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')
    )
    WITH CHECK (
        "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')
    );
