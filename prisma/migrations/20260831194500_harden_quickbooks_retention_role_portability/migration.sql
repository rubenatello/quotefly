-- Reassert the managed-PostgreSQL-safe role boundary for databases that
-- applied the original QuickBooks quarantine-retention migration before its
-- fresh-database portability correction.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'quotefly_quarantine_retention') THEN
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

  -- Zero incoming memberships is safe. If the PostgreSQL 16+ role creator's
  -- administrative membership is retained for later databases, it must be
  -- the current migration owner and must not permit SET or inheritance.
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

-- Existing clusters may have applied the earlier full REVOKE. Neon permits
-- its managed migration owner to restore this bounded administrative grant.
-- A generic managed provider that denies it must be repaired by that
-- provider's privileged operator; never broaden SET or INHERIT as a shortcut.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_auth_members membership
    INNER JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
    INNER JOIN pg_roles member_role ON member_role.oid = membership.member
    WHERE granted_role.rolname = 'quotefly_quarantine_retention'
      AND member_role.rolname = current_user
  ) THEN
    EXECUTE format(
      'GRANT quotefly_quarantine_retention TO %I WITH ADMIN TRUE, SET FALSE, INHERIT FALSE',
      current_user
    );
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
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
    RAISE EXCEPTION 'quotefly_quarantine_retention migration-owner membership is not safely bounded';
  END IF;
END
$$;
