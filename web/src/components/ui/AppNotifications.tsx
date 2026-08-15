import { CheckCircle2, CircleAlert, Info, LoaderCircle, TriangleAlert, X } from "lucide-react";
import { Toaster, type ToasterProps } from "sonner";

export function AppNotifications({ theme }: { theme: NonNullable<ToasterProps["theme"]> }) {
  return (
    <Toaster
      theme={theme}
      position="top-right"
      visibleToasts={3}
      gap={10}
      closeButton
      expand
      offset={{ top: 12, right: 12 }}
      mobileOffset={{ top: "max(0.75rem, env(safe-area-inset-top))", right: 12, left: 12 }}
      swipeDirections={["right", "left", "top"]}
      icons={{
        success: <CheckCircle2 size={19} aria-hidden="true" />,
        info: <Info size={19} aria-hidden="true" />,
        warning: <TriangleAlert size={19} aria-hidden="true" />,
        error: <CircleAlert size={19} aria-hidden="true" />,
        loading: <LoaderCircle size={19} className="animate-spin" aria-hidden="true" />,
        close: <X size={16} aria-hidden="true" />,
      }}
      toastOptions={{
        duration: 4_500,
        closeButtonAriaLabel: "Dismiss notification",
        classNames: {
          toast:
            "qf-app-toast qf-theme-scope !min-h-[64px] !rounded-2xl !border !border-[var(--qf-border)] !bg-[var(--qf-panel)] !px-4 !py-3 !text-[var(--qf-text)] !shadow-[var(--qf-shadow-md)]",
          title: "!text-sm !font-semibold !leading-5 !text-[var(--qf-text)]",
          description: "!text-xs !leading-5 !text-[var(--qf-text-soft)]",
          content: "!gap-0.5",
          icon: "!h-6 !w-6",
          closeButton:
            "!h-11 !w-11 !border-[var(--qf-border)] !bg-[var(--qf-panel)] !text-[var(--qf-text-soft)] hover:!bg-[var(--qf-interactive-hover)] sm:!h-8 sm:!w-8",
          success: "!border-[var(--qf-success-border)] [&_[data-icon]]:!text-[var(--qf-success-text)]",
          info: "!border-[var(--qf-info-border)] [&_[data-icon]]:!text-[var(--qf-info-text)]",
          warning: "!border-[var(--qf-warning-border)] [&_[data-icon]]:!text-[var(--qf-warning-text)]",
          error: "!border-[var(--qf-danger-border)] [&_[data-icon]]:!text-[var(--qf-danger-text)]",
          actionButton:
            "!min-h-11 !rounded-lg !bg-[var(--qf-action-primary)] !px-3 !text-[var(--qf-action-primary-text)] sm:!min-h-9",
          cancelButton:
            "!min-h-11 !rounded-lg !border !border-[var(--qf-border)] !bg-[var(--qf-panel-muted)] !px-3 !text-[var(--qf-text)] sm:!min-h-9",
        },
      }}
    />
  );
}
