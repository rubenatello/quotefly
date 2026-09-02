-- Guarantee bounded retention for minimal webhook envelopes whose QuickBooks
-- realm never becomes tenant-bound. The runtime can execute a fixed purge but
-- cannot select realms, choose a cutoff, increase the batch, or bypass RLS.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'quotefly_quarantine_retention') THEN
    -- Managed PostgreSQL owners are not true superusers. New roles already
    -- default to NOSUPERUSER and NOBYPASSRLS, so do not request attributes
    -- that Neon correctly reserves for a real superuser.
    CREATE ROLE quotefly_quarantine_retention
      NOLOGIN NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'quotefly_quarantine_retention'
      AND (
        rolsuper
        OR rolbypassrls
        OR rolcanlogin
        OR rolcreatedb
        OR rolcreaterole
        OR rolinherit
        OR rolreplication
      )
  ) THEN
    RAISE EXCEPTION 'quotefly_quarantine_retention has unsafe role attributes';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_auth_members membership
    INNER JOIN pg_roles member_role ON member_role.oid = membership.member
    WHERE member_role.rolname = 'quotefly_quarantine_retention'
  ) THEN
    RAISE EXCEPTION 'quotefly_quarantine_retention must not inherit membership in another role';
  END IF;

  -- A prior interrupted/provider-managed run can leave an inert self-granted
  -- row beside the provider's bounded ADMIN grant. Remove only that exact
  -- duplicate grantor row before validating the incoming boundary.
  IF EXISTS (
    SELECT 1
    FROM pg_auth_members membership
    INNER JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
    INNER JOIN pg_roles member_role ON member_role.oid = membership.member
    INNER JOIN pg_roles grantor_role ON grantor_role.oid = membership.grantor
    WHERE granted_role.rolname = 'quotefly_quarantine_retention'
      AND member_role.rolname = current_user
      AND grantor_role.rolname = current_user
      AND NOT membership.admin_option
      AND NOT membership.set_option
      AND NOT membership.inherit_option
  ) AND EXISTS (
    SELECT 1
    FROM pg_auth_members membership
    INNER JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
    INNER JOIN pg_roles member_role ON member_role.oid = membership.member
    WHERE granted_role.rolname = 'quotefly_quarantine_retention'
      AND member_role.rolname = current_user
      AND membership.admin_option
      AND NOT membership.set_option
      AND NOT membership.inherit_option
  ) THEN
    EXECUTE format(
      'REVOKE quotefly_quarantine_retention FROM %I GRANTED BY %I',
      current_user,
      current_user
    );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_auth_members membership
    INNER JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
    INNER JOIN pg_roles member_role ON member_role.oid = membership.member
    WHERE granted_role.rolname = 'quotefly_quarantine_retention'
      AND (
        member_role.rolname <> current_user
        OR NOT membership.admin_option
        OR membership.set_option
        OR membership.inherit_option
      )
  ) THEN
    RAISE EXCEPTION 'quotefly_quarantine_retention has an unsafe incoming membership';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO quotefly_quarantine_retention;
GRANT CREATE ON SCHEMA public TO quotefly_quarantine_retention;
GRANT SELECT, DELETE ON TABLE "QuickBooksWebhookEvent" TO quotefly_quarantine_retention;

CREATE POLICY "QuickBooksWebhookEvent_global_quarantine_retention_read"
  ON "QuickBooksWebhookEvent" FOR SELECT TO quotefly_quarantine_retention
  USING (
    current_setting('app.quickbooks_webhook_global_quarantine_retention', true) = '1'
    AND "tenantId" IS NULL
    AND "quickBooksConnectionId" IS NULL
    AND "status" = 'RECEIVED'
    AND "lastError" = 'QUICKBOOKS_REALM_UNBOUND'
    AND "payload" = '{"quarantined": true}'::jsonb
    AND "receivedAtUtc" <= clock_timestamp() - INTERVAL '7 days'
  );

CREATE POLICY "QuickBooksWebhookEvent_global_quarantine_retention_delete"
  ON "QuickBooksWebhookEvent" FOR DELETE TO quotefly_quarantine_retention
  USING (
    current_setting('app.quickbooks_webhook_global_quarantine_retention', true) = '1'
    AND "tenantId" IS NULL
    AND "quickBooksConnectionId" IS NULL
    AND "status" = 'RECEIVED'
    AND "lastError" = 'QUICKBOOKS_REALM_UNBOUND'
    AND "payload" = '{"quarantined": true}'::jsonb
    AND "receivedAtUtc" <= clock_timestamp() - INTERVAL '7 days'
  );

CREATE FUNCTION public.quotefly_purge_quickbooks_unknown_realm_quarantine()
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

REVOKE ALL ON FUNCTION public.quotefly_purge_quickbooks_unknown_realm_quarantine() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.quotefly_purge_quickbooks_unknown_realm_quarantine()
  TO quotefly_runtime;
-- PostgreSQL 16 grants a role creator ADMIN but not SET by default. Temporarily
-- enable SET for the owner transfer, then retain only a non-inheriting,
-- non-SET admin membership so later databases in the same cluster can repeat
-- this migration without a superuser.
GRANT quotefly_quarantine_retention TO CURRENT_USER
  WITH SET TRUE, INHERIT FALSE;
ALTER FUNCTION public.quotefly_purge_quickbooks_unknown_realm_quarantine()
  OWNER TO quotefly_quarantine_retention;
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
