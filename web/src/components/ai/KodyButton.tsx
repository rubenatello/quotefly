import type { ReactNode } from "react";
import type { AiAssistantContext, AiAssistantRequestedTool } from "../../lib/api";
import { useTrack } from "../../lib/analytics";
import { cn } from "../../lib/utils";
import { IconButton } from "../ui";
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
}: {
  prompt: string;
  tool?: AiAssistantRequestedTool;
  context?: AiAssistantContext;
  label?: string;
  icon?: ReactNode;
  size?: "sm" | "md" | "lg";
  className?: string;
  disabled?: boolean;
}) {
  const track = useTrack();
  const iconSize = size === "lg" ? 34 : size === "md" ? 30 : 24;
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
      onClick={() => {
        track("kody_context_open", { tool, currentPage: context?.currentPage ?? "unknown" });
        openKody({ prompt, tool, context });
      }}
    />
  );
}
