"use client";

import type { CSSProperties, Ref } from "react";
import { Link as AriaLink, type LinkProps as AriaLinkProps } from "react-aria-components";

import type { ButtonSize, ButtonVariant } from "./button";
import { classNames } from "./class-names";
import {
  type IconAffordanceLabel,
  IconAffordanceTooltip,
  type IconAffordanceTooltipOptions,
  iconAffordanceTooltipLabel,
  useIconTooltipAnchor,
} from "./icon-affordance";
import { JellySurface, type JellySurfaceTone } from "./jelly-surface";
import { useDesignKitLinkPrefetch } from "./router-provider";
import type { SurfaceShape } from "./surfaces";

type RoutedLinkProps = Omit<AriaLinkProps, "className"> & {
  readonly className: string;
  readonly linkRef?: Ref<HTMLAnchorElement> | undefined;
  readonly title?: string;
};

function RoutedLink({
  className,
  href,
  linkRef,
  onFocus,
  onHoverStart,
  ...props
}: RoutedLinkProps) {
  const prefetch = useDesignKitLinkPrefetch(href);

  return (
    <AriaLink
      {...props}
      className={className}
      {...(href === undefined ? {} : { href })}
      onFocus={(event) => {
        onFocus?.(event);
        prefetch();
      }}
      onHoverStart={(event) => {
        onHoverStart?.(event);
        prefetch();
      }}
      ref={linkRef}
    />
  );
}

export type LinkButtonProps = Omit<AriaLinkProps, "className"> & {
  readonly className?: string;
  readonly controlClassName?: string;
  readonly linkRef?: Ref<HTMLAnchorElement>;
  readonly size?: ButtonSize;
  readonly title?: string;
  readonly variant?: ButtonVariant;
};

function linkTone(variant: ButtonVariant): JellySurfaceTone {
  if (variant === "danger") return "danger";
  if (variant === "primary") return "primary";
  if (variant === "quiet") return "quiet";
  return "neutral";
}

/** A semantic anchor with the same Jelly presentation as a shared button. */
export function LinkButton({
  className,
  controlClassName,
  isDisabled = false,
  linkRef,
  size = "default",
  variant = "secondary",
  ...props
}: LinkButtonProps) {
  return (
    <JellySurface
      className={classNames("jungle-button", "jungle-link-button", className)}
      data-size={size}
      data-variant={variant}
      interaction="press"
      isDisabled={isDisabled}
      tone={linkTone(variant)}
    >
      <RoutedLink
        {...props}
        className={classNames(
          "jungle-button__control",
          "jungle-link-button__control",
          controlClassName,
        )}
        isDisabled={isDisabled}
        linkRef={linkRef}
      />
    </JellySurface>
  );
}

export type LinkCardProps = Omit<AriaLinkProps, "className"> & {
  readonly className?: string;
  readonly controlClassName?: string;
  readonly linkRef?: Ref<HTMLAnchorElement>;
  readonly shape?: SurfaceShape;
  readonly surfaceStyle?: CSSProperties;
  readonly title?: string;
  readonly tone?: JellySurfaceTone;
};

/** A whole-card semantic anchor painted by one non-focusable Jelly surface. */
export function LinkCard({
  className,
  controlClassName,
  isDisabled = false,
  linkRef,
  shape = "rounded",
  surfaceStyle,
  tone = "neutral",
  ...props
}: LinkCardProps) {
  return (
    <JellySurface
      className={classNames("jungle-link-card", className)}
      data-shape={shape}
      interaction="press"
      isDisabled={isDisabled}
      style={surfaceStyle}
      tone={tone}
    >
      <RoutedLink
        {...props}
        className={classNames("jungle-link-card__control", controlClassName)}
        isDisabled={isDisabled}
        linkRef={linkRef}
      />
    </JellySurface>
  );
}

export type IconLinkProps = Omit<
  AriaLinkProps,
  "aria-label" | "aria-labelledby" | "className" | "title"
> & IconAffordanceLabel & IconAffordanceTooltipOptions & {
  readonly className?: string;
  readonly controlClassName?: string;
  readonly linkRef?: Ref<HTMLAnchorElement>;
  readonly size?: ButtonSize;
  /** @deprecated Use `tooltip`; retained as non-native tooltip copy for compatibility. */
  readonly title?: string;
};

/** An accessible icon-only anchor with a circular Jelly hit target and required tooltip. */
export function IconLink({
  className,
  controlClassName,
  isDisabled = false,
  linkRef,
  size = "default",
  title,
  tooltip,
  tooltipDelay,
  tooltipPlacement,
  ...props
}: IconLinkProps) {
  const iconTooltip = useIconTooltipAnchor<HTMLAnchorElement>({
    enabled: true,
    ...(linkRef === undefined ? {} : { forwardedRef: linkRef }),
    ...(tooltipDelay === undefined ? {} : { delay: tooltipDelay }),
  });
  const tooltipLabel = iconAffordanceTooltipLabel({
    ...(props["aria-label"] === undefined ? {} : { "aria-label": props["aria-label"] }),
    ...(props["aria-labelledby"] === undefined
      ? {}
      : { "aria-labelledby": props["aria-labelledby"] }),
    ...(tooltip === undefined ? {} : { tooltip }),
  }, title);

  return (
    <JellySurface
      className={classNames("jungle-icon-link", className)}
      data-size={size}
      interaction="press"
      isDisabled={isDisabled}
      tone="quiet"
    >
      <IconAffordanceTooltip
        isOpen={iconTooltip.tooltipOpen}
        label={tooltipLabel}
        {...(tooltipDelay === undefined ? {} : { tooltipDelay })}
        {...(tooltipPlacement === undefined ? {} : { tooltipPlacement })}
      >
        <RoutedLink
          {...props}
          className={classNames("jungle-icon-link__control", controlClassName)}
          isDisabled={isDisabled}
          linkRef={iconTooltip.ref}
        />
      </IconAffordanceTooltip>
    </JellySurface>
  );
}
