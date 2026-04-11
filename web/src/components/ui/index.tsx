import { forwardRef, useEffect, useId } from "react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes, ReactNode, HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

/* ─────────────────────────── BUTTON ─────────────────────────── */

type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "danger" | "success" | "warning";
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
    "border-quotefly-blue bg-quotefly-blue text-white shadow-sm hover:bg-[#256fbf] active:bg-[#1f5f9f]",
  secondary:
    "border-quotefly-orange bg-quotefly-orange text-white shadow-sm hover:bg-[#dd532a] active:bg-[#c74921]",
  outline:
    "border-slate-200 bg-white text-slate-700 shadow-sm hover:border-slate-300 hover:bg-slate-50 active:bg-slate-100",
  ghost: "border-transparent bg-transparent text-slate-700 hover:bg-slate-100 active:bg-slate-200",
  danger: "bg-red-50 text-red-700 border-red-200 hover:bg-red-100 active:bg-red-200",
  success: "bg-quotefly-blue/10 text-quotefly-blue border-quotefly-blue/20 hover:bg-quotefly-blue/15 active:bg-quotefly-blue/20",
  warning: "bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100 active:bg-amber-200",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "min-h-[34px] px-4 py-1.5 text-xs gap-1.5",
  md: "min-h-[44px] px-5 py-2 text-sm gap-2",
  lg: "min-h-[50px] px-6 py-2.5 text-base gap-2.5",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "primary", size = "md", icon, loading, fullWidth, className = "", children, disabled, ...rest }, ref) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center justify-center rounded-full border font-medium transition-all duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-quotefly-blue disabled:cursor-not-allowed disabled:opacity-50",
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        fullWidth && "w-full",
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={size === "sm" ? 14 : 16} /> : icon}
      {children}
    </button>
  ),
);
Button.displayName = "Button";

