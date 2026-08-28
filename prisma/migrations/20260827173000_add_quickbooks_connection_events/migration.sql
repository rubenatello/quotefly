-- Immutable, content-free QuickBooks connection lifecycle evidence. These
-- rows intentionally exclude provider identifiers, scopes, tokens, payloads,
-- company data, and raw errors.

CREATE TABLE "QuickBooksConnectionEvent" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "quickBooksConnectionId" TEXT,
  "actorTenantUserId" TEXT,
  "requestId" VARCHAR(128) NOT NULL,
  "action" VARCHAR(40) NOT NULL,
  "outcome" VARCHAR(24) NOT NULL,
  "connectionGeneration" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "QuickBooksConnectionEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "QuickBooksConnectionEvent_request_check" CHECK (char_length(btrim("requestId")) > 0),
  CONSTRAINT "QuickBooksConnectionEvent_action_check" CHECK (
    "action" IN (
      'CONNECT_STARTED',
      'CONNECTED',
      'RECONNECTED',
      'SETUP_CONFIRMED',
      'DISCONNECT_REQUESTED',
      'DISCONNECTED'
    )
  ),
  CONSTRAINT "QuickBooksConnectionEvent_outcome_check" CHECK (
    "outcome" IN ('PENDING', 'SUCCEEDED')
  ),
  CONSTRAINT "QuickBooksConnectionEvent_generation_check" CHECK ("connectionGeneration" > 0)
);

CREATE UNIQUE INDEX "QuickBooksConnectionEvent_id_tenantId_key"
  ON "QuickBooksConnectionEvent"("id", "tenantId");
CREATE INDEX "QuickBooksConnectionEvent_tenant_created_idx"
  ON "QuickBooksConnectionEvent"("tenantId", "createdAt", "id");
CREATE INDEX "QuickBooksConnectionEvent_connection_generation_idx"
  ON "QuickBooksConnectionEvent"("quickBooksConnectionId", "tenantId", "connectionGeneration", "createdAt");
CREATE INDEX "QuickBooksConnectionEvent_actor_created_idx"
  ON "QuickBooksConnectionEvent"("tenantId", "actorTenantUserId", "createdAt");

ALTER TABLE "QuickBooksConnectionEvent"
  ADD CONSTRAINT "QuickBooksConnectionEvent_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "QuickBooksConnectionEvent"
  ADD CONSTRAINT "QuickBooksConnectionEvent_connection_tenant_fkey"
  FOREIGN KEY ("quickBooksConnectionId", "tenantId")
  REFERENCES "QuickBooksConnection"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "QuickBooksConnectionEvent"
  ADD CONSTRAINT "QuickBooksConnectionEvent_actor_tenant_fkey"
  FOREIGN KEY ("actorTenantUserId", "tenantId")
  REFERENCES "TenantUser"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "QuickBooksConnectionEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "QuickBooksConnectionEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY "QuickBooksConnectionEvent_tenant_isolation"
  ON "QuickBooksConnectionEvent" FOR ALL
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''));

-- Runtime application code can read and append lifecycle evidence. It cannot
-- alter or remove history, even when tenant RLS is set.
REVOKE UPDATE, DELETE, TRUNCATE ON "QuickBooksConnectionEvent" FROM quotefly_runtime;
GRANT SELECT, INSERT ON "QuickBooksConnectionEvent" TO quotefly_runtime;
