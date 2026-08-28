import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export type KodySparkIconProps = Omit<HTMLAttributes<HTMLSpanElement>, "children" | "title"> & {
  size?: number | string;
  title?: string;
  thinking?: boolean;
};

const THINKING_STYLES = `
@media (prefers-reduced-motion: no-preference) {
  .qf-kody-spark-icon--thinking .qf-kody-spark-icon__spark {
    animation: qf-kody-spark-pulse 1.2s ease-in-out infinite;
    transform-box: fill-box;
    transform-origin: center;
  }
}

@keyframes qf-kody-spark-pulse {
  0%, 100% { opacity: 0.74; transform: scale(0.88) rotate(0deg); }
  50% { opacity: 1; transform: scale(1.08) rotate(8deg); }
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
      <svg
        viewBox="0 0 24 24"
        width="100%"
        height="100%"
        aria-hidden="true"
        focusable="false"
        className="block overflow-visible"
      >
        <path
          d="M4.25 3.25h10.5A3.25 3.25 0 0 1 18 6.5v6.7a3.25 3.25 0 0 1-3.25 3.25H9.42l-3.96 3.02a.75.75 0 0 1-1.21-.6V16.1A3.25 3.25 0 0 1 1 12.85V6.5a3.25 3.25 0 0 1 3.25-3.25Z"
          fill="#2f6fd6"
        />
        <path
          d="M5.35 7.1h7.25M5.35 10.25h5.35M5.35 13.4h3.15"
          fill="none"
          stroke="#fff"
          strokeWidth="1.55"
          strokeLinecap="round"
        />
        <path
          className="qf-kody-spark-icon__spark"
          d="M18.4 5.05c.36 1.86 1.34 2.84 3.2 3.2-1.86.36-2.84 1.34-3.2 3.2-.36-1.86-1.34-2.84-3.2-3.2 1.86-.36 2.84-1.34 3.2-3.2Z"
          fill="#ff8912"
          stroke="#fff"
          strokeWidth=".65"
          strokeLinejoin="round"
        />
        <circle cx="21.35" cy="4.1" r="1.05" fill="#ffb04d" />
      </svg>
    </span>
  );
}
