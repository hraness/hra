import type { HTMLAttributes } from "react";

import { cn } from "../../lib/cn";

export type BadgeTone = "neutral" | "accent" | "attention" | "danger";

const toneClasses: Readonly<Record<BadgeTone, string>> = {
  accent: "border-accent text-accent",
  attention: "border-attention text-attention",
  danger: "border-danger text-danger",
  neutral: "border-line text-ink-muted",
};

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & Readonly<{ tone?: BadgeTone }>;

export function Badge({ className, tone = "neutral", ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        toneClasses[tone],
        className,
      )}
      {...rest}
    />
  );
}
