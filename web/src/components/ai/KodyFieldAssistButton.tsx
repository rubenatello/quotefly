import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import { Button } from "../ui";
import { KodySparkIcon } from "./KodySparkIcon";

export function KodyFieldAssistButton({
  label,
  onClick,
  disabled,
  className,
}: {
  label?: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const resolvedLabel = label ?? t("quoteComponents.kodyAssist.default");

  return (
    <Button
      type="button"
      variant="kodyTrigger"
      size="sm"
      className={cn("min-h-11 shrink-0 rounded-full px-3 text-xs sm:min-h-9", className)}
      icon={<KodySparkIcon size={22} />}
      onClick={onClick}
      disabled={disabled}
    >
      {resolvedLabel}
    </Button>
  );
}
