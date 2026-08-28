-- Guarantee bounded retention for minimal webhook envelopes whose QuickBooks
-- realm never becomes tenant-bound. The runtime can execute a fixed purge but
-- cannot select realms, choose a cutoff, increase the batch, or bypass RLS.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'quotefly_quarantine_retention') THEN
    CREATE ROLE quotefly_quarantine_retention
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  ELSE
    ALTER ROLE quotefly_quarantine_retention
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
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
GRANT quotefly_quarantine_retention TO CURRENT_USER;
ALTER FUNCTION public.quotefly_purge_quickbooks_unknown_realm_quarantine()
  OWNER TO quotefly_quarantine_retention;
REVOKE quotefly_quarantine_retention FROM CURRENT_USER;
REVOKE CREATE ON SCHEMA public FROM quotefly_quarantine_retention;
