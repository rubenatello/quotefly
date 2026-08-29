import { Prisma } from "@prisma/client";
import { FastifyPluginAsync } from "fastify";
import twilio from "twilio";
import { parseInboundJobText } from "../services/sms-parser";
import { generateDraftFromSms } from "../services/quote-generator";
import { normalizeCustomerPhone, normalizePhoneSearchDigits } from "../lib/phone";
import { enqueueAiIndexJob, enqueueQuoteAiIndexJobs } from "../lib/ai-index-jobs";
import { withTenantRlsContext } from "../lib/tenant-rls";
import { withTransactionConflictRetry } from "../lib/transaction-retry";
import { seedCustomerFollowUpSchedule } from "../services/customer-follow-up";
import {
  applyQuoteCustomerLifecycle,
  CustomerLifecycleError,
  lockCustomerForQuoteAdmission,
} from "../services/customer-lifecycle";

const SEND_REPLY = "1";
const REVISE_REPLY = "2";

function toHeaderString(value: string | string[] | undefined): string | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

function toFormStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, String(entry ?? "")]),
  );
}

async function lockActiveSmsQuote(
  transaction: Prisma.TransactionClient,
  input: { tenantId: string; quoteId: string },
) {
  const [quote] = await transaction.$queryRaw<Array<{ id: string; customerId: string }>>(Prisma.sql`
    SELECT quote."id", quote."customerId"
    FROM "Quote" quote
    WHERE quote."id" = ${input.quoteId}
      AND quote."tenantId" = ${input.tenantId}
      AND quote."archivedAtUtc" IS NULL
      AND quote."deletedAtUtc" IS NULL
    FOR UPDATE OF quote
  `);
  return quote ?? null;
}

