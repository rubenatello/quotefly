import { forwardRef, useId } from "react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes, ReactNode, HTMLAttributes } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { AlertTriangle, CheckCircle2, HelpCircle, Info, ShieldAlert, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";

/* ─────────────────────────── BUTTON ─────────────────────────── */

type ButtonVariant = "primary" | "secondary" | "kody" | "kodyTrigger" | "outline" | "ghost" | "danger" | "success" | "warning";
type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  loading?: boolean;
  fullWidth?: boolean;
}

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "border-[var(--qf-action-primary)] bg-[var(--qf-action-primary)] text-[var(--qf-action-primary-text)] shadow-[var(--qf-shadow-sm)] hover:border-[var(--qf-action-primary-hover)] hover:bg-[var(--qf-action-primary-hover)] active:border-[var(--qf-action-primary-active)] active:bg-[var(--qf-action-primary-active)]",
  secondary:
    "border-[var(--qf-action-secondary)] bg-[var(--qf-action-secondary)] text-[var(--qf-action-secondary-text)] shadow-[var(--qf-shadow-sm)] hover:border-[var(--qf-action-secondary-hover)] hover:bg-[var(--qf-action-secondary-hover)] active:border-[var(--qf-action-secondary-active)] active:bg-[var(--qf-action-secondary-active)]",
  kody:
    "border-[var(--qf-kody-action-border)] bg-[var(--qf-kody-action)] text-[var(--qf-kody-action-text)] shadow-[0_8px_20px_rgba(249,105,40,0.24)] hover:border-[var(--qf-kody-action-hover)] hover:bg-[var(--qf-kody-action-hover)] hover:shadow-[0_10px_24px_rgba(249,105,40,0.3)] active:border-[var(--qf-kody-action-active)] active:bg-[var(--qf-kody-action-active)]",
  kodyTrigger:
    "border-[var(--qf-kody-trigger-border)] bg-[var(--qf-kody-trigger)] text-[var(--qf-kody-trigger-text)] shadow-[0_9px_22px_rgba(3,7,18,0.24)] motion-safe:hover:-translate-y-0.5 hover:border-[var(--qf-kody-trigger-hover)] hover:bg-[var(--qf-kody-trigger-hover)] hover:shadow-[0_12px_26px_rgba(3,7,18,0.3)] active:border-[var(--qf-kody-trigger-active)] active:bg-[var(--qf-kody-trigger-active)]",
  outline:
    "border-[var(--qf-border)] bg-[var(--qf-panel)] text-[var(--qf-text-soft)] hover:border-[var(--qf-border-strong)] hover:bg-[var(--qf-interactive-hover)] hover:text-[var(--qf-text)] active:bg-[var(--qf-interactive-active)]",
  ghost: "border-transparent bg-transparent text-[var(--qf-text-soft)] hover:bg-[var(--qf-interactive-hover)] hover:text-[var(--qf-text)] active:bg-[var(--qf-interactive-active)]",
  danger: "border-[var(--qf-danger-border)] bg-[var(--qf-danger-surface)] text-[var(--qf-danger-text)] hover:bg-[var(--qf-danger-surface-hover)] active:bg-[var(--qf-danger-border)]",
  success: "border-[var(--qf-success-border)] bg-[var(--qf-success-surface)] text-[var(--qf-success-text)] hover:bg-[var(--qf-success-surface-hover)] active:bg-[var(--qf-success-border)]",
  warning: "border-[var(--qf-warning-border)] bg-[var(--qf-warning-surface)] text-[var(--qf-warning-text)] hover:bg-[var(--qf-warning-surface-hover)] active:bg-[var(--qf-warning-border)]",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "min-h-[44px] px-3 py-2 text-xs gap-1.5 sm:min-h-[31px] sm:py-1.5",
  md: "min-h-[44px] px-4 py-2 text-sm gap-2 sm:min-h-[38px]",
  lg: "min-h-[44px] px-5 py-2.5 text-base gap-2.5",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "primary", size = "md", icon, loading, fullWidth, className = "", children, disabled, ...rest }, ref) => {
    const isDisabled = Boolean(disabled || loading);

    return (
      <button
        ref={ref}
        disabled={isDisabled}
        aria-busy={loading || undefined}
        className={cn(
          "inline-flex select-none items-center justify-center whitespace-nowrap rounded-xl border font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)]",
          !isDisabled && BUTTON_VARIANTS[variant],
          BUTTON_SIZES[size],
          fullWidth && "w-full",
          className,
          isDisabled &&
            "cursor-not-allowed border-[var(--qf-border)] bg-[var(--qf-panel-muted)] text-[var(--qf-text-muted)] shadow-none opacity-100 transition-none",
        )}
        {...rest}
      >
        {loading ? <Spinner size={size === "sm" ? 14 : 16} /> : icon ? <span className="inline-flex shrink-0" aria-hidden="true">{icon}</span> : null}
        {children}
      </button>
    );
  },
);
Button.displayName = "Button";