/* ─────────────────────────── INPUT ─────────────────────────── */

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  icon?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, icon, className = "", id, ...rest }, ref) => {
    const inputId = id ?? label?.toLowerCase().replace(/\s+/g, "-");
    return (
      <div className="space-y-1">
        {label && (
          <label htmlFor={inputId} className="block text-xs font-medium text-slate-600">
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
            className={cn(
              "min-h-[46px] w-full rounded-2xl border bg-white px-4 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 transition-all focus:border-quotefly-blue focus:ring-4 focus:ring-quotefly-blue/10 focus:outline-none",
              icon && "pl-10",
              error ? "border-red-300 focus:border-red-500 focus:ring-red-200" : "border-slate-200",
              className,
            )}
            {...rest}
          />
        </div>
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
    );
  },
);
Input.displayName = "Input";

/* ─────────────────────────── SELECT ─────────────────────────── */

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, error, options, placeholder, className = "", id, ...rest }, ref) => {
    const selectId = id ?? label?.toLowerCase().replace(/\s+/g, "-");
    return (
      <div className="space-y-1">
        {label && (
          <label htmlFor={selectId} className="block text-xs font-medium text-slate-600">
            {label}
          </label>
        )}
        <select
          ref={ref}
          id={selectId}
          className={cn(
            "min-h-[46px] w-full rounded-2xl border bg-white px-4 py-2 text-sm text-slate-900 shadow-sm transition-all focus:border-quotefly-blue focus:ring-4 focus:ring-quotefly-blue/10 focus:outline-none",
            error ? "border-red-300" : "border-slate-200",
            className,
          )}
          {...rest}
        >
          {placeholder && <option value="">{placeholder}</option>}
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
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
    const areaId = id ?? label?.toLowerCase().replace(/\s+/g, "-");
    return (
      <div className="space-y-1">
        {label && (
          <label htmlFor={areaId} className="block text-xs font-medium text-slate-600">
            {label}
          </label>
        )}
        <textarea
          ref={ref}
          id={areaId}
          className={cn(
            "min-h-[120px] w-full rounded-2xl border bg-white px-4 py-3 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 transition-all focus:border-quotefly-blue focus:ring-4 focus:ring-quotefly-blue/10 focus:outline-none",
            error ? "border-red-300" : "border-slate-200",
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
  default: "border-slate-200 bg-white shadow-sm",
  blue: "border-quotefly-blue/15 bg-quotefly-blue/[0.04] shadow-sm",
  amber: "border-quotefly-orange/15 bg-quotefly-orange/[0.05] shadow-sm",
  elevated: "border-slate-200 bg-white shadow-[0_12px_28px_rgba(15,23,42,0.08)]",
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
      className={cn("rounded-[28px] border", CARD_VARIANTS[variant], CARD_PADDING[padding], className)}
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
    <div className="mb-4 flex items-start justify-between gap-3">
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">{title}</h2>
        {subtitle && <p className="mt-1 text-sm text-slate-600">{subtitle}</p>}
      </div>
      {actions}
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
  blue: "text-quotefly-blue border-quotefly-blue/20 bg-quotefly-blue/[0.06]",
  orange: "text-quotefly-orange border-quotefly-orange/20 bg-quotefly-orange/[0.06]",
  emerald: "text-quotefly-blue border-quotefly-blue/20 bg-quotefly-blue/[0.06]",
  red: "text-red-600 border-red-200 bg-red-50",
  amber: "text-amber-700 border-amber-200 bg-amber-50",
  slate: "text-slate-600 border-slate-200 bg-slate-50",
  purple: "text-quotefly-accent border-quotefly-accent/20 bg-quotefly-accent/[0.06]",
  cyan: "text-quotefly-blue border-quotefly-blue/20 bg-quotefly-blue/[0.06]",
  indigo: "text-quotefly-accent border-quotefly-accent/20 bg-quotefly-accent/[0.06]",
  violet: "text-quotefly-accent border-quotefly-accent/20 bg-quotefly-accent/[0.06]",
  sky: "text-quotefly-blue border-quotefly-blue/20 bg-quotefly-blue/[0.06]",
};

export function Badge({ tone = "slate", icon, children, className = "" }: BadgeProps) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${BADGE_TONES[tone]} ${className}`}>
      {icon}
      {children}
    </span>
  );
}

/* ─────────────────────────── EMPTY STATE ─────────────────────────── */

export function EmptyState({ icon, title, description }: { icon?: ReactNode; title: string; description?: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[26px] border border-dashed border-slate-300 bg-slate-50/70 px-6 py-10 text-center">
      {icon && <span className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-400">
        {icon}
      </span>}
      <p className="text-sm font-medium text-slate-600">{title}</p>
      {description && <p className="mt-1 text-xs text-slate-500">{description}</p>}
    </div>
  );
}

/* ─────────────────────────── SKELETON ─────────────────────────── */

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-2xl bg-slate-200", className)} />;
}

export function SkeletonCard() {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <Skeleton className="mb-3 h-4 w-24" />
      <Skeleton className="mb-2 h-3 w-full" />
      <Skeleton className="h-3 w-3/4" />
    </div>
  );
}

/* ─────────────────────────── ALERT ─────────────────────────── */

type AlertTone = "error" | "success" | "info" | "warning";

interface AlertProps {
  tone: AlertTone;
  children: ReactNode;
  onDismiss?: () => void;
}

const ALERT_TONES: Record<AlertTone, string> = {
  error: "border-red-200 bg-red-50 text-red-700",
  success: "border-quotefly-blue/20 bg-quotefly-blue/[0.06] text-quotefly-blue",
  info: "border-quotefly-blue/20 bg-quotefly-blue/[0.06] text-quotefly-blue",
  warning: "border-amber-200 bg-amber-50 text-amber-700",
};

export function Alert({ tone, children, onDismiss }: AlertProps) {
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`flex items-center justify-between gap-2 rounded-lg border px-4 py-2.5 text-sm ${ALERT_TONES[tone]}`}>
      <span>{children}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="text-current opacity-60 hover:opacity-100 text-lg leading-none">&times;</button>
      )}
    </div>
  );
}

type ModalSize = "sm" | "md" | "lg" | "xl";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  size?: ModalSize;
  closeOnBackdrop?: boolean;
  panelClassName?: string;
  ariaLabel?: string;
}

const MODAL_SIZES: Record<ModalSize, string> = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
};

export function Modal({
  open,
  onClose,
  children,
  size = "md",
  closeOnBackdrop = true,
  panelClassName = "",
  ariaLabel,
}: ModalProps) {
  const titleId = useId();

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/65 p-3 backdrop-blur-sm sm:p-4"
      onClick={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={ariaLabel ? undefined : titleId}
        aria-label={ariaLabel}
      className={cn(
        "flex max-h-[90vh] w-full flex-col overflow-hidden rounded-[30px] border border-slate-200 bg-white shadow-[0_28px_80px_rgba(15,23,42,0.22)]",
        MODAL_SIZES[size],
        panelClassName,
      )}
        onClick={(event) => event.stopPropagation()}
      >
        <div id={titleId} className="sr-only">
          {ariaLabel ?? "Modal"}
        </div>
        {children}
      </div>
    </div>
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
  return (
    <div className={`flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 sm:px-6 ${className}`}>
      <div className="min-w-0">
        <h2 className="text-lg font-semibold text-slate-900 sm:text-xl">{title}</h2>
        {description ? <p className="mt-1 text-sm text-slate-600">{description}</p> : null}
      </div>
      {onClose ? (
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-slate-300 bg-white text-slate-500 transition hover:bg-slate-50 hover:text-slate-900"
          aria-label="Close modal"
        >
          <span className="text-xl leading-none">&times;</span>
        </button>
      ) : null}
    </div>
  );
}

export function ModalBody({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6 ${className}`}>{children}</div>;
}

export function ModalFooter({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`flex flex-wrap justify-end gap-2 border-t border-slate-200 px-5 py-4 sm:px-6 ${className}`}>{children}</div>;
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
}

export function ConfirmModal({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  loading = false,
  confirmVariant = "danger",
  children,
  size = "sm",
}: ConfirmModalProps) {
  return (
    <Modal open={open} onClose={onClose} size={size} ariaLabel={title}>
      <ModalHeader title={title} description={description} onClose={onClose} />
      {children ? <ModalBody>{children}</ModalBody> : null}
      <ModalFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={loading}>
          {cancelLabel}
        </Button>
        <Button type="button" variant={confirmVariant} onClick={onConfirm} loading={loading}>
          {confirmLabel}
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
  className = "",
}: {
  value: number;
  label?: string;
  hint?: string;
  className?: string;
}) {
  const clampedValue = Math.max(0, Math.min(100, value));

  return (
    <div className={`space-y-1.5 ${className}`}>
      {(label || hint) && (
        <div className="flex items-center justify-between gap-2 text-xs font-medium text-slate-500">
          <span>{label}</span>
          {hint ? <span>{hint}</span> : null}
        </div>
      )}
      <div className="h-2.5 overflow-hidden rounded-full bg-slate-100">
        <div
          className="h-full rounded-full bg-quotefly-blue transition-[width] duration-500 ease-out"
          style={{ width: `${clampedValue}%` }}
        />
      </div>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-600 sm:text-base">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

