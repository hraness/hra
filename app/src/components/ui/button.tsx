import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "../../lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "default" | "small" | "icon";

const variantClasses: Readonly<Record<ButtonVariant, string>> = {
  danger: "bg-danger text-surface hover:opacity-90",
  ghost: "bg-transparent text-ink-muted hover:text-ink hover:bg-surface-raised",
  primary: "bg-accent text-surface hover:opacity-90",
  secondary: "bg-surface-raised text-ink border border-line hover:border-ink-muted",
};

const sizeClasses: Readonly<Record<ButtonSize, string>> = {
  default: "min-h-11 px-4 text-sm",
  icon: "min-h-11 min-w-11 text-sm",
  small: "min-h-11 px-3 text-xs",
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & Readonly<{
  children?: ReactNode;
  size?: ButtonSize;
  variant?: ButtonVariant;
}>;

export function Button({
  className,
  size = "default",
  type = "button",
  variant = "primary",
  ...rest
}: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-md font-medium",
        "transition-opacity disabled:cursor-not-allowed disabled:opacity-50",
        sizeClasses[size],
        variantClasses[variant],
        className,
      )}
      type={type}
      {...rest}
    />
  );
}
