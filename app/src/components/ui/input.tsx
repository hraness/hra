import type { InputHTMLAttributes } from "react";
import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";

import { staticStylexClassName } from "../../lib/cn";
import { fieldStyles } from "./primitives.stylex";

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "style"> & Readonly<{
  style?: never;
  xstyle?: StyleXStyles;
}>;

export function Input({ className, style, xstyle, ...rest }: InputProps) {
  if (style !== undefined) throw new Error("HRA primitives do not accept caller inline styles.");
  const presentation = stylex.props(fieldStyles.input, xstyle);
  return (
    <input
      className={staticStylexClassName(presentation, className)}
      {...rest}
    />
  );
}
