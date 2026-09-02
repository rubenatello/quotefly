import { createHash } from "node:crypto";
import { InvoicePaymentStatus, InvoiceStatus, JobStatus, Prisma } from "@prisma/client";
import type { AccessContext } from "../lib/access-policy";
import { hasCapability } from "../lib/access-policy";
import { setTenantRlsContext } from "../lib/tenant-rls";
import {
  ensureJobForAcceptedQuote,
  JobServiceError,
  type JobPublic,
} from "./jobs";

export type InvoiceTransaction = Prisma.TransactionClient;

export class InvoiceServiceError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }
}

export const InvoicePublicSelect = {
  id: true,
  tenantId: true,
  customerId: true,
  jobId: true,
  sourceQuoteId: true,
  invoiceNumber: true,
  status: true,
  paymentStatus: true,
  titleSnapshot: true,
  documentLocale: true,
  currency: true,
  subtotalAmount: true,
  taxAmount: true,
  totalAmount: true,
  amountPaid: true,
  balanceDue: true,
  issuedAtUtc: true,
  dueAtUtc: true,
  sentAtUtc: true,
  paidAtUtc: true,
  voidedAtUtc: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  archivedAtUtc: true,
  deletedAtUtc: true,
  lineItems: {
    orderBy: [{ position: "asc" as const }, { createdAt: "asc" as const }, { id: "asc" as const }],
    select: {
      id: true,
      sourceQuoteLineItemIdSnapshot: true,
      description: true,
      sectionType: true,
      sectionLabel: true,
      position: true,
      quantity: true,
      unitPrice: true,
      lineTotal: true,
      createdAt: true,
    },
  },
  payments: {
    where: {
      provider: "QUICKBOOKS" as const,
      status: "CANCELED" as const,
      failureCode: "QUICKBOOKS_PAYMENT_REMOVED_OR_REVERSED",
      deletedAtUtc: null,
    },
    orderBy: [{ updatedAt: "desc" as const }, { id: "desc" as const }],
    take: 1,
    select: { id: true },
  },
  customer: {
    select: {
      id: true,
      fullName: true,
    },
  },
  job: {
    select: {
      id: true,
      jobNumber: true,
      status: true,
      title: true,
    },
  },
  sourceQuote: {
    select: {
      id: true,
      title: true,
      status: true,
      totalAmount: true,
    },
  },
} as const satisfies Prisma.InvoiceSelect;

export type InvoicePublic = Prisma.InvoiceGetPayload<{ select: typeof InvoicePublicSelect }>;

const INVOICE_SEQUENCE_KEY = "invoice_number";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireInvoiceManager(access: AccessContext) {
  if (!hasCapability(access, "viewAllWorkspaceRecords")) {
    throw new InvoiceServiceError(
      403,
      "INVOICE_FORBIDDEN",
      "You do not have permission to create invoices for this workspace.",
    );
  }
}

function visibleInvoiceJobWhere(access: AccessContext): Prisma.JobWhereInput {
  const manager = hasCapability(access, "viewAllWorkspaceRecords");
  return {
    archivedAtUtc: null,
    deletedAtUtc: null,
    ...(!manager
      ? {
          assignedTenantUserId: access.tenantUserId,
          customer: {
            assignedTenantUserId: access.tenantUserId,
            archivedAtUtc: null,
            deletedAtUtc: null,
          },
          sourceQuote: {
            assignedTenantUserId: access.tenantUserId,
            archivedAtUtc: null,
            deletedAtUtc: null,
          },
        }
      : {}),
  };
}

export function visibleInvoiceWhere(access: AccessContext): Prisma.InvoiceWhereInput {
  return {
    tenantId: access.tenantId,
    deletedAtUtc: null,
    archivedAtUtc: null,
    customer: {
      archivedAtUtc: null,
      deletedAtUtc: null,
    },
    job: visibleInvoiceJobWhere(access),
    sourceQuote: {
      archivedAtUtc: null,
      deletedAtUtc: null,
    },
  };
}

async function lockCommand(transaction: InvoiceTransaction, commandKeyHash: string) {
  await transaction.$queryRaw(Prisma.sql`
    SELECT 1::int AS "locked"
    FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`invoice-command:${commandKeyHash}`}, 0))) acquired
  `);
}