export const smsRoutes: FastifyPluginAsync = async (app) => {
  app.post("/sms/webhook", { bodyLimit: 64 * 1024 }, async (request, reply) => {
    if (!app.env.TWILIO_WEBHOOK_AUTH_TOKEN) {
      return reply.code(503).send({ message: "Twilio webhook verification is not configured" });
    }

    const body = toFormStringRecord(request.body);
    const from = body.From ?? "";
    const to = body.To ?? "";
    const smsBody = body.Body ?? "";
    const smsSid = body.SmsSid || body.MessageSid || "";

    const signature = toHeaderString(request.headers["x-twilio-signature"]);
    if (!signature) {
      return reply.code(401).send({ message: "Missing Twilio signature" });
    }

    const webhookUrl = new URL(request.raw.url ?? "/v1/sms/webhook", app.env.API_URL).toString();
    const valid = twilio.validateRequest(
      app.env.TWILIO_WEBHOOK_AUTH_TOKEN,
      signature,
      webhookUrl,
      body,
    );
    if (!valid) {
      return reply.code(401).send({ message: "Invalid webhook signature" });
    }

    if (!from || !to || !smsSid) {
      return reply.code(400).send({ message: "Invalid Twilio webhook payload" });
    }

    const tenantPhone = await app.prisma.tenantPhoneNumber.findUnique({
      where: {
        e164Number: to,
        deletedAtUtc: null,
        tenant: { deletedAtUtc: null },
      },
    });

    if (!tenantPhone) {
      return reply.code(404).send({ message: "Unknown destination number" });
    }

    const existingMessage = await app.prisma.smsMessage.findUnique({
      where: { externalSid: smsSid },
      select: { id: true },
    });
    if (existingMessage) {
      return { acknowledged: true, duplicate: true };
    }

    const cleanedBody = smsBody.trim();
    const parsed = parseInboundJobText(smsBody);
    const draft = generateDraftFromSms(smsBody);
    const customerPhone = normalizeCustomerPhone(parsed.customerPhone ?? from);
    const customerPhoneDigits = normalizePhoneSearchDigits(customerPhone);

    try {
      return await withTransactionConflictRetry(() =>
        withTenantRlsContext(app.prisma, tenantPhone.tenantId, async (tx) => {
        await tx.smsMessage.create({
          data: {
            tenantId: tenantPhone.tenantId,
            externalSid: smsSid,
            direction: "INBOUND",
            fromNumber: from,
            toNumber: to,
            body: smsBody,
          },
        });

        if (cleanedBody === SEND_REPLY || cleanedBody === REVISE_REPLY) {
          const pendingSession = await tx.quoteDecisionSession.findFirst({
            where: {
              tenantId: tenantPhone.tenantId,
              requesterPhone: from,
              status: "AWAITING_APPROVAL",
              deletedAtUtc: null,
            },
            orderBy: { updatedAt: "desc" },
            select: { id: true, quoteId: true },
          });

          if (!pendingSession) {
            return { acknowledged: true };
          }

          const lockedQuote = await lockActiveSmsQuote(tx, {
            tenantId: tenantPhone.tenantId,
            quoteId: pendingSession.quoteId,
          });
          if (!lockedQuote) {
            return { acknowledged: true };
          }

          const approve = cleanedBody === SEND_REPLY;
          if (approve) {
            try {
              await lockCustomerForQuoteAdmission(tx, {
                tenantId: tenantPhone.tenantId,
                customerId: lockedQuote.customerId,
              });
            } catch (error) {
              if (!(error instanceof CustomerLifecycleError) || error.code !== "CUSTOMER_REOPEN_REQUIRED") {
                throw error;
              }
              await tx.smsMessage.create({
                data: {
                  tenantId: tenantPhone.tenantId,
                  direction: "OUTBOUND",
                  fromNumber: to,
                  toNumber: from,
                  body: "This customer is marked lost. Reopen the customer in QuoteFly before sending the quote.",
                },
              });
              return { acknowledged: true, blocked: "CUSTOMER_REOPEN_REQUIRED" };
            }
          }
          const quote = await tx.quote.update({
            where: {
              id_tenantId: { id: pendingSession.quoteId, tenantId: tenantPhone.tenantId },
            },
            data: {
              status: approve ? "SENT_TO_CUSTOMER" : "READY_FOR_REVIEW",
              sentAt: approve ? new Date() : null,
            },
          });
          await tx.quoteDecisionSession.update({
            where: { id: pendingSession.id },
            data: { status: approve ? "APPROVED" : "REVISION_REQUESTED" },
          });
          if (approve) {
            await applyQuoteCustomerLifecycle(tx, {
              tenantId: tenantPhone.tenantId,
              customerId: lockedQuote.customerId,
              quoteStatus: "SENT_TO_CUSTOMER",
            });
          }
          await enqueueQuoteAiIndexJobs(tx, {
            tenantId: tenantPhone.tenantId,
            quoteId: quote.id,
            operation: "UPSERT",
            expectedSourceUpdatedAtUtc: quote.updatedAt,
          });

          const responseMessage = approve
            ? "Quote approved. We will forward to customer now."
            : "Revision requested. Open QuoteFly app to adjust costs/pricing and resend.";
          await tx.smsMessage.create({
            data: {
              tenantId: tenantPhone.tenantId,
              direction: "OUTBOUND",
              fromNumber: to,
              toNumber: from,
              body: responseMessage,
            },
          });
          return { acknowledged: true };
        }

        let existingCustomer = await tx.customer.findFirst({
          where: {
            tenantId: tenantPhone.tenantId,
            OR: [
              { phone: customerPhone },
              ...(customerPhoneDigits ? [{ phoneDigits: customerPhoneDigits }] : []),
            ],
          },
          orderBy: { createdAt: "desc" },
          select: { id: true, fullName: true, email: true, followUpStatus: true },
        });
        if (existingCustomer) {
          try {
            await lockCustomerForQuoteAdmission(tx, {
              tenantId: tenantPhone.tenantId,
              customerId: existingCustomer.id,
              includeRetained: true,
            });
          } catch (error) {
            if (!(error instanceof CustomerLifecycleError) || error.code !== "CUSTOMER_REOPEN_REQUIRED") {
              throw error;
            }
            await tx.smsMessage.create({
              data: {
                tenantId: tenantPhone.tenantId,
                direction: "OUTBOUND",
                fromNumber: to,
                toNumber: from,
                body: "This customer is marked lost. Reopen the customer in QuoteFly before creating another quote.",
              },
            });
            return { acknowledged: true, blocked: "CUSTOMER_REOPEN_REQUIRED" };
          }
          existingCustomer = await tx.customer.findUniqueOrThrow({
            where: { id_tenantId: { id: existingCustomer.id, tenantId: tenantPhone.tenantId } },
            select: { id: true, fullName: true, email: true, followUpStatus: true },
          });
        }
        const customer = existingCustomer
          ? await tx.customer.update({
              where: { id_tenantId: { id: existingCustomer.id, tenantId: tenantPhone.tenantId } },
              data: {
                fullName: parsed.customerName ?? existingCustomer.fullName,
                phone: customerPhone,
                phoneDigits: customerPhoneDigits,
                email: parsed.customerEmail ?? existingCustomer.email ?? undefined,
                archivedAtUtc: null,
                deletedAtUtc: null,
              },
            })
          : await tx.customer.create({
              data: {
                tenantId: tenantPhone.tenantId,
                fullName: parsed.customerName ?? "New Customer",
                phone: customerPhone,
                phoneDigits: customerPhoneDigits,
                email: parsed.customerEmail,
              },
            });
        if (!existingCustomer) {
          await seedCustomerFollowUpSchedule(tx, {
            tenantId: tenantPhone.tenantId,
            customerId: customer.id,
            assignedTenantUserId: customer.assignedTenantUserId,
            createdByTenantUserId: null,
            startedAtUtc: customer.createdAt,
          });
        }
        await enqueueAiIndexJob(tx, {
          tenantId: tenantPhone.tenantId,
          sourceType: "Customer",
          sourceId: customer.id,
          operation: "UPSERT",
          expectedSourceUpdatedAtUtc: customer.updatedAt,
        });

        const pricingProfile = await tx.pricingProfile.findFirst({
          where: { tenantId: tenantPhone.tenantId, serviceType: draft.serviceType },
          orderBy: { isDefault: "desc" },
        });
        const laborRate = Number(pricingProfile?.laborRate ?? 2.25);
        const materialMarkup = Number(pricingProfile?.materialMarkup ?? 0.35);
        const internalCostSubtotal = Number((draft.squareFeetEstimate * laborRate).toFixed(2));
        const customerPriceSubtotal = Number((internalCostSubtotal * (1 + materialMarkup)).toFixed(2));
        const taxAmount = Number((customerPriceSubtotal * 0.08).toFixed(2));
        const totalAmount = Number((customerPriceSubtotal + taxAmount).toFixed(2));

        const quote = await tx.quote.create({
          data: {
            tenantId: tenantPhone.tenantId,
            customerId: customer.id,
            serviceType: draft.serviceType,
            status: "READY_FOR_REVIEW",
            title: `${draft.serviceType} SMS Draft Quote`,
            scopeText: draft.scopeText,
            internalCostSubtotal,
            customerPriceSubtotal,
            taxAmount,
            totalAmount,
          },
        });
        await tx.quoteDecisionSession.create({
          data: { tenantId: tenantPhone.tenantId, quoteId: quote.id, requesterPhone: from },
        });
        await enqueueQuoteAiIndexJobs(tx, {
          tenantId: tenantPhone.tenantId,
          quoteId: quote.id,
          operation: "UPSERT",
          expectedSourceUpdatedAtUtc: quote.updatedAt,
        });

        const confirmationMessage = [
          `Quote draft ready for ${customer.fullName}.`,
          `Estimated total: $${totalAmount.toFixed(2)}.`,
          "Reply 1 to send to customer.",
          "Reply 2 for revisions.",
        ].join(" ");
        await tx.smsMessage.create({
          data: {
            tenantId: tenantPhone.tenantId,
            direction: "OUTBOUND",
            fromNumber: to,
            toNumber: from,
            body: confirmationMessage,
          },
        });

        return { acknowledged: true };
      }));
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const duplicate = await app.prisma.smsMessage.findUnique({
          where: { externalSid: smsSid },
          select: { id: true },
        });
        if (duplicate) return { acknowledged: true, duplicate: true };
      }
      throw error;
    }
  });
};
