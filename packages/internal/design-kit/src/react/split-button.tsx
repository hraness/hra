"use client";

import {
  Children,
  createContext,
  isValidElement,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
  useContext,
} from "react";
import type { MenuTriggerProps as AriaMenuTriggerProps } from "react-aria-components";

import {
  Button,
  type ButtonProps,
  type ButtonSize,
  type ButtonVariant,
  IconButton,
  type IconButtonProps,
} from "./button";
import { classNames } from "./class-names";
import { MenuTrigger } from "./menu";

type AccessibleName =
  | { readonly "aria-label": string; readonly "aria-labelledby"?: never }
  | { readonly "aria-label"?: never; readonly "aria-labelledby": string };

interface SplitButtonContextValue {
  readonly size: ButtonSize;
  readonly variant: ButtonVariant;
}

type DistributiveOmit<Value, Keys extends PropertyKey> = Value extends unknown
  ? Omit<Value, Keys>
  : never;

const SplitButtonContext = createContext<SplitButtonContextValue | null>(null);

export type SplitButtonProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  "aria-label" | "aria-labelledby" | "children" | "className" | "role"
> &
  AccessibleName & {
    readonly children: ReactNode;
    readonly className?: string;
    readonly size?: ButtonSize;
    readonly variant?: ButtonVariant;
  };

function requireSplitButtonContext(): SplitButtonContextValue {
  const context = useContext(SplitButtonContext);
  if (context === null) {
    throw new Error("SplitButton segments must be direct children of SplitButton.");
  }
  return context;
}

function hasExpectedSegments(children: ReactNode): boolean {
  const segments = Children.toArray(children);
  return segments.length === 2
    && isValidElement(segments[0])
    && segments[0].type === SplitButtonPrimary
    && isValidElement(segments[1])
    && segments[1].type === SplitButtonMenuTrigger;
}

/**
 * One joined action with a stable default command and an adjacent menu of
 * alternatives. Both independently focusable segments inherit one size and
 * visual variant from the group.
 */
export function SplitButton({
  children,
  className,
  size = "default",
  variant = "secondary",
  ...props
}: SplitButtonProps) {
  if (!hasExpectedSegments(children)) {
    throw new Error(
      "SplitButton requires SplitButtonPrimary followed by SplitButtonMenuTrigger.",
    );
  }

  return (
    <SplitButtonContext.Provider value={{ size, variant }}>
      <div
        {...props}
        className={classNames("jungle-split-button", className)}
        data-size={size}
        data-variant={variant}
        role="group"
      >
        {children}
      </div>
    </SplitButtonContext.Provider>
  );
}

export type SplitButtonPrimaryProps = Omit<ButtonProps, "size" | "variant">;

export function SplitButtonPrimary({
  className,
  ...props
}: SplitButtonPrimaryProps) {
  const { size, variant } = requireSplitButtonContext();
  return (
    <Button
      {...props}
      className={classNames("jungle-split-button__primary", className)}
      data-split-button-segment="primary"
      size={size}
      variant={variant}
    />
  );
}

export type SplitButtonMenuTriggerProps = DistributiveOmit<
  IconButtonProps,
  "children" | "size" | "surfaceMotion" | "variant"
> & {
  readonly children: ReactNode;
  readonly menu: ReactElement;
  readonly triggerProps?: Omit<AriaMenuTriggerProps, "children">;
};

export function SplitButtonMenuTrigger({
  children,
  className,
  menu,
  triggerProps,
  ...props
}: SplitButtonMenuTriggerProps) {
  const { size, variant } = requireSplitButtonContext();
  return (
    <MenuTrigger {...triggerProps}>
      <IconButton
        {...props}
        className={classNames("jungle-split-button__menu", className)}
        data-split-button-segment="menu"
        size={size}
        variant={variant}
      >
        {children}
      </IconButton>
      {menu}
    </MenuTrigger>
  );
}