async function nextInvoiceNumber(transaction: InvoiceTransaction, tenantId: string): Promise<number> {
  await transaction.tenantSequence.createMany({
    data: [{
      id: `tenantseq_${tenantId}_invoice_number`,
      tenantId,
      key: INVOICE_SEQUENCE_KEY,
      nextValue: 1,
    }],
    skipDuplicates: true,
  });

  const rows = await transaction.$queryRaw<Array<{ nextValue: number }>>(Prisma.sql`
    SELECT "nextValue"
    FROM "TenantSequence"
    WHERE "tenantId" = ${tenantId}
      AND "key" = ${INVOICE_SEQUENCE_KEY}
    FOR UPDATE
  `);
  const nextValue = rows[0]?.nextValue;
  if (!nextValue || nextValue < 1) {
    throw new InvoiceServiceError(500, "INVOICE_SEQUENCE_UNAVAILABLE", "Invoice number sequence is unavailable.");
  }

  await transaction.tenantSequence.update({
    where: { tenantId_key: { tenantId, key: INVOICE_SEQUENCE_KEY } },
    data: { nextValue: nextValue + 1 },
  });
  return nextValue;
}

type LockedInvoiceJobSnapshot = {
  id: string;
  tenantId: string;
  customerId: string;
  sourceQuoteId: string;
  status: JobStatus;
  title: string;
  scopeSnapshot: string | null;
  quoteTitle: string;
  quoteStatus: string;
  quoteScopeText: string;
  quoteDocumentLocale: string;
  quoteCustomerPriceSubtotal: Prisma.Decimal;
  quoteTaxAmount: Prisma.Decimal;
  quoteTotalAmount: Prisma.Decimal;
};

type InvoiceLineSnapshot = Readonly<{
  sourceQuoteLineItemIdSnapshot: string | null;
  description: string;
  sectionType: "INCLUDED";
  sectionLabel: string | null;
  position: number;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}>;

function roundInvoiceMoney(value: number) {
  return Number(value.toFixed(2));
}

function reconcileInvoiceLineTotals(
  lines: readonly InvoiceLineSnapshot[],
  authoritativeSubtotal: number,
): InvoiceLineSnapshot[] {
  const targetCents = Math.round(authoritativeSubtotal * 100);
  const lineCents = lines.map((line) => Math.round(line.lineTotal * 100));
  let residualCents = targetCents - lineCents.reduce((sum, cents) => sum + cents, 0);

  // The quote subtotal is calculated from the aggregate before currency
  // rounding, while an invoice must persist two-decimal line totals. Allocate
  // the residual deterministically from the final line backwards so the
  // immutable invoice lines always reconcile to the authoritative subtotal.
  for (let index = lineCents.length - 1; index >= 0 && residualCents !== 0; index -= 1) {
    if (residualCents > 0) {
      lineCents[index] += residualCents;
      residualCents = 0;
      break;
    }

    const removableCents = Math.min(lineCents[index], Math.abs(residualCents));
    lineCents[index] -= removableCents;
    residualCents += removableCents;
  }

  if (residualCents !== 0) {
    throw new InvoiceServiceError(
      409,
      "INVOICE_LINE_TOTAL_RECONCILIATION_FAILED",
      "Invoice lines could not be reconciled to the accepted quote subtotal.",
    );
  }

  return lines.map((line, index) => ({
    ...line,
    lineTotal: lineCents[index]! / 100,
  }));
}

