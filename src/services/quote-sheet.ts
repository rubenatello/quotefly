import { Prisma } from "@prisma/client";

export type QuoteSheetLineInput = {
  description: string;
  sectionType: "INCLUDED" | "ALTERNATE";
  sectionLabel?: string | null;
  quantity: number;
  unitCost: number;
  unitPrice: number;
};

export type QuoteSheetLineUpdateInput = QuoteSheetLineInput & {
  id: string;
};

export class QuoteSheetLineNotFoundError extends Error {
  constructor() {
    super("Quote or line item not found for tenant.");
    this.name = "QuoteSheetLineNotFoundError";
  }
}

/**
 * Applies every line mutation through the caller's transaction client.
 * A missing or cross-tenant line throws so earlier quote/line writes roll back.
 */
export async function applyQuoteSheetLineMutations(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string;
    quoteId: string;
    updates: QuoteSheetLineUpdateInput[];
    creates: QuoteSheetLineInput[];
  },
) {
  for (const line of input.updates) {
    const updated = await tx.quoteLineItem.updateMany({
      where: {
        id: line.id,
        quoteId: input.quoteId,
        tenantId: input.tenantId,
        deletedAtUtc: null,
      },
      data: {
        description: line.description,
        sectionType: line.sectionType,
        sectionLabel: line.sectionLabel?.trim() || null,
        quantity: line.quantity,
        unitCost: line.unitCost,
        unitPrice: line.unitPrice,
      },
    });

    if (updated.count !== 1) {
      throw new QuoteSheetLineNotFoundError();
    }
  }

  if (input.creates.length > 0) {
    const lastLineItem = await tx.quoteLineItem.findFirst({
      where: {
        quoteId: input.quoteId,
        tenantId: input.tenantId,
        deletedAtUtc: null,
      },
      orderBy: [{ position: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      select: { position: true },
    });
    const firstPosition = (lastLineItem?.position ?? -1) + 1;

    await tx.quoteLineItem.createMany({
      data: input.creates.map((line, index) => ({
        tenantId: input.tenantId,
        quoteId: input.quoteId,
        description: line.description,
        sectionType: line.sectionType,
        sectionLabel: line.sectionLabel?.trim() || null,
        position: firstPosition + index,
        quantity: line.quantity,
        unitCost: line.unitCost,
        unitPrice: line.unitPrice,
      })),
    });
  }
}
