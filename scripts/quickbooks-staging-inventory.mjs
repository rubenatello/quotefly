import { PrismaClient } from "@prisma/client";

if (process.env.RAILWAY_ENVIRONMENT_NAME !== "staging") {
  console.error("This count-only inventory may run only in the Railway staging environment.");
  process.exit(1);
}

const sourceUrl = process.env.DIRECT_DATABASE_URL?.trim();
if (!sourceUrl) {
  console.error("DIRECT_DATABASE_URL is required from the isolated staging migration service.");
  process.exit(1);
}

const parsedUrl = new URL(sourceUrl);
const databaseName = parsedUrl.pathname.replace(/^\//, "");
if (!databaseName) {
  console.error("The staging database name could not be determined.");
  process.exit(1);
}

process.env.DATABASE_URL = sourceUrl;
const prisma = new PrismaClient();

try {
  const [
    runtimeRole,
    connections,
    connectionEvents,
    customerMaps,
    itemMaps,
    invoiceSyncs,
    invoiceOperations,
    webhookEvents,
    oauthStates,
    orphanRevocations,
    realmBindings,
    cdcCursors,
    quickBooksPayments,
    providerInvoiceEvents,
  ] = await Promise.all([
    prisma.$queryRawUnsafe(`
      SELECT
        rolcanlogin AS "canLogin",
        rolsuper AS superuser,
        rolbypassrls AS "bypassRls",
        rolcreatedb AS "createDatabase",
        rolcreaterole AS "createRole",
        rolinherit AS inherits,
        rolreplication AS replication,
        rolpassword IS NOT NULL AS "passwordConfigured"
      FROM pg_roles
      WHERE rolname = 'quotefly_runtime'
    `),
    prisma.quickBooksConnection.count(),
    prisma.quickBooksConnectionEvent.count(),
    prisma.quickBooksCustomerMap.count(),
    prisma.quickBooksItemMap.count(),
    prisma.quickBooksInvoiceSync.count(),
    prisma.quickBooksInvoiceOperation.count(),
    prisma.quickBooksWebhookEvent.count(),
    prisma.quickBooksOAuthState.count(),
    prisma.quickBooksOrphanCredentialRevocation.count(),
    prisma.quickBooksRealmBinding.count(),
    prisma.quickBooksCdcCursor.count(),
    prisma.invoicePayment.count({ where: { provider: "QUICKBOOKS" } }),
    prisma.invoiceEvent.count({
      where: {
        OR: [
          { providerEventId: { not: null } },
          {
            type: {
              in: [
                "PROVIDER_SYNC_STARTED",
                "PROVIDER_SYNC_SUCCEEDED",
                "PROVIDER_SYNC_FAILED",
                "PROVIDER_RECONCILIATION_REQUIRED",
                "PROVIDER_RECONCILED",
              ],
            },
          },
        ],
      },
    }),
  ]);

  console.log(JSON.stringify({
    database: databaseName,
    runtimeRole,
    counts: {
      connections,
      connectionEvents,
      customerMaps,
      itemMaps,
      invoiceSyncs,
      invoiceOperations,
      webhookEvents,
      oauthStates,
      orphanRevocations,
      realmBindings,
      cdcCursors,
      quickBooksPayments,
      providerInvoiceEvents,
    },
  }));
} finally {
  await prisma.$disconnect();
}