async function loadInvoiceLineSnapshots(
  transaction: InvoiceTransaction,
  snapshot: LockedInvoiceJobSnapshot,
): Promise<InvoiceLineSnapshot[]> {
  const sourceLines = await transaction.quoteLineItem.findMany({
    where: {
      tenantId: snapshot.tenantId,
      quoteId: snapshot.sourceQuoteId,
      sectionType: "INCLUDED",
      deletedAtUtc: null,
    },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      description: true,
      sectionLabel: true,
      quantity: true,
      unitPrice: true,
    },
  });
  if (sourceLines.length > 0) {
    const lineSnapshots = sourceLines.map((line, position) => {
      const quantity = Number(line.quantity);
      const unitPrice = Number(line.unitPrice);
      return {
        sourceQuoteLineItemIdSnapshot: line.id,
        description: line.description,
        sectionType: "INCLUDED" as const,
        sectionLabel: line.sectionLabel,
        position,
        quantity,
        unitPrice,
        lineTotal: roundInvoiceMoney(quantity * unitPrice),
      };
    });
    return reconcileInvoiceLineTotals(lineSnapshots, Number(snapshot.quoteCustomerPriceSubtotal));
  }

  const subtotal = Number(snapshot.quoteCustomerPriceSubtotal);
  return [{
    sourceQuoteLineItemIdSnapshot: null,
    description: snapshot.quoteTitle.trim() || snapshot.title.trim() || "Quoted work",
    sectionType: "INCLUDED",
    sectionLabel: null,
    position: 0,
    quantity: 1,
    unitPrice: subtotal,
    lineTotal: roundInvoiceMoney(subtotal),
  }];
}

async function loadLockedInvoiceJobSnapshot(
  transaction: InvoiceTransaction,
  access: AccessContext,
  params: { jobId: string; requireCompletedJob: boolean },
): Promise<LockedInvoiceJobSnapshot> {
  const rows = await transaction.$queryRaw<LockedInvoiceJobSnapshot[]>(Prisma.sql`
    SELECT
      job."id",
      job."tenantId",
      job."customerId",
      job."sourceQuoteId",
      job."status",
      job."title",
      job."scopeSnapshot",
      quote."title" AS "quoteTitle",
      quote."status" AS "quoteStatus",
      quote."scopeText" AS "quoteScopeText",
      quote."documentLocale" AS "quoteDocumentLocale",
      quote."customerPriceSubtotal" AS "quoteCustomerPriceSubtotal",
      quote."taxAmount" AS "quoteTaxAmount",
      quote."totalAmount" AS "quoteTotalAmount"
    FROM "Job" job
    INNER JOIN "Quote" quote
      ON quote."id" = job."sourceQuoteId"
     AND quote."tenantId" = job."tenantId"
     AND quote."customerId" = job."customerId"
    INNER JOIN "Customer" customer
      ON customer."id" = job."customerId"
     AND customer."tenantId" = job."tenantId"
    WHERE job."id" = ${params.jobId}
      AND job."tenantId" = ${access.tenantId}
      AND job."deletedAtUtc" IS NULL
      AND job."archivedAtUtc" IS NULL
      AND quote."deletedAtUtc" IS NULL
      AND quote."archivedAtUtc" IS NULL
      AND customer."deletedAtUtc" IS NULL
      AND customer."archivedAtUtc" IS NULL
    FOR UPDATE OF job, quote
  `);
  const job = rows[0];
  if (!job) {
    throw new InvoiceServiceError(404, "JOB_NOT_FOUND", "Job not found for tenant.");
  }
  if (job.quoteStatus !== "ACCEPTED") {
    throw new InvoiceServiceError(409, "INVOICE_QUOTE_NOT_ACCEPTED", "Only accepted quotes can be invoiced.");
  }
  if (params.requireCompletedJob && job.status !== "COMPLETED") {
    throw new InvoiceServiceError(409, "INVOICE_JOB_NOT_COMPLETED", "Complete the job before creating an invoice from the job.");
  }
  return job;
}

async function findExistingInvoiceForSource(
  transaction: InvoiceTransaction,
  access: AccessContext,
  source: { jobId: string; sourceQuoteId: string },
): Promise<InvoicePublic | null> {
  const invoice = await transaction.invoice.findFirst({
    where: {
      tenantId: access.tenantId,
      OR: [
        { jobId: source.jobId },
        { sourceQuoteId: source.sourceQuoteId },
      ],
    },
    select: InvoicePublicSelect,
  });
  if (!invoice) return null;
  if (invoice.deletedAtUtc || invoice.archivedAtUtc) {
    throw new InvoiceServiceError(
      409,
      "INVOICE_ALREADY_ARCHIVED",
      "Restore the existing invoice before creating another invoice for this job.",
    );
  }
  return invoice;
}