interface IconButtonProps extends Omit<ButtonProps, "children" | "fullWidth"> {
  label: string;
}

const ICON_BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-11 w-11 px-0 py-0 sm:h-9 sm:min-h-9 sm:w-9",
  md: "h-11 w-11 px-0 py-0",
  lg: "h-12 w-12 px-0 py-0",
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ label, icon, size = "md", className = "", title, ...rest }, ref) => (
    <Button
      ref={ref}
      size={size}
      icon={icon}
      aria-label={label}
      title={title ?? label}
      className={cn("shrink-0", ICON_BUTTON_SIZES[size], className)}
      {...rest}
    >
      <span className="sr-only">{label}</span>
    </Button>
  ),
);
IconButton.displayName = "IconButton";

/* ─────────────────────────── INPUT ─────────────────────────── */

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  icon?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, icon, className = "", id, "aria-describedby": ariaDescribedBy, "aria-invalid": ariaInvalid, ...rest }, ref) => {
    const generatedId = useId();
    const inputId = id ?? generatedId;
    const errorId = `${inputId}-error`;
    const describedBy = [ariaDescribedBy, error ? errorId : null].filter(Boolean).join(" ") || undefined;
    return (
      <div className="space-y-1">
        {label && (
          <label htmlFor={inputId} className="block text-xs font-medium text-[var(--qf-text-soft)]">
            {label}
          </label>
        )}
        <div className="relative">
          {icon && (
            <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-slate-400">
              {icon}
            </span>
          )}
          <input
            ref={ref}
            id={inputId}
            aria-describedby={describedBy}
            aria-invalid={error ? true : ariaInvalid}
            className={cn(
              "min-h-[44px] w-full rounded-lg border bg-[var(--qf-panel)] px-3 py-2 text-sm text-[var(--qf-text)] placeholder:text-[var(--qf-text-muted)] transition-all hover:border-[var(--qf-border-strong)] focus:border-[var(--qf-focus)] focus:ring-4 focus:ring-[var(--qf-focus-ring)] focus:outline-none disabled:cursor-not-allowed disabled:bg-[var(--qf-panel-muted)] disabled:text-[var(--qf-text-muted)] sm:min-h-[38px]",
              icon && "pl-10",
              error ? "border-red-300 focus:border-red-500 focus:ring-red-200" : "border-[var(--qf-border)]",
              className,
            )}
            {...rest}
          />
        </div>
        {error && <p id={errorId} className="text-xs text-red-600">{error}</p>}
      </div>
    );
  },
);
Input.displayName = "Input";

