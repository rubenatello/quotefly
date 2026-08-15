export type WorkspacePage =
  | "home"
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
  | "about"
  | "internal-admin";

export type WorkspaceNavigationId =
  | "home"
  | "customers"
  | "quotes"
  | "products"
  | "follow-up"
  | "analytics"
  | "settings"
  | "settings-users"
  | "branding"
  | "about";

export type WorkspaceIconKey =
  | "home"
  | "customers"
  | "quotes"
  | "products"
  | "follow-up"
  | "analytics"
  | "settings"
  | "team"
  | "branding"
  | "about";

export interface WorkspaceNavigationItem {
  id: WorkspaceNavigationId;
  label: string;
  path: string;
  icon: WorkspaceIconKey;
}

export const WORKSPACE_OPERATIONS_LINKS: readonly WorkspaceNavigationItem[] = [
  { id: "home", label: "Home", path: "/app", icon: "home" },
  { id: "customers", label: "Customers", path: "/app/customers", icon: "customers" },
  { id: "quotes", label: "Quotes", path: "/app/quotes", icon: "quotes" },
  { id: "products", label: "Products", path: "/app/products", icon: "products" },
  { id: "follow-up", label: "Follow-up", path: "/app/follow-up", icon: "follow-up" },
  { id: "analytics", label: "Analytics", path: "/app/analytics", icon: "analytics" },
] as const;

export const WORKSPACE_SETTINGS_LINKS: readonly WorkspaceNavigationItem[] = [
  { id: "settings", label: "Settings", path: "/app/settings", icon: "settings" },
  { id: "settings-users", label: "Team & users", path: "/app/settings/users", icon: "team" },
  { id: "branding", label: "Branding", path: "/app/branding", icon: "branding" },
  { id: "about", label: "About workspace", path: "/app/about", icon: "about" },
] as const;

export const WORKSPACE_PAGE_META: Record<
  WorkspacePage,
  {
    label: string;
    hint: string;
    activeNavigation: WorkspaceNavigationId;
    headingPlacement: "shell" | "content";
  }
> = {
  home: {
    label: "Home",
    hint: "See new leads, quote momentum, and the work that needs attention.",
    activeNavigation: "home",
    headingPlacement: "shell",
  },
  customers: {
    label: "Customers",
    hint: "Track customer progress from new lead to sold work.",
    activeNavigation: "customers",
    headingPlacement: "shell",
  },
  quotes: {
    label: "Quotes",
    hint: "Review quote status, value, and the work that needs attention.",
    activeNavigation: "quotes",
    headingPlacement: "shell",
  },
  products: {
    label: "Products & services",
    hint: "Manage reusable work, pricing, costs, and quote-ready descriptions.",
    activeNavigation: "products",
    headingPlacement: "shell",
  },
  build: {
    label: "New quote",
    hint: "Choose a customer, price the work, review it, and create the quote.",
    activeNavigation: "quotes",
    headingPlacement: "content",
  },
  "quote-desk": {
    label: "Quote desk",
    hint: "Edit, preview, send, and track this quote from one workspace.",
    activeNavigation: "quotes",
    headingPlacement: "content",
  },
  "follow-up": {
    label: "Follow-up",
    hint: "Work leads, active jobs, and after-sale check-ins in priority order.",
    activeNavigation: "follow-up",
    headingPlacement: "shell",
  },
  analytics: {
    label: "Analytics",
    hint: "See quote and pipeline performance at a glance.",
    activeNavigation: "analytics",
    headingPlacement: "shell",
  },
  setup: {
    label: "Setup",
    hint: "Configure trades, starter jobs, and onboarding defaults.",
    activeNavigation: "settings",
    headingPlacement: "content",
  },
  branding: {
    label: "Branding",
    hint: "Control templates, sender details, and PDF styling.",
    activeNavigation: "branding",
    headingPlacement: "shell",
  },
  settings: {
    label: "Settings",
    hint: "Handle organization billing, access, and workspace controls.",
    activeNavigation: "settings",
    headingPlacement: "shell",
  },
  "settings-users": {
    label: "Team",
    hint: "Manage roles, seats, and member access.",
    activeNavigation: "settings-users",
    headingPlacement: "shell",
  },
  about: {
    label: "About workspace",
    hint: "Find account, plan, and workspace identifiers for support.",
    activeNavigation: "about",
    headingPlacement: "shell",
  },
  "internal-admin": {
    label: "Administration",
    hint: "Review internal platform controls and operational quality.",
    activeNavigation: "settings",
    headingPlacement: "content",
  },
};

export function workspacePageFromPath(pathname: string): WorkspacePage {
  if (pathname === "/app" || pathname === "/app/") return "home";
  if (pathname.startsWith("/app/analytics")) return "analytics";
  if (pathname.startsWith("/app/history")) return "analytics";
  if (pathname.startsWith("/app/customers")) return "customers";
  if (pathname === "/app/quotes" || pathname === "/app/quotes/") return "quotes";
  if (pathname.startsWith("/app/quotes/")) return "quote-desk";
  if (pathname.startsWith("/app/products")) return "products";
  if (pathname.startsWith("/app/build")) return "build";
  if (pathname.startsWith("/app/follow-up")) return "follow-up";
  if (pathname.startsWith("/app/settings/users")) return "settings-users";
  if (pathname.startsWith("/app/about")) return "about";
  if (pathname.startsWith("/app/settings")) return "settings";
  if (pathname.startsWith("/app/setup")) return "setup";
  if (pathname.startsWith("/app/branding")) return "branding";
  if (pathname.startsWith("/app/internal") || pathname.startsWith("/app/admin")) return "internal-admin";
  return "customers";
}

export function workspacePathForNavigation(id: WorkspaceNavigationId): string {
  return [...WORKSPACE_OPERATIONS_LINKS, ...WORKSPACE_SETTINGS_LINKS].find((item) => item.id === id)?.path ?? "/app";
}

export function isWorkspaceNavigationActive(id: WorkspaceNavigationId, page: WorkspacePage): boolean {
  return WORKSPACE_PAGE_META[page].activeNavigation === id;
}
