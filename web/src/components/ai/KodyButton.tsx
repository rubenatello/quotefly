import type { ReactNode } from "react";
import type { AiAssistantContext, AiAssistantRequestedTool } from "../../lib/api";
import { useTrack } from "../../lib/analytics";
import { cn } from "../../lib/utils";
import { Button } from "../ui";
import { KodySparkIcon } from "./KodySparkIcon";
import { openKody } from "./kody-events";

export function KodyButton({
  prompt,
  tool = "AUTO",
  context,
  label = "Ask Kody",
  icon,
  variant = "kody",
  size = "sm",
  className,
  disabled,
}: {
  prompt: string;
  tool?: AiAssistantRequestedTool;
  context?: AiAssistantContext;
  label?: string;
  icon?: ReactNode;
  variant?: "primary" | "secondary" | "kody" | "outline" | "ghost";
  size?: "sm" | "md" | "lg";
  className?: string;
  disabled?: boolean;
}) {
  const track = useTrack();
  const iconSize = size === "lg" ? 24 : size === "md" ? 22 : 20;
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={cn("qf-kody-context-action", className)}
      icon={icon ?? <KodySparkIcon size={iconSize} />}
      disabled={disabled}
      onClick={() => {
        track("kody_context_open", { tool, currentPage: context?.currentPage ?? "unknown" });
        openKody({ prompt, tool, context });
      }}
    >
      {label}
    </Button>
  );
}