/* ─────────────────────────── SELECT ─────────────────────────── */

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  placeholder?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, error, options, placeholder, className = "", id, ...rest }, ref) => {
    const generatedId = useId();
    const selectId = id ?? generatedId;
    return (
      <div className="space-y-1">
        {label && (
          <label htmlFor={selectId} className="block text-xs font-medium text-[var(--qf-text-soft)]">
            {label}
          </label>
        )}
        <select
          ref={ref}
          id={selectId}
          className={cn(
            "min-h-[44px] w-full rounded-lg border bg-[var(--qf-panel)] px-3 py-2 text-sm text-[var(--qf-text)] transition-all hover:border-[var(--qf-border-strong)] focus:border-[var(--qf-focus)] focus:ring-4 focus:ring-[var(--qf-focus-ring)] focus:outline-none disabled:cursor-not-allowed disabled:bg-[var(--qf-panel-muted)] disabled:text-[var(--qf-text-muted)] sm:min-h-[38px]",
            error ? "border-red-300" : "border-[var(--qf-border)]",
            className,
          )}
          {...rest}
        >
          {placeholder && <option value="">{placeholder}</option>}
          {options.map((opt) => (
            <option key={opt.value} value={opt.value} disabled={opt.disabled}>{opt.label}</option>
          ))}
        </select>
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
    );
  },
);
Select.displayName = "Select";

/* ─────────────────────────── TEXTAREA ─────────────────────────── */

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, error, className = "", id, ...rest }, ref) => {
    const generatedId = useId();
    const areaId = id ?? generatedId;
    return (
      <div className="space-y-1">
        {label && (
          <label htmlFor={areaId} className="block text-xs font-medium text-[var(--qf-text-soft)]">
            {label}
          </label>
        )}
        <textarea
          ref={ref}
          id={areaId}
          className={cn(
            "min-h-[110px] w-full rounded-lg border bg-[var(--qf-panel)] px-3.5 py-3 text-sm text-[var(--qf-text)] placeholder:text-[var(--qf-text-muted)] transition-all hover:border-[var(--qf-border-strong)] focus:border-[var(--qf-focus)] focus:ring-4 focus:ring-[var(--qf-focus-ring)] focus:outline-none disabled:cursor-not-allowed disabled:bg-[var(--qf-panel-muted)] disabled:text-[var(--qf-text-muted)]",
            error ? "border-red-300" : "border-[var(--qf-border)]",
            className,
          )}
          {...rest}
        />
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
    );
  },
);
Textarea.displayName = "Textarea";

/* ─────────────────────────── CARD ─────────────────────────── */

type CardVariant = "default" | "blue" | "amber" | "elevated";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant;
  padding?: "sm" | "md" | "lg";
}

const CARD_VARIANTS: Record<CardVariant, string> = {
  default: "border-[var(--qf-border)] bg-[var(--qf-panel)]",
  blue: "border-[color:rgba(47,111,214,0.14)] bg-[var(--qf-panel-subtle)]",
  amber: "border-[var(--qf-warning-border)] bg-[var(--qf-warning-surface)]",
  elevated: "border-[var(--qf-border)] bg-[var(--qf-panel)] shadow-[var(--qf-shadow-sm)]",
};

const CARD_PADDING: Record<string, string> = {
  sm: "p-3",
  md: "p-4 sm:p-5",
  lg: "p-5 sm:p-6",
};

export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ variant = "default", padding = "md", className = "", children, ...rest }, ref) => (
    <div
      ref={ref}
      className={cn("rounded-xl border", CARD_VARIANTS[variant], CARD_PADDING[padding], className)}
      {...rest}
    >
      {children}
    </div>
  ),
);
Card.displayName = "Card";

/* ─────────────────────────── CARD HEADER ─────────────────────────── */

export function CardHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-col gap-2.5 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h2 className="text-base font-semibold tracking-tight text-[var(--qf-text)] sm:text-lg">{title}</h2>
        {subtitle && <p className="mt-1 text-sm text-[var(--qf-text-soft)]">{subtitle}</p>}
      </div>
      {actions ? <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end [&>*]:w-full sm:[&>*]:w-auto">{actions}</div> : null}
    </div>
  );
}

