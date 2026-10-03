-- Migration history is operational control-plane evidence. The application
-- runtime may inspect it for bounded readiness/proof, but only the dedicated
-- migration owner may change it.
REVOKE ALL PRIVILEGES ON TABLE public."_prisma_migrations"
  FROM PUBLIC, quotefly_runtime;

DO $$
DECLARE
  history_column record;
BEGIN
  FOR history_column IN
    SELECT attname
    FROM pg_attribute
    WHERE attrelid = 'public._prisma_migrations'::regclass
      AND attnum > 0
      AND NOT attisdropped
  LOOP
    EXECUTE format(
      'REVOKE INSERT (%1$I), UPDATE (%1$I), REFERENCES (%1$I) '
      'ON TABLE public."_prisma_migrations" FROM PUBLIC, quotefly_runtime',
      history_column.attname
    );
  END LOOP;
END
$$;

GRANT SELECT ON TABLE public."_prisma_migrations"
  TO quotefly_runtime;

DO $$
DECLARE
  history_oid oid := to_regclass('public._prisma_migrations');
  runtime_oid oid := to_regrole('quotefly_runtime');
BEGIN
  IF history_oid IS NULL OR runtime_oid IS NULL THEN
    RAISE EXCEPTION 'migration history hardening prerequisites are missing';
  END IF;

  IF NOT has_table_privilege(runtime_oid, history_oid, 'SELECT')
    OR has_table_privilege(runtime_oid, history_oid, 'INSERT')
    OR has_table_privilege(runtime_oid, history_oid, 'UPDATE')
    OR has_table_privilege(runtime_oid, history_oid, 'DELETE')
    OR has_table_privilege(runtime_oid, history_oid, 'TRUNCATE')
    OR has_table_privilege(runtime_oid, history_oid, 'REFERENCES')
    OR has_table_privilege(runtime_oid, history_oid, 'TRIGGER')
  THEN
    RAISE EXCEPTION 'quotefly_runtime migration history privileges are unsafe';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_attribute history_column
    WHERE history_column.attrelid = history_oid
      AND history_column.attnum > 0
      AND NOT history_column.attisdropped
      AND (
        has_column_privilege(runtime_oid, history_oid, history_column.attname, 'INSERT')
        OR has_column_privilege(runtime_oid, history_oid, history_column.attname, 'UPDATE')
        OR has_column_privilege(runtime_oid, history_oid, history_column.attname, 'REFERENCES')
      )
  ) THEN
    RAISE EXCEPTION 'quotefly_runtime retains migration history column writes';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_class history
    CROSS JOIN LATERAL aclexplode(
      COALESCE(history.relacl, acldefault('r', history.relowner))
    ) privilege
    WHERE history.oid = history_oid
      AND privilege.grantee = runtime_oid
      AND privilege.is_grantable
  ) THEN
    RAISE EXCEPTION 'quotefly_runtime can grant migration history privileges';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_class history
    CROSS JOIN LATERAL aclexplode(
      COALESCE(history.relacl, acldefault('r', history.relowner))
    ) privilege
    WHERE history.oid = history_oid
      AND privilege.grantee = 0
  ) THEN
    RAISE EXCEPTION 'PUBLIC retains migration history privileges';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_attribute history_column
    CROSS JOIN pg_class history
    CROSS JOIN LATERAL aclexplode(
      COALESCE(history_column.attacl, acldefault('c', history.relowner))
    ) privilege
    WHERE history.oid = history_oid
      AND history_column.attrelid = history_oid
      AND history_column.attnum > 0
      AND NOT history_column.attisdropped
      AND privilege.grantee = 0
  ) THEN
    RAISE EXCEPTION 'PUBLIC retains migration history column privileges';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_roles reachable_role
    WHERE reachable_role.oid <> runtime_oid
      AND (
        pg_has_role(runtime_oid, reachable_role.oid, 'USAGE')
        OR pg_has_role(runtime_oid, reachable_role.oid, 'SET')
      )
      AND (
        has_table_privilege(reachable_role.oid, history_oid, 'INSERT')
        OR has_table_privilege(reachable_role.oid, history_oid, 'UPDATE')
        OR has_table_privilege(reachable_role.oid, history_oid, 'DELETE')
        OR has_table_privilege(reachable_role.oid, history_oid, 'TRUNCATE')
        OR has_table_privilege(reachable_role.oid, history_oid, 'REFERENCES')
        OR has_table_privilege(reachable_role.oid, history_oid, 'TRIGGER')
        OR EXISTS (
          SELECT 1
          FROM pg_attribute history_column
          WHERE history_column.attrelid = history_oid
            AND history_column.attnum > 0
            AND NOT history_column.attisdropped
            AND (
              has_column_privilege(reachable_role.oid, history_oid, history_column.attname, 'INSERT')
              OR has_column_privilege(reachable_role.oid, history_oid, history_column.attname, 'UPDATE')
              OR has_column_privilege(reachable_role.oid, history_oid, history_column.attname, 'REFERENCES')
            )
        )
      )
  ) THEN
    RAISE EXCEPTION 'quotefly_runtime can reach a migration history writer role';
  END IF;

  IF NOT has_table_privilege(current_user, history_oid, 'INSERT')
    OR NOT has_table_privilege(current_user, history_oid, 'UPDATE')
    OR NOT has_table_privilege(current_user, history_oid, 'DELETE')
  THEN
    RAISE EXCEPTION 'migration owner path cannot maintain migration history';
  END IF;
END
$$;
