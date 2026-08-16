"use client";

import type { ButtonProps as AriaButtonProps } from "react-aria-components";
import { Button as AriaButton } from "react-aria-components";
import type { HTMLAttributes, ReactNode, Ref } from "react";

import { classNames } from "./class-names";
import {
  type IconAffordanceLabel,
  IconAffordanceTooltip,
  type IconAffordanceTooltipOptions,
  iconAffordanceTooltipLabel,
  useIconTooltipAnchor,
} from "./icon-affordance";
import {
  JellySurface,
  type JellySurfaceElement,
  type JellySurfaceTone,
} from "./jelly-surface";
import type { SurfaceShape } from "./surfaces";

export type CardProps = Omit<HTMLAttributes<HTMLElement>, "children"> & {
  readonly children: ReactNode;
  readonly shape?: SurfaceShape;
  readonly surfaceRef?: Ref<JellySurfaceElement>;
  readonly tone?: JellySurfaceTone;
};

export function Card({
  children,
  className,
  shape = "rounded",
  surfaceRef,
  tone = "neutral",
  ...props
}: CardProps) {
  return (
    <JellySurface
      {...props}
      className={classNames("jungle-card", className)}
      data-shape={shape}
      tone={tone}
      {...(surfaceRef === undefined ? {} : { surfaceRef })}
    >
      {children}
    </JellySurface>
  );
}

export type PressableCardProps = Omit<AriaButtonProps, "className"> & {
  readonly buttonRef?: Ref<HTMLButtonElement>;
  readonly className?: string;
  readonly shape?: SurfaceShape;
  readonly tone?: JellySurfaceTone;
};

export function PressableCard({
  buttonRef,
  className,
  isDisabled = false,
  isPending = false,
  shape = "rounded",
  tone = "neutral",
  ...props
}: PressableCardProps) {
  return (
    <JellySurface
      className={classNames("jungle-pressable-card", className)}
      data-shape={shape}
      interaction="press"
      isDisabled={isDisabled}
      isPending={isPending}
      tone={tone}
    >
      <AriaButton
        {...props}
        className="jungle-pressable-card__control"
        isDisabled={isDisabled}
        isPending={isPending}
        ref={buttonRef}
      />
    </JellySurface>
  );
}

type PressableTooltipContract =
  | (IconAffordanceLabel & IconAffordanceTooltipOptions)
  | Readonly<{
      "aria-label"?: never;
      "aria-labelledby"?: never;
      tooltip?: never;
      tooltipDelay?: never;
      tooltipPlacement?: never;
    }>;

export type PressableProps = Omit<
  AriaButtonProps,
  "aria-label" | "aria-labelledby" | "className" | "title"
> & PressableTooltipContract & {
  readonly buttonRef?: Ref<HTMLButtonElement>;
  readonly className?: string;
};

/**
 * Shared semantic press behavior for dense domain controls that own their
 * visuals. Supplying an accessible label marks an icon-only affordance and
 * intrinsically adds its required hover/focus tooltip.
 */
export function Pressable({
  buttonRef,
  className,
  isDisabled = false,
  isPending = false,
  tooltip,
  tooltipDelay,
  tooltipPlacement,
  ...props
}: PressableProps) {
  const hasTooltip = props["aria-label"] !== undefined || props["aria-labelledby"] !== undefined;
  const iconTooltip = useIconTooltipAnchor<HTMLButtonElement>({
    enabled: hasTooltip,
    ...(buttonRef === undefined ? {} : { forwardedRef: buttonRef }),
    ...(tooltipDelay === undefined ? {} : { delay: tooltipDelay }),
  });
  const control = (
    <AriaButton
      {...props}
      className={classNames("jungle-pressable", className)}
      isDisabled={isDisabled}
      isPending={isPending}
      ref={iconTooltip.ref}
    />
  );
  if (!hasTooltip) {
    return control;
  }
  const label = iconAffordanceTooltipLabel({
    ...(props["aria-label"] === undefined ? {} : { "aria-label": props["aria-label"] }),
    ...(props["aria-labelledby"] === undefined
      ? {}
      : { "aria-labelledby": props["aria-labelledby"] }),
    ...(tooltip === undefined ? {} : { tooltip }),
  });
  return (
    <IconAffordanceTooltip
      isOpen={iconTooltip.tooltipOpen}
      label={label}
      {...(tooltipDelay === undefined ? {} : { tooltipDelay })}
      {...(tooltipPlacement === undefined ? {} : { tooltipPlacement })}
    >
      {control}
    </IconAffordanceTooltip>
  );
}
