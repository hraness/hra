"use client";

import type { Ref } from "react";
import {
  Toolbar as AriaToolbar,
  type ToolbarProps as AriaToolbarProps,
} from "react-aria-components";

import { classNames } from "./class-names";

type AccessibleName =
  | { readonly "aria-label": string; readonly "aria-labelledby"?: never }
  | { readonly "aria-label"?: never; readonly "aria-labelledby": string };

export type ToolbarProps = Omit<
  AriaToolbarProps,
  "aria-label" | "aria-labelledby" | "className"
> &
  AccessibleName & {
    readonly className?: string;
    readonly toolbarRef?: Ref<HTMLDivElement>;
  };

/** Groups commands into one keyboard stop with arrow-key navigation between controls. */
export function Toolbar({ className, toolbarRef, ...props }: ToolbarProps) {
  return (
    <AriaToolbar
      {...props}
      className={classNames("jungle-toolbar", className)}
      ref={toolbarRef}
    />
  );
}
