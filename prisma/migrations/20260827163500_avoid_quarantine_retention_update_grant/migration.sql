-- The retention role intentionally has only SELECT and DELETE. Candidate
-- selection must not require UPDATE privilege merely to acquire row locks;
-- the bounded DELETE rechecks every eligibility predicate atomically.

GRANT CREATE ON SCHEMA public TO quotefly_quarantine_retention;
GRANT quotefly_quarantine_retention TO CURRENT_USER
  WITH SET TRUE, INHERIT FALSE;
SET ROLE quotefly_quarantine_retention;

CREATE OR REPLACE FUNCTION public.quotefly_purge_quickbooks_unknown_realm_quarantine()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  acquired boolean;
  deleted_count integer := 0;
BEGIN
  SELECT pg_try_advisory_xact_lock(
    hashtextextended('quotefly:quickbooks:unknown-realm-quarantine-retention', 0)
  ) INTO acquired;

  IF NOT acquired THEN
    RETURN 0;
  END IF;

  PERFORM set_config('app.quickbooks_webhook_global_quarantine_retention', '1', true);

  WITH candidates AS (
    SELECT event."id"
    FROM public."QuickBooksWebhookEvent" event
    WHERE event."tenantId" IS NULL
      AND event."quickBooksConnectionId" IS NULL
      AND event."status" = 'RECEIVED'
      AND event."lastError" = 'QUICKBOOKS_REALM_UNBOUND'
      AND event."payload" = '{"quarantined": true}'::jsonb
      AND event."receivedAtUtc" <= clock_timestamp() - INTERVAL '7 days'
    ORDER BY event."receivedAtUtc" ASC, event."id" ASC
    LIMIT 100
  )
  DELETE FROM public."QuickBooksWebhookEvent" event
  USING candidates
  WHERE event."id" = candidates."id"
    AND event."tenantId" IS NULL
    AND event."quickBooksConnectionId" IS NULL
    AND event."status" = 'RECEIVED'
    AND event."lastError" = 'QUICKBOOKS_REALM_UNBOUND'
    AND event."payload" = '{"quarantined": true}'::jsonb
    AND event."receivedAtUtc" <= clock_timestamp() - INTERVAL '7 days';

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END
$$;

ALTER FUNCTION public.quotefly_purge_quickbooks_unknown_realm_quarantine()
  OWNER TO quotefly_quarantine_retention;
REVOKE ALL ON FUNCTION public.quotefly_purge_quickbooks_unknown_realm_quarantine() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.quotefly_purge_quickbooks_unknown_realm_quarantine()
  TO quotefly_runtime;
RESET ROLE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_auth_members membership
    INNER JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
    INNER JOIN pg_roles member_role ON member_role.oid = membership.member
    INNER JOIN pg_roles grantor_role ON grantor_role.oid = membership.grantor
    WHERE granted_role.rolname = 'quotefly_quarantine_retention'
      AND member_role.rolname = current_user
      AND grantor_role.rolname = current_user
      AND membership.admin_option
  ) THEN
    EXECUTE format(
      'GRANT quotefly_quarantine_retention TO %I WITH SET FALSE, INHERIT FALSE',
      current_user
    );
  ELSE
    EXECUTE format(
      'REVOKE quotefly_quarantine_retention FROM %I GRANTED BY %I',
      current_user,
      current_user
    );
  END IF;
END
$$;
REVOKE CREATE ON SCHEMA public FROM quotefly_quarantine_retention;
