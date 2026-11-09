import type { Prisma } from "@prisma/client";
import type { QuickBooksCredentialRuntimeEnv } from "../config/quickbooks-runtime-types";
import { decryptQuickBooksHostedPaymentLink, isQuickBooksWebhookConfigured, validateQuickBooksInvoiceLink } from "./quickbooks";
import { quickBooksInvoiceLinkAvailable, QuickBooksInvoiceOperationPublicSelect } from "./quickbooks-invoices";
import { QUICKBOOKS_SETUP_CHECKLIST_VERSION } from "./quickbooks-setup";

export type HostedPaymentLinkRuntime = QuickBooksCredentialRuntimeEnv & {
  QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: boolean;
  QUICKBOOKS_OAUTH_ONLY_MODE: boolean;
  QUICKBOOKS_RECONCILIATION_WORKER_ENABLED: boolean;
  QUICKBOOKS_HOSTED_PAYMENTS_ENABLED: boolean;
  QUICKBOOKS_WEBHOOK_VERIFIER: string;
};

export function hostedPaymentLinksEnabled(env: HostedPaymentLinkRuntime): boolean {
  return env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED
    && !env.QUICKBOOKS_OAUTH_ONLY_MODE
    && env.QUICKBOOKS_RECONCILIATION_WORKER_ENABLED
    && env.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED
    && isQuickBooksWebhookConfigured(env);
}

/** Restricted delivery reader. Callers must authenticate and revalidate a live manager first. */
export async function readQuickBooksHostedPaymentLink(
  transaction: Prisma.TransactionClient,
  env: HostedPaymentLinkRuntime,
  tenantId: string,
  invoiceId: string,
) {
  if (!hostedPaymentLinksEnabled(env)) return null;
  const operation = await transaction.quickBooksInvoiceOperation.findFirst({
    where: {
      tenantId, invoiceId, archivedAtUtc: null, status: "SUCCEEDED", taxEstimateOperationId: null,
      providerInvoiceLink: { not: null }, providerInvoiceId: { not: null },
      invoiceLinkFetchedAtUtc: { not: null }, lastReconciledAtUtc: { not: null },
      providerSyncToken: { not: null }, providerUpdatedAtUtc: { not: null },
    },
    select: {
      ...QuickBooksInvoiceOperationPublicSelect,
      connection: { select: {
        status: true, realmId: true, deletedAtUtc: true, setupConfirmedAtUtc: true,
        setupConfirmedByTenantUserId: true, setupChecklistVersion: true,
      } },
    },
  });
  const invoice = await transaction.invoice.findFirst({
    where: {
      id: invoiceId, tenantId, deletedAtUtc: null, archivedAtUtc: null, status: "OPEN",
      paymentStatus: { in: ["PENDING", "PARTIALLY_PAID", "REFUNDED", "PARTIALLY_REFUNDED"] },
      balanceDue: { gt: 0 }, voidedAtUtc: null,
      customer: { deletedAtUtc: null, archivedAtUtc: null },
      job: { deletedAtUtc: null, archivedAtUtc: null },
      sourceQuote: { deletedAtUtc: null, archivedAtUtc: null },
    },
    select: { paymentStatus: true, balanceDue: true },
  });
  if (!operation || !invoice || !(operation.allowOnlineAchPayment || operation.allowOnlineCardPayment)
    || !quickBooksInvoiceLinkAvailable(operation)) return null;
  const connection = operation.connection;
  if (connection.status !== "CONNECTED" || connection.deletedAtUtc !== null
    || !connection.setupConfirmedAtUtc || !connection.setupConfirmedByTenantUserId
    || connection.setupChecklistVersion !== QUICKBOOKS_SETUP_CHECKLIST_VERSION
    || connection.realmId !== operation.providerRealmId) return null;
  const binding = await transaction.quickBooksRealmBinding.findFirst({
    where: { tenantId, quickBooksConnectionId: operation.quickBooksConnectionId, realmId: operation.providerRealmId, active: true },
    select: { id: true },
  });
  if (!binding) return null;
  let hostedPaymentUrl: string | null;
  try {
    hostedPaymentUrl = validateQuickBooksInvoiceLink(decryptQuickBooksHostedPaymentLink(env, operation.providerInvoiceLink!));
  } catch { return null; }
  if (!hostedPaymentUrl) return null;
  return { invoiceId, provider: "QUICKBOOKS" as const, hostedPaymentUrl,
    paymentStatus: invoice.paymentStatus, balanceDue: Number(invoice.balanceDue) };
}
