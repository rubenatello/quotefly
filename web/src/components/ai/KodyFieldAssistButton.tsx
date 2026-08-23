import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import { Button } from "../ui";
import { KodySparkIcon } from "./KodySparkIcon";

export function KodyFieldAssistButton({
  label,
  onClick,
  disabled,
  className,
  ariaDescribedBy,
}: {
  label?: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  ariaDescribedBy?: string;
}) {
  const { t } = useTranslation();
  const resolvedLabel = label ?? t("quoteComponents.kodyAssist.default");

  return (
    <Button
      type="button"
      variant="kodyTrigger"
      size="sm"
      className={cn("qf-kody-context-action min-h-11 shrink-0 rounded-full px-3 text-xs sm:min-h-9", className)}
      icon={<KodySparkIcon size={22} />}
      onClick={onClick}
      disabled={disabled}
      aria-describedby={ariaDescribedBy}
    >
      {resolvedLabel}
    </Button>
  );
}

/** A compact, persistent explanation kept adjacent to disabled paid AI controls. */
export function AiPaidPauseNotice({
  id,
  message,
  className,
}: {
  id: string;
  message: string;
  className?: string;
}) {
  return (
    <p
      id={id}
      role="status"
      aria-live="polite"
      data-testid="quote-ai-pause-reason"
      className={cn("rounded-lg border border-[var(--qf-warning-border)] bg-[var(--qf-warning-bg)] px-2 py-1 text-xs leading-4 text-[var(--qf-warning-text)]", className)}
    >
      {message}
    </p>
  );
}
