import { useId, type SVGProps } from "react";
import { cn } from "../../lib/utils";

export type KodySparkIconProps = Omit<SVGProps<SVGSVGElement>, "children"> & {
  size?: number | string;
  title?: string;
  thinking?: boolean;
};

const THINKING_STYLES = `
@media (prefers-reduced-motion: no-preference) {
  .qf-kody-spark-icon--thinking .qf-kody-spark-icon__spark {
    animation: qf-kody-spark-icon-pulse 1.35s ease-in-out infinite;
    transform-box: fill-box;
    transform-origin: center;
  }

  .qf-kody-spark-icon--thinking .qf-kody-spark-icon__wing {
    animation: qf-kody-spark-icon-nudge 1.35s ease-in-out infinite;
  }
}

@keyframes qf-kody-spark-icon-pulse {
  0%, 100% { opacity: 0.58; transform: scale(0.9); }
  50% { opacity: 1; transform: scale(1.08); }
}

@keyframes qf-kody-spark-icon-nudge {
  0%, 100% { transform: translateX(0); }
  50% { transform: translateX(0.55px); }
}
`;

export function KodySparkIcon({
  size = 18,
  title,
  thinking = false,
  className,
  role,
  "aria-hidden": ariaHidden,
  "aria-labelledby": ariaLabelledBy,
  ...props
}: KodySparkIconProps) {
  const titleId = useId();

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : role}
      aria-hidden={title ? undefined : ariaHidden ?? true}
      aria-labelledby={title ? titleId : ariaLabelledBy}
      className={cn("qf-kody-spark-icon shrink-0", thinking && "qf-kody-spark-icon--thinking", className)}
      {...props}
    >
      {thinking ? <style>{THINKING_STYLES}</style> : null}
      {title ? <title id={titleId}>{title}</title> : null}
      <path
        d="M6.25 5.9h7.8c2.45 0 4.45 1.88 4.45 4.2v2.1c0 2.32-2 4.2-4.45 4.2h-3.9L6.25 18.7v-2.3c-2.45 0-4.45-1.88-4.45-4.2v-2.1c0-2.32 2-4.2 4.45-4.2Z"
        opacity="0.72"
      />
      <path d="M7.35 8.65v6.65" />
      <path className="qf-kody-spark-icon__wing" d="M7.55 12.1 13.4 7.8l4.1-1.95-1.95 4.1-8 5.4" />
      <path className="qf-kody-spark-icon__wing" d="m13.4 7.8 2.15 2.15" />
      <g className="qf-kody-spark-icon__spark">
        <path d="M19.3 2.85v2.45" />
        <path d="M18.08 4.08h2.45" />
        <path d="M21.05 6.75v1.35" opacity="0.7" />
        <path d="M20.38 7.42h1.35" opacity="0.7" />
      </g>
    </svg>
  );
}
