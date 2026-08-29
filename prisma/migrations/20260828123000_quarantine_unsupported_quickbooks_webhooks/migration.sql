-- Signed provider notifications whose operation QuoteFly cannot reconcile are
-- persisted before acknowledgement, but never enter the fetch/retry worker.
-- Unknown-realm envelopes remain content-minimal and share the same bounded
-- retention path as other unbound webhook quarantine rows.

DROP POLICY "QuickBooksWebhookEvent_global_quarantine_retention_read"
  ON "QuickBooksWebhookEvent";
DROP POLICY "QuickBooksWebhookEvent_global_quarantine_retention_delete"
  ON "QuickBooksWebhookEvent";

CREATE POLICY "QuickBooksWebhookEvent_global_quarantine_retention_read"
  ON "QuickBooksWebhookEvent" FOR SELECT TO quotefly_quarantine_retention
  USING (
    current_setting('app.quickbooks_webhook_global_quarantine_retention', true) = '1'
    AND "tenantId" IS NULL
    AND "quickBooksConnectionId" IS NULL
    AND "status" = 'RECEIVED'
    AND "lastError" IN ('QUICKBOOKS_REALM_UNBOUND', 'QUICKBOOKS_WEBHOOK_OPERATION_UNSUPPORTED')
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
    AND "lastError" IN ('QUICKBOOKS_REALM_UNBOUND', 'QUICKBOOKS_WEBHOOK_OPERATION_UNSUPPORTED')
    AND "payload" = '{"quarantined": true}'::jsonb
    AND "receivedAtUtc" <= clock_timestamp() - INTERVAL '7 days'
  );

GRANT CREATE ON SCHEMA public TO quotefly_quarantine_retention;
GRANT quotefly_quarantine_retention TO CURRENT_USER;

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
      AND event."lastError" IN ('QUICKBOOKS_REALM_UNBOUND', 'QUICKBOOKS_WEBHOOK_OPERATION_UNSUPPORTED')
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
    AND event."lastError" IN ('QUICKBOOKS_REALM_UNBOUND', 'QUICKBOOKS_WEBHOOK_OPERATION_UNSUPPORTED')
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
REVOKE quotefly_quarantine_retention FROM CURRENT_USER;
REVOKE CREATE ON SCHEMA public FROM quotefly_quarantine_retention;
