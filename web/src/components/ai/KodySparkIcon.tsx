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
      <path d="M6.8 6.8h8.4a3.8 3.8 0 0 1 3.8 3.8v1.8a3.8 3.8 0 0 1-3.8 3.8h-4.1l-3.6 2v-2.05a3.8 3.8 0 0 1-4.5-3.75v-1.8a3.8 3.8 0 0 1 3.8-3.8Z" opacity="0.82" />
      <path className="qf-kody-spark-icon__wing" d="m10.9 8.9.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7.7-1.9Z" />
      <g className="qf-kody-spark-icon__spark">
        <path d="M18.5 2.8v2.7" />
        <path d="M17.15 4.15h2.7" />
      </g>
    </svg>
  );
}
