import type { ReactNode } from "react";
import type { AiAssistantContext, AiAssistantRequestedTool } from "../../lib/api";
import { useTrack } from "../../lib/analytics";
import { cn } from "../../lib/utils";
import { Button, IconButton } from "../ui";
import { KodySparkIcon } from "./KodySparkIcon";
import { openKody } from "./kody-events";

export function KodyButton({
  prompt,
  tool = "AUTO",
  context,
  label = "Ask Kody",
  icon,
  size = "md",
  className,
  disabled,
  showLabel = false,
}: {
  prompt: string;
  tool?: AiAssistantRequestedTool;
  context?: AiAssistantContext;
  label?: string;
  icon?: ReactNode;
  size?: "sm" | "md" | "lg";
  className?: string;
  disabled?: boolean;
  showLabel?: boolean;
}) {
  const track = useTrack();
  const iconSize = size === "lg" ? 34 : size === "md" ? 30 : 24;
  const handleClick = () => {
    track("kody_context_open", { tool, currentPage: context?.currentPage ?? "unknown" });
    openKody({ prompt, tool, context });
  };

  if (showLabel) {
    return (
      <Button
        type="button"
        variant="kodyTrigger"
        size={size}
        className={cn("qf-kody-context-action", className)}
        icon={icon ?? <KodySparkIcon size={iconSize} />}
        disabled={disabled}
        onClick={handleClick}
      >
        {label}
      </Button>
    );
  }

  return (
    <IconButton
      type="button"
      variant="kodyTrigger"
      size={size}
      className={cn("qf-kody-context-action !rounded-full", className)}
      label={label}
      title={label}
      icon={icon ?? <KodySparkIcon size={iconSize} />}
      disabled={disabled}
      onClick={handleClick}
    />
  );
}
