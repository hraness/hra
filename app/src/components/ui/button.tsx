import type { ButtonHTMLAttributes, ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";

import { staticStylexClassName } from "../../lib/cn";
import { buttonStyles } from "./primitives.stylex";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "default" | "small" | "icon";

const variantStyles: Readonly<Record<ButtonVariant, StyleXStyles>> = {
  danger: buttonStyles.danger,
  ghost: buttonStyles.ghost,
  primary: buttonStyles.primary,
  secondary: buttonStyles.secondary,
};

const sizeStyles: Readonly<Record<ButtonSize, StyleXStyles>> = {
  default: buttonStyles.defaultSize,
  icon: buttonStyles.iconSize,
  small: buttonStyles.smallSize,
};

export type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "style"> & Readonly<{
  children?: ReactNode;
  size?: ButtonSize;
  style?: never;
  variant?: ButtonVariant;
  xstyle?: StyleXStyles;
}>;

function rejectInlineStyle(style: unknown): void {
  if (style !== undefined) throw new Error("HRA primitives do not accept caller inline styles.");
}

export function Button({
  className,
  size = "default",
  style,
  type = "button",
  variant = "primary",
  xstyle,
  ...rest
}: ButtonProps) {
  rejectInlineStyle(style);
  const presentation = stylex.props(
    buttonStyles.root,
    sizeStyles[size],
    variantStyles[variant],
    xstyle,
  );
  return (
    <button
      className={staticStylexClassName(presentation, className)}
      type={type}
      {...rest}
    />
  );
}
