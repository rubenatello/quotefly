import { useEffect, type ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Command as CommandPrimitive } from "cmdk";
import {
  ArrowRight,
  BrushCleaning,
  FilePlus2,
  FileText,
  LayoutDashboard,
  LineChart,
  Search,
  Settings,
  UserPlus2,
  UserRoundCog,
} from "lucide-react";
import { cn } from "../../lib/utils";

type CommandPage = "customers" | "quotes" | "analytics" | "branding" | "settings" | "settings-users";
type CommandAction = "new-customer" | "new-quote";

interface CrmCommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (page: CommandPage) => void;
  onQuickAction: (action: CommandAction) => void;
}

type CommandItem = {
  label: string;
  description: string;
  page?: CommandPage;
  action?: CommandAction;
  icon: ReactNode;
  group: "Actions" | "Workflow" | "Workspace";
};

const COMMAND_ITEMS: CommandItem[] = [
  {
    label: "New Customer",
    description: "Open the fast add-customer flow from anywhere in the workspace.",
    action: "new-customer",
    icon: <UserPlus2 size={16} />,
    group: "Actions",
  },
  {
    label: "New Quote",
    description: "Jump straight into the quote builder with the current workflow shell.",
    action: "new-quote",
    icon: <FilePlus2 size={16} />,
    group: "Actions",
  },
  {
    label: "Customers",
    description: "See customers in the sales pipeline from new to sold.",
    page: "customers",
    icon: <LayoutDashboard size={16} />,
    group: "Workflow",
  },
  {
    label: "Quotes",
    description: "See quote KPIs and open the quote desk when a quote needs work.",
    page: "quotes",
    icon: <FileText size={16} />,
    group: "Workflow",
  },
  {
    label: "Analytics",
    description: "Track quote performance, revenue, and recent outcomes.",
    page: "analytics",
    icon: <LineChart size={16} />,
    group: "Workflow",
  },
  {
    label: "Branding",
    description: "Manage company details, templates, and PDF styling.",
    page: "branding",
    icon: <BrushCleaning size={16} />,
    group: "Workspace",
  },
  {
    label: "Organization Settings",
    description: "Manage billing, launch-plan access, and workspace configuration.",
    page: "settings",
    icon: <Settings size={16} />,
    group: "Workspace",
  },
  {
    label: "User Settings",
    description: "Manage team members, roles, and seat usage.",
    page: "settings-users",
    icon: <UserRoundCog size={16} />,
    group: "Workspace",
  },
];

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
}: CrmCommandPaletteProps) {
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
        <DialogPrimitive.Content className="fixed left-1/2 top-[10vh] z-[150] w-[min(680px,calc(100vw-24px))] -translate-x-1/2 overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-[0_28px_90px_rgba(15,23,42,0.28)] outline-none">
          <CommandPrimitive loop className="overflow-hidden" label="QuoteFly workspace search">
            <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-3">
              <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-quotefly-blue/[0.08] text-quotefly-blue">
                <Search size={18} />
              </span>
              <CommandPrimitive.Input
                autoFocus
                placeholder="Jump to customers, quotes, analytics, branding..."
                className="w-full border-0 bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-400"
              />
              <span className="hidden rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-medium text-slate-500 sm:inline-flex">
                Ctrl/Cmd + K
              </span>
            </div>

            <CommandPrimitive.List className="max-h-[420px] overflow-y-auto p-3">
              <CommandPrimitive.Empty className="rounded-2xl border border-dashed border-slate-200 px-4 py-12 text-center text-sm text-slate-500">
                No workspace result matched this search.
              </CommandPrimitive.Empty>

              <CommandGroup
                heading="Actions"
                items={COMMAND_ITEMS.filter((item) => item.group === "Actions")}
                onSelect={(item) => {
                  if (item.action) onQuickAction(item.action);
                  onOpenChange(false);
                }}
              />

              <CommandGroup
                heading="Workflow"
                items={COMMAND_ITEMS.filter((item) => item.group === "Workflow")}
                onSelect={(item) => {
                  if (item.page) onNavigate(item.page);
                  onOpenChange(false);
                }}
              />

              <CommandGroup
                heading="Workspace"
                items={COMMAND_ITEMS.filter((item) => item.group === "Workspace")}
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