/* ─────────────────────────── BADGE ─────────────────────────── */

type BadgeTone = "blue" | "orange" | "emerald" | "red" | "amber" | "slate" | "purple" | "cyan" | "indigo" | "violet" | "sky";

interface BadgeProps {
  tone?: BadgeTone;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}

const BADGE_TONES: Record<BadgeTone, string> = {
  blue: "border-[var(--qf-info-border)] bg-[var(--qf-info-surface)] text-[var(--qf-info-text)]",
  orange: "border-[var(--qf-brand-orange-border)] bg-[var(--qf-brand-orange-soft)] text-[var(--qf-brand-orange-text)]",
  emerald: "border-[var(--qf-success-border)] bg-[var(--qf-success-surface)] text-[var(--qf-success-text)]",
  red: "border-[var(--qf-danger-border)] bg-[var(--qf-danger-surface)] text-[var(--qf-danger-text)]",
  amber: "border-[var(--qf-warning-border)] bg-[var(--qf-warning-surface)] text-[var(--qf-warning-text)]",
  slate: "border-[var(--qf-border)] bg-[var(--qf-panel-muted)] text-[var(--qf-text-soft)]",
  purple: "border-[var(--qf-info-border)] bg-[var(--qf-info-surface)] text-[var(--qf-info-text)]",
  cyan: "border-[var(--qf-info-border)] bg-[var(--qf-info-surface)] text-[var(--qf-info-text)]",
  indigo: "border-[var(--qf-info-border)] bg-[var(--qf-info-surface)] text-[var(--qf-info-text)]",
  violet: "border-[var(--qf-info-border)] bg-[var(--qf-info-surface)] text-[var(--qf-info-text)]",
  sky: "border-[var(--qf-info-border)] bg-[var(--qf-info-surface)] text-[var(--qf-info-text)]",
};

export function Badge({ tone = "slate", icon, children, className = "" }: BadgeProps) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium", BADGE_TONES[tone], className)}>
      {icon}
      {children}
    </span>
  );
}

/* ─────────────────────────── EMPTY STATE ─────────────────────────── */

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-[var(--qf-border-strong)] bg-[var(--qf-panel-muted)] px-5 py-8 text-center">
      {icon && <span className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-full bg-[var(--qf-interactive-active)] text-[var(--qf-text-muted)]">
        {icon}
      </span>}
      <p className="text-sm font-medium text-[var(--qf-text-soft)]">{title}</p>
      {description && <p className="mt-1 text-xs text-[var(--qf-text-muted)]">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/* ─────────────────────────── SKELETON ─────────────────────────── */

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-2xl bg-[var(--qf-interactive-active)]", className)} />;
}

export function SkeletonCard() {
  return (
    <div className="rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)] p-4">
      <Skeleton className="mb-3 h-4 w-24" />
      <Skeleton className="mb-2 h-3 w-full" />
      <Skeleton className="h-3 w-3/4" />
    </div>
  );
}

/* ─────────────────────────── ALERT ─────────────────────────── */

