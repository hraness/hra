"use client";

import { HelpCircleIcon } from "@hugeicons/core-free-icons";
import type { ComponentProps, ReactNode } from "react";
import {
  Dialog as AriaDialog,
  DialogTrigger as AriaDialogTrigger,
  Popover as AriaPopover,
  type PopoverProps as AriaPopoverProps,
} from "react-aria-components";

import { IconButton, type IconButtonProps } from "./button";
import { classNames } from "./class-names";
import { useDesignPortalClassName, useDesignPortalTheme } from "./design-theme-context";
import { Icon } from "./icon";
import type { IconTooltipContent } from "./icon-affordance";
import { JellySurface } from "./jelly-surface";

const helpPopoverClearance = 24;

export type HelpPopoverProps = Omit<
  AriaPopoverProps,
  "aria-label" | "aria-labelledby" | "children" | "className" | "defaultOpen" | "isOpen"
  | "onOpenChange"
> & {
  /** A concise accessible name for the explanatory dialog. */
  readonly "aria-label": string;
  readonly children: ReactNode;
  readonly className?: string;
  readonly dialogClassName?: string;
  readonly surfaceClassName?: string;
};

/**
 * A compact explanatory dialog positioned from a surrounding React Aria
 * `DialogTrigger`. React Aria owns outside press, Escape dismissal, focus
 * containment, and trigger focus restoration.
 */
export function HelpPopover({
  "aria-label": ariaLabel,
  children,
  className,
  containerPadding = helpPopoverClearance,
  dialogClassName,
  offset = 8,
  placement = "top",
  surfaceClassName,
  ...props
}: HelpPopoverProps) {
  const designTheme = useDesignPortalTheme();
  const portalClassName = useDesignPortalClassName();

  return (
    <AriaPopover
      {...props}
      className={classNames("jungle-help-popover", portalClassName, className)}
      containerPadding={containerPadding}
      data-theme={designTheme}
      offset={offset}
      placement={placement}
    >
      <JellySurface
        className={classNames("jungle-help-popover__surface", surfaceClassName)}
        tone="overlay"
      >
        <AriaDialog
          aria-label={ariaLabel}
          className={classNames("jungle-help-popover__dialog", dialogClassName)}
        >
          <div className="jungle-help-popover__content">{children}</div>
        </AriaDialog>
      </JellySurface>
    </AriaPopover>
  );
}

export interface InlineHelpProps extends Pick<
  ComponentProps<typeof AriaDialogTrigger>,
  "defaultOpen" | "isOpen" | "onOpenChange"
> {
  /** Names the icon trigger, its hover/focus tooltip, and the opened help dialog. */
  readonly "aria-label": string;
  readonly children: ReactNode;
  readonly dialogClassName?: string;
  readonly placement?: HelpPopoverProps["placement"];
  readonly popoverClassName?: string;
  readonly surfaceClassName?: string;
  readonly tooltip?: IconTooltipContent;
  readonly tooltipDelay?: number;
  readonly tooltipPlacement?: IconButtonProps["tooltipPlacement"];
  readonly triggerClassName?: string;
}

/**
 * Supplementary field help that is discoverable by hover and focus, and opens
 * durable explanatory content on mouse, touch, Enter, or Space activation.
 */
export function InlineHelp({
  "aria-label": ariaLabel,
  children,
  defaultOpen,
  dialogClassName,
  isOpen,
  onOpenChange,
  placement,
  popoverClassName,
  surfaceClassName,
  tooltip,
  tooltipDelay,
  tooltipPlacement,
  triggerClassName,
}: InlineHelpProps) {
  return (
    <AriaDialogTrigger
      {...(defaultOpen === undefined ? {} : { defaultOpen })}
      {...(isOpen === undefined ? {} : { isOpen })}
      {...(onOpenChange === undefined ? {} : { onOpenChange })}
    >
      <IconButton
        aria-label={ariaLabel}
        className={classNames("jungle-inline-help", triggerClassName)}
        size="compact"
        {...(tooltip === undefined ? {} : { tooltip })}
        {...(tooltipDelay === undefined ? {} : { tooltipDelay })}
        {...(tooltipPlacement === undefined ? {} : { tooltipPlacement })}
      >
        <Icon icon={HelpCircleIcon} size={18} />
      </IconButton>
      <HelpPopover
        aria-label={ariaLabel}
        {...(dialogClassName === undefined ? {} : { dialogClassName })}
        {...(placement === undefined ? {} : { placement })}
        {...(popoverClassName === undefined ? {} : { className: popoverClassName })}
        {...(surfaceClassName === undefined ? {} : { surfaceClassName })}
      >
        {children}
      </HelpPopover>
    </AriaDialogTrigger>
  );
}