async function findCommandReplay(
  transaction: InvoiceTransaction,
  access: AccessContext,
  params: { commandKeyHash: string; commandPayloadHash: string },
): Promise<InvoicePublic | null> {
  const event = await transaction.invoiceEvent.findFirst({
    where: {
      tenantId: access.tenantId,
      commandKeyHash: params.commandKeyHash,
    },
    select: {
      commandPayloadHash: true,
      invoice: {
        select: InvoicePublicSelect,
      },
    },
  });
  if (!event) return null;
  if (event.commandPayloadHash !== params.commandPayloadHash) {
    throw new InvoiceServiceError(
      409,
      "INVOICE_IDEMPOTENCY_KEY_REUSED",
      "Use a new idempotency key for a different invoice request.",
    );
  }
  if (event.invoice.deletedAtUtc || event.invoice.archivedAtUtc) {
    throw new InvoiceServiceError(
      409,
      "INVOICE_REPLAY_UNAVAILABLE",
      "The invoice created by this request is no longer active.",
    );
  }
  return event.invoice;
}

function invoicePayloadHash(params: {
  jobId?: string;
  sourceQuoteId?: string;
  dueAtUtc?: Date | null;
}) {
  return sha256(JSON.stringify({
    jobId: params.jobId ?? null,
    sourceQuoteId: params.sourceQuoteId ?? null,
    dueAtUtc: params.dueAtUtc?.toISOString() ?? null,
  }));
}

function commandHash(access: AccessContext, idempotencyKey: string) {
  return sha256(`invoice-create:${access.tenantId}:${idempotencyKey}`);
}

export async function createInvoice(
  transaction: InvoiceTransaction,
  access: AccessContext,
  params: {
    jobId?: string;
    sourceQuoteId?: string;
    dueAtUtc?: Date | null;
    actorTenantUserId: string;
    requestId: string;
    idempotencyKey: string;
  },
): Promise<{ invoice: InvoicePublic; duplicate: boolean }> {
  requireInvoiceManager(access);
  await setTenantRlsContext(transaction, access.tenantId);

  const commandKeyHash = commandHash(access, params.idempotencyKey);
  const commandPayloadHash = invoicePayloadHash(params);
  await lockCommand(transaction, commandKeyHash);

  const replay = await findCommandReplay(transaction, access, { commandKeyHash, commandPayloadHash });
  if (replay) return { invoice: replay, duplicate: true };

  let jobId = params.jobId;
  if (params.sourceQuoteId) {
    let ensuredJob: JobPublic | null;
    try {
      ensuredJob = await ensureJobForAcceptedQuote(transaction, access, {
        quoteId: params.sourceQuoteId,
        actorTenantUserId: params.actorTenantUserId,
        requestId: params.requestId,
      });
    } catch (error) {
      if (error instanceof JobServiceError) {
        throw new InvoiceServiceError(error.statusCode, error.code, error.message, error.details);
      }
      throw error;
    }
    if (!ensuredJob) {
      throw new InvoiceServiceError(409, "INVOICE_QUOTE_NOT_ACCEPTED", "Only accepted quotes can be invoiced.");
    }
    jobId = ensuredJob.id;
  }

  if (!jobId) {
    throw new InvoiceServiceError(400, "INVOICE_SOURCE_REQUIRED", "Choose a job or accepted quote to invoice.");
  }

  const snapshot = await loadLockedInvoiceJobSnapshot(transaction, access, {
    jobId,
    requireCompletedJob: Boolean(params.jobId && !params.sourceQuoteId),
  });

  const existing = await findExistingInvoiceForSource(transaction, access, {
    jobId: snapshot.id,
    sourceQuoteId: snapshot.sourceQuoteId,
  });
  if (existing) {
    await transaction.invoiceEvent.create({
      data: {
        tenantId: access.tenantId,
        invoiceId: existing.id,
        actorTenantUserId: params.actorTenantUserId,
        type: "CREATE_REPLAYED",
        toStatus: existing.status,
        toPaymentStatus: existing.paymentStatus,
        requestId: params.requestId.slice(0, 191),
        commandKeyHash,
        commandPayloadHash,
      },
    });
    return { invoice: existing, duplicate: true };
  }

  const invoiceNumber = await nextInvoiceNumber(transaction, access.tenantId);
  const titleSnapshot = snapshot.title.trim() || snapshot.quoteTitle.trim() || `Invoice ${invoiceNumber}`;
  const scopeSnapshot = snapshot.scopeSnapshot?.trim() || snapshot.quoteScopeText.trim() || null;
  const lineSnapshots = await loadInvoiceLineSnapshots(transaction, snapshot);

  const createdInvoice = await transaction.invoice.create({
    data: {
      tenantId: access.tenantId,
      customerId: snapshot.customerId,
      jobId: snapshot.id,
      sourceQuoteId: snapshot.sourceQuoteId,
      invoiceNumber,
      status: "DRAFT",
      paymentStatus: "PENDING",
      titleSnapshot,
      scopeSnapshot,
      documentLocale: snapshot.quoteDocumentLocale,
      currency: "USD",
      subtotalAmount: snapshot.quoteCustomerPriceSubtotal,
      taxAmount: snapshot.quoteTaxAmount,
      totalAmount: snapshot.quoteTotalAmount,
      amountPaid: 0,
      balanceDue: snapshot.quoteTotalAmount,
      dueAtUtc: params.dueAtUtc ?? null,
    },
    select: InvoicePublicSelect,
  });

  await transaction.invoiceLineItem.createMany({
    data: lineSnapshots.map((line) => ({
      tenantId: access.tenantId,
      invoiceId: createdInvoice.id,
      ...line,
    })),
  });

  await transaction.invoiceEvent.create({
    data: {
      tenantId: access.tenantId,
      invoiceId: createdInvoice.id,
      actorTenantUserId: params.actorTenantUserId,
      type: "CREATED",
      toStatus: createdInvoice.status,
      toPaymentStatus: createdInvoice.paymentStatus,
      requestId: params.requestId.slice(0, 191),
      commandKeyHash,
      commandPayloadHash,
    },
  });

  const invoice = await transaction.invoice.findFirstOrThrow({
    where: { id: createdInvoice.id, tenantId: access.tenantId },
    select: InvoicePublicSelect,
  });
  return { invoice, duplicate: false };
}