export function LoadingState({
  title,
  description,
  rows = 4,
  variant = "list",
  className = "",
}: {
  title?: string;
  description?: string;
  rows?: number;
  variant?: "list" | "cards" | "table" | "compact";
  className?: string;
}) {
  const { t } = useTranslation();
  const resolvedTitle = title ?? t("common.loading");
  const safeRows = Math.max(1, Math.min(rows, 8));
  const rowItems = Array.from({ length: safeRows }, (_, index) => index);

  if (variant === "compact") {
    return (
      <div role="status" aria-live="polite" className={cn("rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-4 py-3", className)}>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--qf-panel)] text-[var(--qf-link)] shadow-[var(--qf-shadow-sm)]">
            <Spinner size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-[var(--qf-text)]">{resolvedTitle}</p>
            {description ? <p className="mt-1 text-xs leading-5 text-[var(--qf-text-muted)]">{description}</p> : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div role="status" aria-live="polite" className={cn("rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] p-4", className)}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[var(--qf-text)]">{resolvedTitle}</p>
          {description ? <p className="mt-1 text-xs leading-5 text-[var(--qf-text-muted)]">{description}</p> : null}
        </div>
        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--qf-panel)] text-[var(--qf-link)] shadow-[var(--qf-shadow-sm)]">
          <Spinner size={15} />
        </span>
      </div>

      {variant === "table" ? (
        <div className="overflow-hidden rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)]">
          <div className="grid grid-cols-[1.1fr_0.8fr_0.7fr] gap-3 border-b border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-4 py-3">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 w-16" />
          </div>
          {rowItems.map((row) => (
            <div key={row} className="grid grid-cols-[1.1fr_0.8fr_0.7fr] gap-3 border-b border-[var(--qf-border)] px-4 py-4 last:border-b-0">
              <div className="space-y-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="ml-auto h-8 w-20 rounded-full" />
            </div>
          ))}
        </div>
      ) : variant === "cards" ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {rowItems.map((row) => (
            <SkeletonCard key={row} />
          ))}
        </div>
      ) : (
        <div className="grid gap-2">
          {rowItems.map((row) => (
            <div key={row} className="rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)] p-3">
              <div className="flex items-center gap-3">
                <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
                <Skeleton className="hidden h-8 w-20 rounded-full sm:block" />
              </div>
            </div>
          ))}
        </div>
      )}
      <span className="sr-only">{resolvedTitle}</span>
    </div>
  );
}

type AlertTone = "error" | "success" | "info" | "warning";

interface AlertProps {
  tone: AlertTone;
  children: ReactNode;
  onDismiss?: () => void;
}

const ALERT_TONES: Record<AlertTone, string> = {
  error: "border-[var(--qf-danger-border)] bg-[var(--qf-danger-surface)] text-[var(--qf-danger-text)]",
  success: "border-[var(--qf-success-border)] bg-[var(--qf-success-surface)] text-[var(--qf-success-text)]",
  info: "border-[var(--qf-info-border)] bg-[var(--qf-info-surface)] text-[var(--qf-info-text)]",
  warning: "border-[var(--qf-warning-border)] bg-[var(--qf-warning-surface)] text-[var(--qf-warning-text)]",
};

export function Alert({ tone, children, onDismiss }: AlertProps) {
  const { t } = useTranslation();

  return (
    <div role={tone === "error" ? "alert" : "status"} className={`flex items-center justify-between gap-2 rounded-lg border px-4 py-2.5 text-sm ${ALERT_TONES[tone]}`}>
      <div className="min-w-0 flex-1">{children}</div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="inline-flex h-11 w-11 items-center justify-center text-current text-lg leading-none opacity-60 hover:opacity-100 sm:h-9 sm:w-9"
          aria-label={t("common.dismissAlert")}
        >
          &times;
        </button>
      )}
    </div>
  );
}

type ModalSize = "sm" | "md" | "lg" | "xl";
type ModalLayer = "default" | "navigationGuard";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  modal?: boolean;
  size?: ModalSize;
  layer?: ModalLayer;
  closeOnBackdrop?: boolean;
  panelClassName?: string;
  ariaLabel?: string;
}

const MODAL_SIZES: Record<ModalSize, string> = {
  sm: "sm:max-w-md",
  md: "sm:max-w-lg",
  lg: "sm:max-w-2xl",
  xl: "sm:max-w-4xl",
};

