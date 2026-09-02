import { PrismaClient } from "@prisma/client";

const databaseArgument = process.argv.find((argument) => argument.startsWith("--database="));
const databaseName = databaseArgument?.slice("--database=".length).trim();

if (!databaseName || !databaseName.toLowerCase().includes("test")) {
  console.error("A database name containing 'test' is required.");
  process.exit(1);
}

const sourceUrl = process.env.DIRECT_DATABASE_URL?.trim() || process.env.TEST_DATABASE_URL?.trim();
if (!sourceUrl) {
  console.error("DIRECT_DATABASE_URL or TEST_DATABASE_URL is required.");
  process.exit(1);
}

const databaseUrl = new URL(sourceUrl);
databaseUrl.pathname = `/${databaseName}`;
process.env.DATABASE_URL = databaseUrl.toString();

const prisma = new PrismaClient();

try {
  const identity = await prisma.$queryRawUnsafe(`
    SELECT
      current_database() AS database,
      current_user AS "migrationUser",
      current_setting('server_version_num')::int AS "serverVersion",
      role.rolsuper AS superuser,
      role.rolbypassrls AS "bypassRls"
    FROM pg_roles role
    WHERE role.rolname = current_user
  `);
  const role = await prisma.$queryRawUnsafe(`
    SELECT
      rolcanlogin AS "canLogin",
      rolsuper AS superuser,
      rolbypassrls AS "bypassRls",
      rolcreatedb AS "createDatabase",
      rolcreaterole AS "createRole",
      rolinherit AS inherits,
      rolreplication AS replication
    FROM pg_roles
    WHERE rolname = 'quotefly_quarantine_retention'
  `);
  const incomingMemberships = await prisma.$queryRawUnsafe(`
    SELECT
      member_role.rolname AS member,
      grantor_role.rolname AS grantor,
      membership.admin_option AS "adminOption",
      membership.set_option AS "setOption",
      membership.inherit_option AS "inheritOption"
    FROM pg_auth_members membership
    INNER JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
    INNER JOIN pg_roles member_role ON member_role.oid = membership.member
    INNER JOIN pg_roles grantor_role ON grantor_role.oid = membership.grantor
    WHERE granted_role.rolname = 'quotefly_quarantine_retention'
    ORDER BY member, grantor
  `);
  const outgoingMemberships = await prisma.$queryRawUnsafe(`
    SELECT granted_role.rolname AS role
    FROM pg_auth_members membership
    INNER JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
    INNER JOIN pg_roles member_role ON member_role.oid = membership.member
    WHERE member_role.rolname = 'quotefly_quarantine_retention'
    ORDER BY role
  `);
  const functions = await prisma.$queryRawUnsafe(`
    SELECT
      owner_role.rolname AS owner,
      routine.prosecdef AS "securityDefiner",
      EXISTS (
        SELECT 1
        FROM aclexplode(COALESCE(routine.proacl, acldefault('f', routine.proowner))) privilege
        WHERE privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'
      ) AS "publicExecute",
      has_function_privilege('quotefly_runtime', routine.oid, 'EXECUTE') AS "runtimeExecute"
    FROM pg_proc routine
    INNER JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
    INNER JOIN pg_roles owner_role ON owner_role.oid = routine.proowner
    WHERE namespace.nspname = 'public'
      AND routine.proname = 'quotefly_purge_quickbooks_unknown_realm_quarantine'
  `);
  const grants = await prisma.$queryRawUnsafe(`
    SELECT
      has_schema_privilege('quotefly_quarantine_retention', 'public', 'CREATE') AS "schemaCreate",
      COALESCE(string_agg(privilege_type::text, ',' ORDER BY privilege_type), '') AS "tablePrivileges"
    FROM information_schema.role_table_grants
    WHERE grantee = 'quotefly_quarantine_retention'
      AND table_schema = 'public'
      AND table_name = 'QuickBooksWebhookEvent'
  `);
  const migrations = await prisma.$queryRawUnsafe(`
    SELECT
      COUNT(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL)::int AS "activeFailed",
      COUNT(*) FILTER (WHERE rolled_back_at IS NOT NULL)::int AS "resolvedRollbacks",
      COUNT(*) FILTER (WHERE finished_at IS NOT NULL)::int AS applied
    FROM "_prisma_migrations"
  `);

  console.log(JSON.stringify({
    identity,
    role,
    incomingMemberships,
    outgoingMemberships,
    functions,
    grants,
    migrations,
  }, (_, value) => typeof value === "bigint" ? Number(value) : value));
} finally {
  await prisma.$disconnect();
}
