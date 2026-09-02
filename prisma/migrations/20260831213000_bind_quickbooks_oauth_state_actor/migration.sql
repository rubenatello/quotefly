-- OAuth state is browser-session and actor bound. Remove only expired or
-- otherwise orphaned one-time states that cannot satisfy the new membership
-- relationship, then enforce the composite tenant boundary in PostgreSQL.
--
-- QuickBooksOAuthState is FORCE RLS. The migration owner is intentionally a
-- non-superuser without BYPASSRLS, so temporarily relax FORCE (not ENABLE)
-- inside this transaction. PostgreSQL rolls the table flag back if any later
-- statement fails, and FORCE is restored before commit.
BEGIN;

ALTER TABLE "QuickBooksOAuthState" NO FORCE ROW LEVEL SECURITY;

DELETE FROM "QuickBooksOAuthState" state
WHERE NOT EXISTS (
  SELECT 1
  FROM "TenantUser" membership
  WHERE membership."tenantId" = state."tenantId"
    AND membership."userId" = state."userId"
);

ALTER TABLE "QuickBooksOAuthState"
ADD CONSTRAINT "QuickBooksOAuthState_tenantId_userId_fkey"
FOREIGN KEY ("tenantId", "userId")
REFERENCES "TenantUser" ("tenantId", "userId")
ON DELETE CASCADE
ON UPDATE CASCADE;

CREATE INDEX "QuickBooksOAuthState_tenantId_userId_idx"
ON "QuickBooksOAuthState"("tenantId", "userId");

ALTER TABLE "QuickBooksOAuthState" FORCE ROW LEVEL SECURITY;

-- Record the one safe company-correction path distinctly from an ordinary
-- reconnect while retaining the immutable lifecycle-event constraint.
ALTER TABLE "QuickBooksConnectionEvent"
  DROP CONSTRAINT "QuickBooksConnectionEvent_action_check";

ALTER TABLE "QuickBooksConnectionEvent"
  ADD CONSTRAINT "QuickBooksConnectionEvent_action_check"
  CHECK (
    "action" IN (
      'CONNECT_STARTED',
      'CONNECTED',
      'RECONNECTED',
      'COMPANY_SWITCHED',
      'SETUP_CONFIRMED',
      'DISCONNECT_REQUESTED',
      'DISCONNECTED'
    )
  );

COMMIT;
