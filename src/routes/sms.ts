import crypto from "node:crypto";
import { FastifyPluginAsync } from "fastify";
import twilio from "twilio";
import { parseInboundJobText } from "../services/sms-parser";
import { generateDraftFromSms } from "../services/quote-generator";
import { normalizeCustomerPhone } from "../lib/phone";

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

export const smsRoutes: FastifyPluginAsync = async (app) => {
  app.post("/sms/webhook", async (request, reply) => {
    const body = toFormStringRecord(request.body);
    const from = body.From ?? "";
    const to = body.To ?? "";
    const smsBody = body.Body ?? "";
    const smsSid = body.SmsSid;

    const signature = toHeaderString(request.headers["x-twilio-signature"]);
    if (app.env.TWILIO_WEBHOOK_AUTH_TOKEN) {
      if (!signature) {
        return reply.code(401).send({ message: "Missing Twilio signature" });
      }

      const forwardedProto = toHeaderString(request.headers["x-forwarded-proto"]);
      const forwardedHost = toHeaderString(request.headers["x-forwarded-host"]);
      const protocol = forwardedProto?.split(",")[0]?.trim() || request.protocol;
      const host = forwardedHost?.split(",")[0]?.trim() || request.headers.host || "";
      const path = request.raw.url ?? "";
      const webhookUrl = `${protocol}://${host}${path}`;

      const valid = twilio.validateRequest(
        app.env.TWILIO_WEBHOOK_AUTH_TOKEN,
        signature,
        webhookUrl,
        body,
      );

      if (!valid) {
        // Fallback for local/dev tunnels where host/proto rewriting can differ by proxy.
        const expected = crypto
          .createHmac("sha256", app.env.TWILIO_WEBHOOK_AUTH_TOKEN)
          .update(smsBody)
          .digest("base64");
        if (expected !== signature) {
          return reply.code(401).send({ message: "Invalid webhook signature" });
        }
      }
    }

    const tenantPhone = await app.prisma.tenantPhoneNumber.findUnique({
      where: { e164Number: to },
    });

    if (!tenantPhone) {
      return reply.code(404).send({ message: "Unknown destination number" });
    }

    const cleanedBody = smsBody.trim();

    if (cleanedBody === SEND_REPLY || cleanedBody === REVISE_REPLY) {
      const pendingSession = await app.prisma.quoteDecisionSession.findFirst({
        where: {
          tenantId: tenantPhone.tenantId,
          requesterPhone: from,
          status: "AWAITING_APPROVAL",
        },
        orderBy: { updatedAt: "desc" },
      });

      if (!pendingSession) {
        return {
          acknowledged: true,
          message: "No pending quote decision found. Send a new job details message first.",
        };
      }

      const approve = cleanedBody === SEND_REPLY;

      const quote = await app.prisma.quote.update({
        where: { id: pendingSession.quoteId },
        data: {
          status: approve ? "SENT_TO_CUSTOMER" : "READY_FOR_REVIEW",
          sentAt: approve ? new Date() : null,
        },
      });

      await app.prisma.quoteDecisionSession.update({
        where: { id: pendingSession.id },
        data: { status: approve ? "APPROVED" : "REVISION_REQUESTED" },
      });

      const responseMessage = approve
        ? "Quote approved. We will forward to customer now."
        : "Revision requested. Open QuoteFly app to adjust costs/pricing and resend.";

      await app.prisma.smsMessage.create({
        data: {
          tenantId: tenantPhone.tenantId,
          direction: "OUTBOUND",
          fromNumber: to,
          toNumber: from,
          body: responseMessage,
        },
      });

      return {
        acknowledged: true,
        quoteId: quote.id,
        status: quote.status,
        message: responseMessage,
      };
    }

    const parsed = parseInboundJobText(smsBody);
    const draft = generateDraftFromSms(smsBody);

    const customerPhone = normalizeCustomerPhone(parsed.customerPhone ?? from);
    const customer = await app.prisma.customer.upsert({
      where: {
        tenantId_phone: {
          tenantId: tenantPhone.tenantId,
          phone: customerPhone,
        },
      },
      create: {
        tenantId: tenantPhone.tenantId,
        fullName: parsed.customerName ?? "New Customer",
        phone: customerPhone,
        email: parsed.customerEmail,
      },
      update: {
        fullName: parsed.customerName,
        email: parsed.customerEmail,
      },
    });

    const pricingProfile = await app.prisma.pricingProfile.findFirst({
      where: {
        tenantId: tenantPhone.tenantId,
        serviceType: draft.serviceType,
      },
      orderBy: {
        isDefault: "desc",
      },
    });

    const laborRate = Number(pricingProfile?.laborRate ?? 2.25);
    const materialMarkup = Number(pricingProfile?.materialMarkup ?? 0.35);
    const internalCostSubtotal = Number((draft.squareFeetEstimate * laborRate).toFixed(2));
    const customerPriceSubtotal = Number(
      (internalCostSubtotal * (1 + materialMarkup)).toFixed(2),
    );
    const taxAmount = Number((customerPriceSubtotal * 0.08).toFixed(2));
    const totalAmount = Number((customerPriceSubtotal + taxAmount).toFixed(2));

    const quote = await app.prisma.quote.create({
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

    await app.prisma.quoteDecisionSession.create({
      data: {
        tenantId: tenantPhone.tenantId,
        quoteId: quote.id,
        requesterPhone: from,
      },
    });

    const confirmationMessage = [
      `Quote draft ready for ${customer.fullName}.`,
      `Estimated total: $${totalAmount.toFixed(2)}.`,
      "Reply 1 to send to customer.",
      "Reply 2 for revisions.",
    ].join(" ");

    await app.prisma.smsMessage.create({
      data: {
        tenantId: tenantPhone.tenantId,
        externalSid: smsSid,
        direction: "INBOUND",
        fromNumber: from,
        toNumber: to,
        body: smsBody,
      },
    });

    await app.prisma.smsMessage.create({
      data: {
        tenantId: tenantPhone.tenantId,
        direction: "OUTBOUND",
        fromNumber: to,
        toNumber: from,
        body: confirmationMessage,
      },
    });

    return {
      acknowledged: true,
      tenantId: tenantPhone.tenantId,
      customerId: customer.id,
      quoteId: quote.id,
      parsed,
      draft: {
        serviceType: draft.serviceType,
        estimatedTotal: totalAmount,
      },
      nextAction: "Quote drafted. Wait for reply 1 (send) or 2 (revise).",
    };
  });
};
