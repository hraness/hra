"use client";

import type { ReactElement, ReactNode, RefObject } from "react";
import {
  Tooltip as AriaTooltip,
  type TooltipProps as AriaTooltipProps,
  TooltipTrigger as AriaTooltipTrigger,
  type TooltipTriggerComponentProps,
  TooltipTriggerStateContext,
} from "react-aria-components";
import { useTooltipTriggerState } from "react-stately/useTooltipTriggerState";

import { classNames } from "./class-names";
import { useDesignPortalClassName, useDesignPortalTheme } from "./design-theme-context";

// Keep a portal tooltip open long enough for a deliberate pointer to cross the
// positioned gap. This matches React Aria's forgiving default instead of
// turning an 8px visual offset into a hover dead zone.
export const DEFAULT_TOOLTIP_CLOSE_DELAY = 500;
export const DEFAULT_TOOLTIP_DELAY = 500;

type TooltipStateProps = Pick<
  TooltipTriggerComponentProps,
  "closeDelay" | "defaultOpen" | "delay" | "isDisabled" | "isOpen" | "onOpenChange"
>;

type TooltipCopy =
  | {
    /** The trigger must retain its own accessible name; this label is supplementary help. */
    readonly label: ReactNode;
    readonly content?: never;
  }
  | {
    /** Compatibility name for explanatory tooltip content. */
    readonly content: ReactNode;
    readonly label?: never;
  };

type TooltipAnchor =
  | {
    /** A conventional interactive child that owns the tooltip trigger behavior. */
    readonly children: ReactElement;
    readonly triggerRef?: never;
  }
  | {
    /** An existing visible trigger used for positioning when behavior is owned by its composite. */
    readonly children?: never;
    readonly triggerRef: RefObject<Element | null>;
  };

export type TooltipProps = Omit<
  AriaTooltipProps,
  "children" | "className" | "defaultOpen" | "isOpen" | "onOpenChange" | "triggerRef"
> & TooltipStateProps & TooltipCopy & TooltipAnchor & {
  readonly className?: string;
};

/** Keyboard and hover discoverability for compact controls that retain an accessible name. */
export function Tooltip({
  children,
  className,
  closeDelay = DEFAULT_TOOLTIP_CLOSE_DELAY,
  content,
  defaultOpen,
  delay = DEFAULT_TOOLTIP_DELAY,
  isDisabled,
  isOpen,
  label,
  onOpenChange,
  offset = 8,
  placement = "top",
  triggerRef,
  ...props
}: TooltipProps) {
  const designTheme = useDesignPortalTheme();
  const portalClassName = useDesignPortalClassName();
  const anchoredState = useTooltipTriggerState({
    closeDelay,
    delay,
    ...(defaultOpen === undefined ? {} : { defaultOpen }),
    ...(isDisabled === undefined ? {} : { isDisabled }),
    ...(isOpen === undefined ? {} : { isOpen }),
    ...(onOpenChange === undefined ? {} : { onOpenChange }),
  });
  const tooltip = (
    <AriaTooltip
      {...props}
      className={classNames("jungle-tooltip", portalClassName, className)}
      data-theme={designTheme}
      offset={offset}
      placement={placement}
      {...(triggerRef === undefined ? {} : { triggerRef })}
    >
      {label ?? content}
    </AriaTooltip>
  );

  if (triggerRef !== undefined) {
    return (
      <TooltipTriggerStateContext.Provider value={anchoredState}>
        {tooltip}
      </TooltipTriggerStateContext.Provider>
    );
  }

  return (
    <AriaTooltipTrigger
      closeDelay={closeDelay}
      delay={delay}
      {...(defaultOpen === undefined ? {} : { defaultOpen })}
      {...(isDisabled === undefined ? {} : { isDisabled })}
      {...(isOpen === undefined ? {} : { isOpen })}
      {...(onOpenChange === undefined ? {} : { onOpenChange })}
    >
      {children}
      {tooltip}
    </AriaTooltipTrigger>
  );
}