export function Modal({
  open,
  onClose,
  children,
  modal = true,
  size = "md",
  layer = "default",
  closeOnBackdrop = true,
  panelClassName = "",
  ariaLabel,
}: ModalProps) {
  const { t } = useTranslation();

  return (
    <DialogPrimitive.Root
      open={open}
      modal={modal}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        {modal ? (
          <DialogPrimitive.Overlay
            className={cn(
              "fixed inset-0 bg-[var(--qf-overlay)] backdrop-blur-sm",
              layer === "navigationGuard" ? "z-[200]" : "z-[100]",
            )}
          />
        ) : null}
        <DialogPrimitive.Content
          onCloseAutoFocus={(event) => {
            // Navigation guards restore the coordinator's captured initiating
            // control after nested focus scopes unwind.
            if (layer === "navigationGuard") event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (!closeOnBackdrop) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (!closeOnBackdrop) event.preventDefault();
          }}
          className={cn(
            "qf-theme-scope fixed inset-x-0 bottom-0 flex max-h-[calc(100dvh-0.75rem)] w-full flex-col overflow-hidden rounded-t-[28px] border border-b-0 border-[var(--qf-border)] bg-[var(--qf-panel)] pb-[env(safe-area-inset-bottom)] text-[var(--qf-text)] shadow-[var(--qf-shadow-md)] outline-none sm:bottom-auto sm:left-1/2 sm:right-auto sm:top-1/2 sm:max-h-[90vh] sm:w-[calc(100vw-2rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[24px] sm:border-b sm:pb-0",
            layer === "navigationGuard" ? "z-[210]" : "z-[110]",
            MODAL_SIZES[size],
            panelClassName,
          )}
        >
          <DialogPrimitive.Title className="sr-only">{ariaLabel ?? t("common.dialog")}</DialogPrimitive.Title>
          <span aria-hidden="true" className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-[var(--qf-border-strong)] sm:hidden" />
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function ModalHeader({
  title,
  description,
  onClose,
  className = "",
}: {
  title: ReactNode;
  description?: ReactNode;
  onClose?: () => void;
  className?: string;
}) {
  const { t } = useTranslation();

  return (
    <div className={`flex items-start justify-between gap-4 border-b border-[var(--qf-border)] px-5 py-4 sm:px-6 ${className}`}>
      <div className="min-w-0">
        <h2 className="text-lg font-semibold text-[var(--qf-text)] sm:text-xl">{title}</h2>
        {description ? (
          <DialogPrimitive.Description className="mt-1 text-sm text-[var(--qf-text-soft)]">
            {description}
          </DialogPrimitive.Description>
        ) : null}
      </div>
      {onClose ? (
        <IconButton
          type="button"
          onClick={onClose}
          variant="outline"
          size="sm"
          icon={<X size={18} />}
          label={t("common.closeModal")}
          className="rounded-full"
        />
      ) : null}
    </div>
  );
}

export function ModalBody({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6 ${className}`}>{children}</div>;
}

export function ModalFooter({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "grid shrink-0 grid-cols-1 gap-2 border-t border-[var(--qf-border)] bg-[var(--qf-panel)] px-5 py-4 sm:flex sm:flex-wrap sm:justify-end sm:px-6 [&>button]:w-full sm:[&>button]:w-auto [&>div]:grid [&>div]:w-full [&>div]:gap-2 [&>div>*]:w-full sm:[&>div]:flex sm:[&>div]:w-auto sm:[&>div>*]:w-auto",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function WorkflowActionDock({ children, className = "", ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "qf-mobile-action-dock qf-theme-scope fixed z-40 rounded-2xl border border-[var(--qf-border-strong)] bg-[var(--qf-panel)] p-3 text-[var(--qf-text)] shadow-[var(--qf-shadow-md)] backdrop-blur-xl",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

interface ConfirmModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  loading?: boolean;
  confirmVariant?: ButtonVariant;
  children?: ReactNode;
  size?: ModalSize;
  layer?: ModalLayer;
}

export function ConfirmModal({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  cancelLabel,
  loading = false,
  confirmVariant = "danger",
  children,
  size = "sm",
  layer = "default",
}: ConfirmModalProps) {
  const { t } = useTranslation();
  const resolvedConfirmLabel = confirmLabel ?? t("common.confirm");
  const resolvedCancelLabel = cancelLabel ?? t("common.cancel");
  const closeIfIdle = () => {
    if (!loading) onClose();
  };
  const tone =
    confirmVariant === "danger"
      ? {
          icon: <ShieldAlert size={22} aria-hidden="true" />,
          iconClass: "border-[var(--qf-danger-border)] bg-[var(--qf-danger-surface)] text-[var(--qf-danger-text)]",
        }
      : confirmVariant === "warning"
        ? {
            icon: <AlertTriangle size={22} aria-hidden="true" />,
            iconClass: "border-[var(--qf-warning-border)] bg-[var(--qf-warning-surface)] text-[var(--qf-warning-text)]",
          }
        : confirmVariant === "success"
          ? {
              icon: <CheckCircle2 size={22} aria-hidden="true" />,
              iconClass: "border-[var(--qf-success-border)] bg-[var(--qf-success-surface)] text-[var(--qf-success-text)]",
            }
          : confirmVariant === "primary" || confirmVariant === "secondary"
            ? {
                icon: <HelpCircle size={22} aria-hidden="true" />,
                iconClass: "border-[var(--qf-info-border)] bg-[var(--qf-info-surface)] text-[var(--qf-info-text)]",
              }
            : {
                icon: <Info size={22} aria-hidden="true" />,
                iconClass: "border-[var(--qf-border)] bg-[var(--qf-panel-muted)] text-[var(--qf-text-soft)]",
              };

  return (
    <Modal open={open} onClose={closeIfIdle} closeOnBackdrop={!loading} size={size} layer={layer} ariaLabel={title}>
      <ModalHeader title={title} onClose={loading ? undefined : onClose} />
      <ModalBody className="py-4 sm:py-5">
        <div className="flex items-start gap-3">
          <span className={cn("inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border", tone.iconClass)}>
            {tone.icon}
          </span>
          <div className="min-w-0 flex-1 space-y-3">
            {description ? (
              <DialogPrimitive.Description className="text-sm leading-6 text-[var(--qf-text-soft)]">
                {description}
              </DialogPrimitive.Description>
            ) : null}
            {children}
          </div>
        </div>
      </ModalBody>
      <ModalFooter className="grid grid-cols-1 gap-3 sm:flex sm:flex-row sm:gap-2">
        <Button type="button" variant="outline" onClick={onClose} disabled={loading} fullWidth className="order-2 sm:order-1 sm:w-auto">
          {resolvedCancelLabel}
        </Button>
        <Button type="button" variant={confirmVariant} onClick={onConfirm} loading={loading} fullWidth className="order-1 sm:order-2 sm:w-auto">
          {resolvedConfirmLabel}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

/* ─────────────────────────── SPINNER ─────────────────────────── */

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className="animate-spin"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M12 2a10 10 0 019.95 9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/* ─────────────────────────── PAGE HEADER ─────────────────────────── */

export function ProgressBar({
  value,
  label,
  hint,
  valueText,
  tone = "default",
  className = "",
}: {
  value: number;
  label?: string;
  hint?: string;
  valueText?: string;
  tone?: "default" | "warning" | "danger";
  className?: string;
}) {
  const { t } = useTranslation();
  const clampedValue = Math.max(0, Math.min(100, value));
  const barTone =
    tone === "danger"
      ? "bg-[var(--qf-danger-text)]"
      : tone === "warning"
        ? "bg-[var(--qf-kody-action)]"
        : "bg-[var(--qf-action-primary)]";

  return (
    <div className={`space-y-1.5 ${className}`}>
      {(label || hint) && (
        <div className="flex items-center justify-between gap-2 text-xs font-medium text-[var(--qf-text-muted)]">
          <span>{label}</span>
          {hint ? <span>{hint}</span> : null}
        </div>
      )}
      <div
        role="progressbar"
        aria-label={label ?? t("common.progress")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Number(clampedValue.toFixed(2))}
        aria-valuetext={valueText}
        className="h-2 overflow-hidden rounded-full bg-[var(--qf-interactive-active)]"
      >
        <div
          className={`h-full rounded-full motion-safe:transition-[width,background-color] motion-safe:duration-500 motion-safe:ease-out ${barTone}`}
          style={{ width: `${clampedValue}%` }}
        />
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  mode = "full",
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  mode?: "full" | "actions-only";
}) {
  const { t } = useTranslation();

  if (mode === "actions-only") {
    if (!actions) return null;

    return (
      <div
        aria-label={t("common.actionsLabel", { title })}
        className="flex w-full flex-wrap items-center justify-end gap-2 [&>*]:w-full sm:[&>*]:w-auto"
      >
        {actions}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="font-display text-[1.85rem] font-semibold tracking-[-0.04em] text-[var(--qf-text)] sm:text-[2.15rem]">{title}</h1>
        {subtitle && <p className="mt-1 max-w-3xl text-sm text-[var(--qf-text-soft)]">{subtitle}</p>}
      </div>
      {actions ? (
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end [&>*]:w-full sm:[&>*]:w-auto">
          {actions}
        </div>
      ) : null}
    </div>
  );
}

export type PageSize = 25 | 50 | 100;

export function PaginationControls({
  limit,
  offset,
  total,
  loading = false,
  itemLabel,
  onLimitChange,
  onOffsetChange,
}: {
  limit: PageSize;
  offset: number;
  total: number;
  loading?: boolean;
  itemLabel?: string;
  onLimitChange: (limit: PageSize) => void;
  onOffsetChange: (offset: number) => void;
}) {
  const { t } = useTranslation();
  const resolvedItemLabel = itemLabel ?? t("common.records");
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const currentPage = Math.min(totalPages, Math.floor(offset / limit) + 1);
  const rangeStart = total === 0 ? 0 : offset + 1;
  const rangeEnd = Math.min(offset + limit, total);

  return (
    <nav
      aria-label={t("common.pagination.label", { item: resolvedItemLabel })}
      className="flex flex-col gap-3 rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)] px-3 py-3 shadow-[var(--qf-shadow-sm)] sm:flex-row sm:items-end sm:justify-between sm:px-4"
    >
      <div className="flex items-end justify-between gap-3 sm:justify-start">
        <Select
          label={t("common.pagination.rowsPerPage")}
          aria-label={t("common.pagination.rowsPerPageFor", { item: resolvedItemLabel })}
          className="min-w-[92px]"
          value={String(limit)}
          disabled={loading}
          options={[
            { value: "25", label: "25" },
            { value: "50", label: "50" },
            { value: "100", label: "100" },
          ]}
          onChange={(event) => onLimitChange(Number(event.target.value) as PageSize)}
        />
        <p className="pb-2 text-sm text-[var(--qf-text-soft)]" aria-live="polite">
          {t("common.pagination.rangeOf", { start: rangeStart, end: rangeEnd, total })}
        </p>
      </div>

      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 sm:flex">
        <Button
          size="sm"
          variant="outline"
          disabled={loading || currentPage <= 1}
          onClick={() => onOffsetChange(Math.max(0, offset - limit))}
          aria-label={t("common.pagination.previousPageOf", { item: resolvedItemLabel })}
        >
          {t("common.previous")}
        </Button>
        <span className="min-w-[92px] text-center text-xs font-semibold text-[var(--qf-text-soft)]">
          {t("common.pageOf", { page: currentPage, total: totalPages })}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={loading || currentPage >= totalPages}
          onClick={() => onOffsetChange(offset + limit)}
          aria-label={t("common.pagination.nextPageOf", { item: resolvedItemLabel })}
        >
          {t("common.next")}
        </Button>
      </div>
    </nav>
  );
}

