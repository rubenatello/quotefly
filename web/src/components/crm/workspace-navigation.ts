export type WorkspacePage =
  | "customers"
  | "quotes"
  | "products"
  | "build"
  | "quote-desk"
  | "follow-up"
  | "analytics"
  | "setup"
  | "branding"
  | "settings"
  | "settings-users"
  | "internal-admin";

export type WorkspaceNavigationId =
  | "customers"
  | "quotes"
  | "products"
  | "follow-up"
  | "analytics"
  | "settings"
  | "settings-users"
  | "branding";

export type WorkspaceIconKey =
  | "customers"
  | "quotes"
  | "products"
  | "follow-up"
  | "analytics"
  | "settings"
  | "team"
  | "branding";

export interface WorkspaceNavigationItem {
  id: WorkspaceNavigationId;
  label: string;
  path: string;
  icon: WorkspaceIconKey;
}

export const WORKSPACE_OPERATIONS_LINKS: readonly WorkspaceNavigationItem[] = [
  { id: "customers", label: "Customers", path: "/app/customers", icon: "customers" },
  { id: "quotes", label: "Quotes", path: "/app/quotes", icon: "quotes" },
  { id: "products", label: "Products", path: "/app/products", icon: "products" },
  { id: "follow-up", label: "Follow-up", path: "/app/follow-up", icon: "follow-up" },
  { id: "analytics", label: "Analytics", path: "/app/analytics", icon: "analytics" },
] as const;

export const WORKSPACE_SETTINGS_LINKS: readonly WorkspaceNavigationItem[] = [
  { id: "settings", label: "Business", path: "/app/settings", icon: "settings" },
  { id: "settings-users", label: "Team", path: "/app/settings/users", icon: "team" },
  { id: "branding", label: "Branding", path: "/app/branding", icon: "branding" },
] as const;

export const WORKSPACE_PAGE_META: Record<
  WorkspacePage,
  { label: string; hint: string; activeNavigation: WorkspaceNavigationId }
> = {
  customers: {
    label: "Customers",
    hint: "Track customer progress from new lead to sold work.",
    activeNavigation: "customers",
  },
  quotes: {
    label: "Quotes",
    hint: "Review quote status, value, and the work that needs attention.",
    activeNavigation: "quotes",
  },
  products: {
    label: "Products & services",
    hint: "Manage reusable work, pricing, costs, and quote-ready descriptions.",
    activeNavigation: "products",
  },
  build: {
    label: "New quote",
    hint: "Choose a customer, price the work, review it, and create the quote.",
    activeNavigation: "quotes",
  },
  "quote-desk": {
    label: "Quote desk",
    hint: "Edit, preview, send, and track this quote from one workspace.",
    activeNavigation: "quotes",
  },
  "follow-up": {
    label: "Follow-up",
    hint: "Work leads, active jobs, and after-sale check-ins in priority order.",
    activeNavigation: "follow-up",
  },
  analytics: {
    label: "Analytics",
    hint: "See quote and pipeline performance at a glance.",
    activeNavigation: "analytics",
  },
  setup: {
    label: "Setup",
    hint: "Configure trades, starter jobs, and onboarding defaults.",
    activeNavigation: "settings",
  },
  branding: {
    label: "Branding",
    hint: "Control templates, sender details, and PDF styling.",
    activeNavigation: "branding",
  },
  settings: {
    label: "Settings",
    hint: "Handle organization billing, access, and workspace controls.",
    activeNavigation: "settings",
  },
  "settings-users": {
    label: "Team",
    hint: "Manage roles, seats, and member access.",
    activeNavigation: "settings-users",
  },
  "internal-admin": {
    label: "Administration",
    hint: "Review internal platform controls and operational quality.",
    activeNavigation: "settings",
  },
};

export function workspacePageFromPath(pathname: string): WorkspacePage {
  if (pathname.startsWith("/app/analytics")) return "analytics";
  if (pathname.startsWith("/app/history")) return "analytics";
  if (pathname.startsWith("/app/customers")) return "customers";
  if (pathname === "/app/quotes" || pathname === "/app/quotes/") return "quotes";
  if (pathname.startsWith("/app/quotes/")) return "quote-desk";
  if (pathname.startsWith("/app/products")) return "products";
  if (pathname.startsWith("/app/build")) return "build";
  if (pathname.startsWith("/app/follow-up")) return "follow-up";
  if (pathname.startsWith("/app/settings/users")) return "settings-users";
  if (pathname.startsWith("/app/settings")) return "settings";
  if (pathname.startsWith("/app/setup")) return "setup";
  if (pathname.startsWith("/app/branding")) return "branding";
  if (pathname.startsWith("/app/internal") || pathname.startsWith("/app/admin")) return "internal-admin";
  return "customers";
}

export function workspacePathForNavigation(id: WorkspaceNavigationId): string {
  return [...WORKSPACE_OPERATIONS_LINKS, ...WORKSPACE_SETTINGS_LINKS].find((item) => item.id === id)?.path ?? "/app/customers";
}

export function isWorkspaceNavigationActive(id: WorkspaceNavigationId, page: WorkspacePage): boolean {
  return WORKSPACE_PAGE_META[page].activeNavigation === id;
}
