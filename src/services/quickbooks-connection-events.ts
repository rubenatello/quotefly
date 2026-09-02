import type { Prisma } from "@prisma/client";

export const QUICKBOOKS_CONNECTION_EVENT_ACTIONS = [
  "CONNECT_STARTED",
  "CONNECTED",
  "RECONNECTED",
  "COMPANY_SWITCHED",
  "SETUP_CONFIRMED",
  "DISCONNECT_REQUESTED",
  "DISCONNECTED",
] as const;

export type QuickBooksConnectionEventAction =
  (typeof QUICKBOOKS_CONNECTION_EVENT_ACTIONS)[number];

export type QuickBooksConnectionEventContext = Readonly<{
  actorTenantUserId: string | null;
  requestId: string;
  connectionGeneration: number;
}>;

const SUCCESSFUL_CONNECTION_ACTIONS: QuickBooksConnectionEventAction[] = [
  "CONNECTED",
  "RECONNECTED",
  "COMPANY_SWITCHED",
];

export async function currentQuickBooksConnectionGeneration(
  transaction: Prisma.TransactionClient,
  tenantId: string,
): Promise<number> {
  const latest = await transaction.quickBooksConnectionEvent.findFirst({
    where: {
      tenantId,
      action: { in: SUCCESSFUL_CONNECTION_ACTIONS },
      outcome: "SUCCEEDED",
    },
    orderBy: [{ connectionGeneration: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    select: { connectionGeneration: true },
  });
  return latest?.connectionGeneration ?? 1;
}

export async function nextQuickBooksConnectionGeneration(
  transaction: Prisma.TransactionClient,
  tenantId: string,
): Promise<number> {
  const current = await currentQuickBooksConnectionGeneration(transaction, tenantId);
  const hasSuccessfulConnection = await transaction.quickBooksConnectionEvent.findFirst({
    where: {
      tenantId,
      action: { in: SUCCESSFUL_CONNECTION_ACTIONS },
      outcome: "SUCCEEDED",
    },
    select: { id: true },
  });
  return hasSuccessfulConnection ? current + 1 : 1;
}

export async function recordQuickBooksConnectionEvent(
  transaction: Prisma.TransactionClient,
  params: Readonly<{
    tenantId: string;
    quickBooksConnectionId: string | null;
    actorTenantUserId: string | null;
    requestId: string;
    action: QuickBooksConnectionEventAction;
    outcome: "PENDING" | "SUCCEEDED" | "FAILED";
    connectionGeneration: number;
  }>,
) {
  return transaction.quickBooksConnectionEvent.create({
    data: {
      tenantId: params.tenantId,
      quickBooksConnectionId: params.quickBooksConnectionId,
      actorTenantUserId: params.actorTenantUserId,
      requestId: params.requestId.trim().slice(0, 128),
      action: params.action,
      outcome: params.outcome,
      connectionGeneration: params.connectionGeneration,
    },
    select: { id: true },
  });
}

export async function latestQuickBooksDisconnectEventContext(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  quickBooksConnectionId: string,
  connectionGeneration: number,
): Promise<QuickBooksConnectionEventContext | null> {
  return transaction.quickBooksConnectionEvent.findFirst({
    where: {
      tenantId,
      quickBooksConnectionId,
      action: "DISCONNECT_REQUESTED",
      connectionGeneration,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      actorTenantUserId: true,
      requestId: true,
      connectionGeneration: true,
    },
  });
}
