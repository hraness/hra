"use client";

import type {
  AnchorHTMLAttributes,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from "react";

import { classNames } from "./class-names";

export type SkipLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "children" | "href"> & {
  readonly children?: ReactNode;
  readonly href?: `#${string}`;
};

export function SkipLink({
  children = "Skip to main content",
  className,
  href = "#main-content",
  onClick,
  onKeyDown,
  ...props
}: SkipLinkProps) {
  const focusTarget = (): boolean => {
    if (!href.startsWith("#") || href.length === 1) return false;
    const target = document.getElementById(href.slice(1));
    if (target === null) return false;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "start" });
    return true;
  };

  const handleClick = (event: ReactMouseEvent<HTMLAnchorElement>): void => {
    onClick?.(event);
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      return;
    }
    if (focusTarget()) event.preventDefault();
  };

  const handleKeyDown = (
    event: ReactKeyboardEvent<HTMLAnchorElement>,
  ): void => {
    onKeyDown?.(event);
    if (
      event.defaultPrevented ||
      event.key !== "Enter" ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      return;
    }
    if (focusTarget()) event.preventDefault();
  };

  return (
    <a
      {...props}
      className={classNames("jungle-skip-link", className)}
      href={href}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      {children}
    </a>
  );
}
