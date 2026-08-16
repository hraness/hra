"use client";

import { createElement, type HTMLAttributes, type ReactNode, useEffect } from "react";

import { classNames } from "./class-names";
import { ensureJellyRuntime } from "./jelly-runtime";

export type StatusTone = "danger" | "neutral" | "success" | "warning";

export type StatusDotProps = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  readonly tone?: StatusTone;
};

export function StatusDot({ className, tone = "neutral", ...props }: StatusDotProps) {
  return (
    <span
      {...props}
      aria-hidden="true"
      className={classNames("jungle-status-dot", className)}
      data-tone={tone}
    />
  );
}

export type BadgeProps = Omit<HTMLAttributes<HTMLElement>, "aria-live" | "role"> & {
  readonly children: ReactNode;
  readonly isLive?: boolean;
  readonly tone?: StatusTone;
};

export function Badge({ children, className, isLive = false, tone = "neutral", ...props }: BadgeProps) {
  useEffect(() => {
    void ensureJellyRuntime();
  }, []);

  const variant = {
    danger: "rose",
    neutral: "platinum",
    success: "mint",
    warning: "amber",
  }[tone];

  return createElement(
    "jelly-badge",
    {
      ...props,
      "aria-live": isLive ? "polite" : undefined,
      className: classNames("jungle-badge", className),
      "data-tone": tone,
      live: isLive || undefined,
      role: isLive ? "status" : undefined,
      size: "small",
      variant,
    },
    children,
  );
}
