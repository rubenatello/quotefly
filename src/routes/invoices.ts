import { InvoicePaymentStatus, InvoiceStatus, Prisma } from "@prisma/client";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { buildAccessContext, hasCapability } from "../lib/access-policy";
import { PaginationQuerySchema } from "../lib/query-scope";
import { measureRequestPerformance } from "../lib/request-performance";
import { withTenantRlsContext } from "../lib/tenant-rls";
import {
  createInvoice,
  getInvoice,
  InvoiceServiceError,
  listInvoices,
  type InvoicePublic,
} from "../services/invoices";

const InvoiceStatusSchema = z.nativeEnum(InvoiceStatus);
const InvoicePaymentStatusSchema = z.nativeEnum(InvoicePaymentStatus);
const BooleanQuerySchema = z.enum(["true", "false"]).transform((value) => value === "true");
const InvoiceParamsSchema = z.object({ invoiceId: z.string().trim().min(1).max(191) }).strict();
const IdempotencyKeySchema = z
  .string()
  .trim()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

const ListInvoicesQuerySchema = PaginationQuerySchema.extend({
  mine: BooleanQuerySchema.default(false),
  status: InvoiceStatusSchema.optional(),
  paymentStatus: InvoicePaymentStatusSchema.optional(),
  customerId: z.string().trim().min(1).max(191).optional(),
  jobId: z.string().trim().min(1).max(191).optional(),
  sourceQuoteId: z.string().trim().min(1).max(191).optional(),
  search: z.string().trim().min(1).max(120).optional(),
}).strict();

const CreateInvoiceSchema = z.object({
  jobId: z.string().trim().min(1).max(191).optional(),
  sourceQuoteId: z.string().trim().min(1).max(191).optional(),
  dueAtUtc: z.string().datetime({ offset: true }).transform((value) => new Date(value)).nullable().optional(),
}).strict().superRefine((payload, context) => {
  const sourceCount = Number(Boolean(payload.jobId)) + Number(Boolean(payload.sourceQuoteId));
  if (sourceCount !== 1) {
    context.addIssue({
      code: "custom",
      path: ["sourceQuoteId"],
      message: "Choose either jobId or sourceQuoteId.",
    });
  }
});

function idempotencyKey(request: FastifyRequest): string {
  const raw = request.headers["idempotency-key"];
  return IdempotencyKeySchema.parse(Array.isArray(raw) ? raw[0] : raw);
}

function serializeInvoice(invoice: InvoicePublic) {
  const {
    tenantId: _tenantId,
    deletedAtUtc: _deletedAtUtc,
    archivedAtUtc: _archivedAtUtc,
    ...safe
  } = invoice;
  return {
    ...safe,
    subtotalAmount: Number(invoice.subtotalAmount),
    taxAmount: Number(invoice.taxAmount),
    totalAmount: Number(invoice.totalAmount),
    amountPaid: Number(invoice.amountPaid),
    balanceDue: Number(invoice.balanceDue),
    issuedAtUtc: invoice.issuedAtUtc?.toISOString() ?? null,
    dueAtUtc: invoice.dueAtUtc?.toISOString() ?? null,
    sentAtUtc: invoice.sentAtUtc?.toISOString() ?? null,
    paidAtUtc: invoice.paidAtUtc?.toISOString() ?? null,
    voidedAtUtc: invoice.voidedAtUtc?.toISOString() ?? null,
    createdAt: invoice.createdAt.toISOString(),
    updatedAt: invoice.updatedAt.toISOString(),
    sourceQuote: {
      ...invoice.sourceQuote,
      totalAmount: Number(invoice.sourceQuote.totalAmount),
    },
  };
}

function sendInvoiceError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof InvoiceServiceError)) throw error;
  return reply.code(error.statusCode).send({
    error: error.message,
    code: error.code,
    ...(error.details ?? {}),
  });
}

export const invoiceRoutes: FastifyPluginAsync = async (app) => {
  app.get("/invoices", { preHandler: [app.authenticate] }, async (request, reply) => {
    const access = buildAccessContext(request);
    const query = ListInvoicesQuerySchema.parse(request.query);

    try {
      const result = await measureRequestPerformance(request, "db", () =>
        withTenantRlsContext(app.prisma, access.tenantId, (transaction) =>
          listInvoices(transaction, access, {
            mine: query.mine,
            status: query.status,
            paymentStatus: query.paymentStatus,
            customerId: query.customerId,
            jobId: query.jobId,
            sourceQuoteId: query.sourceQuoteId,
            search: query.search,
            limit: query.limit,
            offset: query.offset,
          }), { maxWait: 5_000, timeout: 15_000 }),
      );
      reply.header("Cache-Control", "private, no-store");
      return {
        items: result.items.map(serializeInvoice),
        pagination: {
          limit: query.limit,
          offset: query.offset,
          total: result.total,
        },
        scope: {
          mine: !hasCapability(access, "viewAllWorkspaceRecords") || query.mine,
        },
      };
    } catch (error) {
      return sendInvoiceError(reply, error);
    }
  });

  app.get("/invoices/:invoiceId", { preHandler: [app.authenticate] }, async (request, reply) => {
    const access = buildAccessContext(request);
    const { invoiceId } = InvoiceParamsSchema.parse(request.params);

    const invoice = await measureRequestPerformance(request, "db", () =>
      withTenantRlsContext(app.prisma, access.tenantId, (transaction) =>
        getInvoice(transaction, access, invoiceId), { maxWait: 5_000, timeout: 15_000 }),
    );
    if (!invoice) {
      return reply.code(404).send({ error: "Invoice not found for tenant.", code: "INVOICE_NOT_FOUND" });
    }
    reply.header("Cache-Control", "private, no-store");
    return { invoice: serializeInvoice(invoice) };
  });

  app.post("/invoices", { preHandler: [app.authenticate] }, async (request, reply) => {
    const access = buildAccessContext(request);
    const payload = CreateInvoiceSchema.parse(request.body);

    try {
      const result = await measureRequestPerformance(request, "db", () =>
        withTenantRlsContext(app.prisma, access.tenantId, (transaction) =>
          createInvoice(transaction, access, {
            jobId: payload.jobId,
            sourceQuoteId: payload.sourceQuoteId,
            dueAtUtc: payload.dueAtUtc ?? null,
            actorTenantUserId: access.tenantUserId,
            requestId: request.id,
            idempotencyKey: idempotencyKey(request),
          }), {
            maxWait: 5_000,
            timeout: 15_000,
            isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          }),
      );
      reply.header("Cache-Control", "private, no-store");
      return reply.code(result.duplicate ? 200 : 201).send({
        invoice: serializeInvoice(result.invoice),
        duplicate: result.duplicate,
      });
    } catch (error) {
      return sendInvoiceError(reply, error);
    }
  });
};
