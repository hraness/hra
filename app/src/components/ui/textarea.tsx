import type { TextareaHTMLAttributes } from "react";
import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";

import { staticStylexClassName } from "../../lib/cn";
import { fieldStyles } from "./primitives.stylex";

export type TextareaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "style"> & Readonly<{
  style?: never;
  xstyle?: StyleXStyles;
}>;

function rejectInlineStyle(style: unknown): void {
  if (style !== undefined) throw new Error("HRA primitives do not accept caller inline styles.");
}

export function Textarea({ className, rows = 2, style, xstyle, ...rest }: TextareaProps) {
  rejectInlineStyle(style);
  const presentation = stylex.props(fieldStyles.textarea, xstyle);
  return (
    <textarea
      className={staticStylexClassName(presentation, className)}
      rows={rows}
      {...rest}
    />
  );
}
