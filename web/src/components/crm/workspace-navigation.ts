export type WorkspacePage =
  | "home"
  | "customers"
  | "quotes"
  | "jobs"
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
  | "jobs"
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
  | "jobs"
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
  labelKey: string;
  path: string;
  icon: WorkspaceIconKey;
}

export const WORKSPACE_OPERATIONS_LINKS: readonly WorkspaceNavigationItem[] = [
  { id: "home", label: "Home", labelKey: "navigation.home", path: "/app", icon: "home" },
  { id: "customers", label: "Customers", labelKey: "navigation.customers", path: "/app/customers", icon: "customers" },
  { id: "quotes", label: "Quotes", labelKey: "navigation.quotes", path: "/app/quotes", icon: "quotes" },
  { id: "jobs", label: "Jobs", labelKey: "navigation.jobs", path: "/app/jobs", icon: "jobs" },
  { id: "products", label: "Products", labelKey: "navigation.products", path: "/app/products", icon: "products" },
  { id: "follow-up", label: "Activity", labelKey: "navigation.activity", path: "/app/follow-up", icon: "follow-up" },
  { id: "analytics", label: "Analytics", labelKey: "navigation.analytics", path: "/app/analytics", icon: "analytics" },
] as const;

export const WORKSPACE_SETTINGS_LINKS: readonly WorkspaceNavigationItem[] = [
  { id: "settings", label: "Settings", labelKey: "navigation.settings", path: "/app/settings", icon: "settings" },
  { id: "settings-users", label: "Team & users", labelKey: "navigation.team", path: "/app/settings/users", icon: "team" },
  { id: "branding", label: "Branding", labelKey: "navigation.branding", path: "/app/branding", icon: "branding" },
  { id: "about", label: "My info", labelKey: "navigation.myInfo", path: "/app/about", icon: "about" },
] as const;

export const WORKSPACE_PAGE_META: Record<
  WorkspacePage,
  {
    label: string;
    hint: string;
    translationKey: string;
    activeNavigation: WorkspaceNavigationId;
    headingPlacement: "shell" | "content";
  }
> = {
  home: {
    label: "Home",
    hint: "See new leads, quote momentum, and the work that needs attention.",
    translationKey: "pages.home",
    activeNavigation: "home",
    headingPlacement: "shell",
  },
  customers: {
    label: "Customers",
    hint: "Track customer progress from new lead to sold work.",
    translationKey: "pages.customers",
    activeNavigation: "customers",
    headingPlacement: "shell",
  },
  quotes: {
    label: "Quotes",
    hint: "Review quote status, value, and the work that needs attention.",
    translationKey: "pages.quotes",
    activeNavigation: "quotes",
    headingPlacement: "shell",
  },
  jobs: {
    label: "Jobs",
    hint: "Manage accepted quote work, assignments, and job status.",
    translationKey: "pages.jobs",
    activeNavigation: "jobs",
    headingPlacement: "shell",
  },
  products: {
    label: "Products & services",
    hint: "Manage reusable work, pricing, costs, and quote-ready descriptions.",
    translationKey: "pages.products",
    activeNavigation: "products",
    headingPlacement: "shell",
  },
  build: {
    label: "New quote",
    hint: "Choose a customer, price the work, review it, and create the quote.",
    translationKey: "pages.build",
    activeNavigation: "quotes",
    headingPlacement: "content",
  },
  "quote-desk": {
    label: "Quote desk",
    hint: "Edit, preview, send, and track this quote from one workspace.",
    translationKey: "pages.quoteDesk",
    activeNavigation: "quotes",
    headingPlacement: "content",
  },
  "follow-up": {
    label: "Activity",
    hint: "Work assigned leads, active jobs, and customer check-ins in priority order.",
    translationKey: "pages.activity",
    activeNavigation: "follow-up",
    headingPlacement: "shell",
  },
  analytics: {
    label: "Analytics",
    hint: "See quote and pipeline performance at a glance.",
    translationKey: "pages.analytics",
    activeNavigation: "analytics",
    headingPlacement: "shell",
  },
  setup: {
    label: "Setup",
    hint: "Configure trades, starter jobs, and onboarding defaults.",
    translationKey: "pages.setup",
    activeNavigation: "settings",
    headingPlacement: "content",
  },
  branding: {
    label: "Branding",
    hint: "Control templates, sender details, and PDF styling.",
    translationKey: "pages.branding",
    activeNavigation: "branding",
    headingPlacement: "shell",
  },
  settings: {
    label: "Settings",
    hint: "Handle organization billing, access, and workspace controls.",
    translationKey: "pages.settings",
    activeNavigation: "settings",
    headingPlacement: "shell",
  },
  "settings-users": {
    label: "Team",
    hint: "Manage roles, seats, and member access.",
    translationKey: "pages.team",
    activeNavigation: "settings-users",
    headingPlacement: "shell",
  },
  about: {
    label: "My info",
    hint: "See your account, role, plan, and workspace identifiers.",
    translationKey: "pages.myInfo",
    activeNavigation: "about",
    headingPlacement: "shell",
  },
  "internal-admin": {
    label: "Administration",
    hint: "Review internal platform controls and operational quality.",
    translationKey: "pages.administration",
    activeNavigation: "settings",
    headingPlacement: "content",
  },
};

export function workspacePageFromPath(pathname: string): WorkspacePage {
  if (pathname === "/app" || pathname === "/app/") return "home";
  if (pathname.startsWith("/app/analytics")) return "analytics";
  if (pathname.startsWith("/app/history")) return "analytics";
  if (pathname.startsWith("/app/customers")) return "customers";
  if (pathname.startsWith("/app/jobs")) return "jobs";
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
