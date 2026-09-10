import type { HTMLAttributes } from "react";
import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";

import { staticStylexClassName } from "../../lib/cn";
import { badgeStyles } from "./primitives.stylex";

export type BadgeTone = "neutral" | "accent" | "attention" | "danger";

const toneStyles: Readonly<Record<BadgeTone, StyleXStyles>> = {
  accent: badgeStyles.accent,
  attention: badgeStyles.attention,
  danger: badgeStyles.danger,
  neutral: badgeStyles.neutral,
};

export type BadgeProps = Omit<HTMLAttributes<HTMLSpanElement>, "style"> & Readonly<{
  style?: never;
  tone?: BadgeTone;
  xstyle?: StyleXStyles;
}>;

function rejectInlineStyle(style: unknown): void {
  if (style !== undefined) throw new Error("Oompa primitives do not accept caller inline styles.");
}

export function Badge({ className, style, tone = "neutral", xstyle, ...rest }: BadgeProps) {
  rejectInlineStyle(style);
  const presentation = stylex.props(badgeStyles.root, toneStyles[tone], xstyle);
  return (
    <span
      className={staticStylexClassName(presentation, className)}
      {...rest}
    />
  );
}
