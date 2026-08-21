import { useEffect, type ReactNode } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Command as CommandPrimitive } from "cmdk";
import {
  ArrowRight,
  FilePlus2,
  FileText,
  LayoutDashboard,
  LineChart,
  Search,
  Settings,
  UserPlus2,
  UserRoundCog,
  ListTodo,
  BadgeInfo,
  Palette,
} from "lucide-react";
import { cn } from "../../lib/utils";
import type { WorkspaceNavigationId } from "./workspace-navigation";

type CommandPage = WorkspaceNavigationId;
type CommandAction = "new-customer" | "new-quote";

interface CrmCommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (page: CommandPage) => void;
  onQuickAction: (action: CommandAction) => void;
  allowedPages?: readonly WorkspaceNavigationId[];
}

type CommandItem = {
  label: string;
  description: string;
  page?: CommandPage;
  action?: CommandAction;
  icon: ReactNode;
  group: "Actions" | "Workflow" | "Workspace";
};

function buildCommandItems(t: TFunction): CommandItem[] {
  return [
  {
    label: t("commands.items.newCustomer.label"),
    description: t("commands.items.newCustomer.description"),
    action: "new-customer",
    icon: <UserPlus2 size={16} />,
    group: "Actions",
  },
  {
    label: t("commands.items.newQuote.label"),
    description: t("commands.items.newQuote.description"),
    action: "new-quote",
    icon: <FilePlus2 size={16} />,
    group: "Actions",
  },
  {
    label: t("commands.items.home.label"),
    description: t("commands.items.home.description"),
    page: "home",
    icon: <LayoutDashboard size={16} />,
    group: "Workflow",
  },
  {
    label: t("commands.items.customers.label"),
    description: t("commands.items.customers.description"),
    page: "customers",
    icon: <LayoutDashboard size={16} />,
    group: "Workflow",
  },
  {
    label: t("commands.items.quotes.label"),
    description: t("commands.items.quotes.description"),
    page: "quotes",
    icon: <FileText size={16} />,
    group: "Workflow",
  },
  {
    label: t("commands.items.activity.label"),
    description: t("commands.items.activity.description"),
    page: "follow-up",
    icon: <ListTodo size={16} />,
    group: "Workflow",
  },
  {
    label: t("commands.items.analytics.label"),
    description: t("commands.items.analytics.description"),
    page: "analytics",
    icon: <LineChart size={16} />,
    group: "Workflow",
  },
  {
    label: t("commands.items.branding.label"),
    description: t("commands.items.branding.description"),
    page: "branding",
    icon: <Palette size={16} />,
    group: "Workspace",
  },
  {
    label: t("commands.items.about.label"),
    description: t("commands.items.about.description"),
    page: "about",
    icon: <BadgeInfo size={16} />,
    group: "Workspace",
  },
  {
    label: t("commands.items.settings.label"),
    description: t("commands.items.settings.description"),
    page: "settings",
    icon: <Settings size={16} />,
    group: "Workspace",
  },
  {
    label: t("commands.items.users.label"),
    description: t("commands.items.users.description"),
    page: "settings-users",
    icon: <UserRoundCog size={16} />,
    group: "Workspace",
  },
  ];
}

function CommandGroup({
  heading,
  items,
  onSelect,
}: {
  heading: string;
  items: CommandItem[];
  onSelect: (item: CommandItem) => void;
}) {
  return (
    <CommandPrimitive.Group
      heading={heading}
      className="px-2 pb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400"
    >
      <div className="mt-2 space-y-1">
        {items.map((item) => (
          <CommandPrimitive.Item
            key={item.page ?? item.action}
            value={`${item.label} ${item.description}`}
            onSelect={() => onSelect(item)}
            className={cn(
              "group flex cursor-pointer items-center justify-between rounded-2xl border border-transparent px-3 py-3 text-sm text-slate-700 outline-none transition",
              "data-[selected=true]:border-quotefly-blue/20 data-[selected=true]:bg-quotefly-blue/[0.06] data-[selected=true]:text-slate-900",
            )}
          >
            <div className="flex min-w-0 items-start gap-3">
              <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl border border-slate-200 bg-white text-quotefly-blue shadow-sm">
                {item.icon}
              </span>
              <div className="min-w-0">
                <p className="font-semibold">{item.label}</p>
                <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{item.description}</p>
              </div>
            </div>
            <ArrowRight className="h-4 w-4 shrink-0 text-slate-300 transition group-data-[selected=true]:text-quotefly-blue" />
          </CommandPrimitive.Item>
        ))}
      </div>
    </CommandPrimitive.Group>
  );
}

export function CrmCommandPalette({
  open,
  onOpenChange,
  onNavigate,
  onQuickAction,
  allowedPages,
}: CrmCommandPaletteProps) {
  const { t } = useTranslation();
  const commandItems = buildCommandItems(t);
  const visibleCommandItems = allowedPages
    ? commandItems.filter((item) => !item.page || allowedPages.includes(item.page))
    : commandItems;
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpenChange(!open);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onOpenChange]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[140] bg-slate-950/45 backdrop-blur-sm" />
        <DialogPrimitive.Content className="qf-theme-scope fixed left-1/2 top-[10vh] z-[150] w-[min(680px,calc(100vw-24px))] -translate-x-1/2 overflow-hidden rounded-[28px] border border-qf-border bg-qf-surface text-qf-text shadow-[0_28px_90px_rgba(15,23,42,0.28)] outline-none">
          <CommandPrimitive loop className="overflow-hidden" label={t("commands.searchLabel")}>
            <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-3">
              <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-quotefly-blue/[0.08] text-quotefly-blue">
                <Search size={18} />
              </span>
              <CommandPrimitive.Input
                autoFocus
                placeholder={t("commands.placeholder")}
                className="w-full border-0 bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-400"
              />
              <span className="hidden rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-medium text-slate-500 sm:inline-flex">
                Ctrl/Cmd + K
              </span>
            </div>

            <CommandPrimitive.List className="max-h-[420px] overflow-y-auto p-3">
              <CommandPrimitive.Empty className="rounded-2xl border border-dashed border-slate-200 px-4 py-12 text-center text-sm text-slate-500">
                {t("commands.noResults")}
              </CommandPrimitive.Empty>

              <CommandGroup
                heading={t("commands.groups.actions")}
                items={visibleCommandItems.filter((item) => item.group === "Actions")}
                onSelect={(item) => {
                  if (item.action) onQuickAction(item.action);
                  onOpenChange(false);
                }}
              />

              <CommandGroup
                heading={t("commands.groups.workflow")}
                items={visibleCommandItems.filter((item) => item.group === "Workflow")}
                onSelect={(item) => {
                  if (item.page) onNavigate(item.page);
                  onOpenChange(false);
                }}
              />

              <CommandGroup
                heading={t("commands.groups.workspace")}
                items={visibleCommandItems.filter((item) => item.group === "Workspace")}
                onSelect={(item) => {
                  if (item.page) onNavigate(item.page);
                  onOpenChange(false);
                }}
              />
            </CommandPrimitive.List>
          </CommandPrimitive>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
