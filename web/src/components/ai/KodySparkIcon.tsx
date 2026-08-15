import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export type KodySparkIconProps = Omit<HTMLAttributes<HTMLSpanElement>, "children" | "title"> & {
  size?: number | string;
  title?: string;
  thinking?: boolean;
};

const THINKING_STYLES = `
@media (prefers-reduced-motion: no-preference) {
  .qf-kody-spark-icon--thinking .qf-kody-spark-icon__image {
    animation: qf-kody-avatar-pulse 1.35s ease-in-out infinite;
    transform-origin: center;
  }
}

@keyframes qf-kody-avatar-pulse {
  0%, 100% { opacity: 0.72; transform: scale(0.94); }
  50% { opacity: 1; transform: scale(1.04); }
}
`;

export function KodySparkIcon({
  size = 18,
  title,
  thinking = false,
  className,
  role,
  "aria-hidden": ariaHidden,
  style,
  ...props
}: KodySparkIconProps) {
  return (
    <span
      {...props}
      role={title ? "img" : role}
      aria-hidden={title ? undefined : ariaHidden ?? true}
      aria-label={title}
      className={cn(
        "qf-kody-spark-icon inline-flex shrink-0 items-center justify-center",
        thinking && "qf-kody-spark-icon--thinking",
        className,
      )}
      style={{ width: size, height: size, ...style }}
    >
      {thinking ? <style>{THINKING_STYLES}</style> : null}
      <img
        src="/images/kody/kody-ai.png"
        alt=""
        aria-hidden="true"
        draggable={false}
        decoding="async"
        className="qf-kody-spark-icon__image h-full w-full select-none object-contain"
      />
    </span>
  );
}