export async function listInvoices(
  transaction: InvoiceTransaction,
  access: AccessContext,
  params: {
    mine?: boolean;
    status?: InvoiceStatus;
    paymentStatus?: InvoicePaymentStatus;
    customerId?: string;
    jobId?: string;
    sourceQuoteId?: string;
    search?: string;
    limit: number;
    offset: number;
  },
) {
  const manager = hasCapability(access, "viewAllWorkspaceRecords");
  const baseWhere = visibleInvoiceWhere(access);
  const jobWhere = visibleInvoiceJobWhere(access);
  const where: Prisma.InvoiceWhereInput = {
    ...baseWhere,
    ...(params.mine || !manager ? {
      job: {
        ...jobWhere,
        assignedTenantUserId: access.tenantUserId,
      },
    } : {}),
    ...(params.status ? { status: params.status } : {}),
    ...(params.paymentStatus ? { paymentStatus: params.paymentStatus } : {}),
    ...(params.customerId ? { customerId: params.customerId } : {}),
    ...(params.jobId ? { jobId: params.jobId } : {}),
    ...(params.sourceQuoteId ? { sourceQuoteId: params.sourceQuoteId } : {}),
  };

  if (params.search) {
    const trimmed = params.search.trim();
    const numeric = Number.parseInt(trimmed.replace(/^(inv|invoice|#)[-\s#]*/i, ""), 10);
    where.OR = [
      ...(Number.isFinite(numeric) ? [{ invoiceNumber: numeric }] : []),
      { titleSnapshot: { contains: trimmed, mode: "insensitive" } },
      { customer: { fullName: { contains: trimmed, mode: "insensitive" } } },
      { job: { title: { contains: trimmed, mode: "insensitive" } } },
      { sourceQuote: { title: { contains: trimmed, mode: "insensitive" } } },
    ];
  }

  const [items, total] = await Promise.all([
    transaction.invoice.findMany({
      where,
      select: InvoicePublicSelect,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: params.limit,
      skip: params.offset,
    }),
    transaction.invoice.count({ where }),
  ]);
  return { items, total };
}

export async function getInvoice(
  transaction: InvoiceTransaction,
  access: AccessContext,
  invoiceId: string,
) {
  return transaction.invoice.findFirst({
    where: {
      id: invoiceId,
      ...visibleInvoiceWhere(access),
    },
    select: InvoicePublicSelect,
  });
}
