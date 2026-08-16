"use client";

import { type AriaAttributes, type ReactNode, type Ref } from "react";
import {
  Button as AriaButton,
  type ButtonProps as AriaButtonProps,
  type ButtonRenderProps,
  ToggleButton as AriaToggleButton,
  type ToggleButtonProps as AriaToggleButtonProps,
} from "react-aria-components";

import { classNames } from "./class-names";
import { Spinner } from "./feedback";
import { type HapticFeedback, useHapticFeedback } from "./haptics";
import {
  type IconAffordanceLabel,
  IconAffordanceTooltip,
  type IconAffordanceTooltipOptions,
  iconAffordanceTooltipLabel,
  useIconTooltipAnchor,
} from "./icon-affordance";
import { JellySurface, type JellySurfaceTone } from "./jelly-surface";

export type ButtonVariant = "danger" | "primary" | "quiet" | "secondary";
export type ButtonSize = "compact" | "default" | "large";
export type ControlLabelStyle = "glyph" | "text";
export type SurfaceMotion = "animated" | "static";

interface ButtonHapticDispatchOptions {
  readonly feedback: HapticFeedback | undefined;
  readonly isDisabled: boolean;
  readonly isPending: boolean;
  readonly trigger: (feedback: HapticFeedback) => Promise<boolean>;
}

/** Keeps optional feedback behind the same disabled/pending gate as the semantic press. */
export function dispatchButtonHaptic({
  feedback,
  isDisabled,
  isPending,
  trigger,
}: ButtonHapticDispatchOptions): boolean {
  if (feedback === undefined || isDisabled || isPending) return false;
  void trigger(feedback);
  return true;
}

interface BusyAriaProps {
  readonly "aria-busy"?: AriaAttributes["aria-busy"];
}

export type ButtonProps = Omit<AriaButtonProps, "className"> & BusyAriaProps & {
  readonly buttonRef?: Ref<HTMLButtonElement>;
  readonly className?: string;
  readonly controlClassName?: string;
  readonly hapticFeedback?: HapticFeedback;
  /**
   * Optional stable leading glyph. When an `isPending` prop is present, this
   * slot is reserved in every state and only its contents change to a spinner.
   */
  readonly leading?: ReactNode;
  /**
   * Single-character commands use icon-scale typography. Literal one-character
   * children opt in automatically; use this prop for render-function content.
   */
  readonly labelStyle?: ControlLabelStyle;
  readonly size?: ButtonSize;
  readonly variant?: ButtonVariant;
};

/** Keeps literal single-character commands visually equivalent to 20 px icons. */
export function resolveControlLabelStyle(
  children: unknown,
  requested: ControlLabelStyle | undefined,
): ControlLabelStyle {
  if (requested !== undefined) return requested;
  if (
    (typeof children === "string" || typeof children === "number")
    && [...String(children).trim()].length === 1
  ) return "glyph";
  return "text";
}

function surfaceTone(variant: ButtonVariant): JellySurfaceTone {
  switch (variant) {
    case "danger":
      return "danger";
    case "primary":
      return "primary";
    case "quiet":
      return "quiet";
    case "secondary":
      return "neutral";
  }
}

function resolveButtonChildren(
  children: AriaButtonProps["children"],
  renderProps: ButtonRenderProps & { readonly defaultChildren: ReactNode | undefined },
): ReactNode {
  return typeof children === "function" ? children(renderProps) : children;
}

export function Button(allProps: ButtonProps) {
  const reservesPendingSlot = Object.prototype.hasOwnProperty.call(allProps, "isPending");
  const {
    "aria-busy": ariaBusy,
    buttonRef,
    children,
    className,
    controlClassName,
    hapticFeedback,
    isDisabled = false,
    isPending = false,
    labelStyle,
    leading,
    onPress,
    size = "default",
    variant = "secondary",
    ...props
  } = allProps;
  const triggerHaptic = useHapticFeedback(hapticFeedback !== undefined);
  const isBusy = isPending || ariaBusy === true || ariaBusy === "true";
  // React Aria's pending state already suppresses presses while preserving
  // focus. Avoid forwarding a simultaneous native disabled state, which would
  // eject the active control from keyboard navigation mid-operation.
  const isNativelyDisabled = isDisabled && !isPending;
  const hasIdleLeading = leading !== undefined && leading !== null && leading !== false;
  const hasLeadingSlot = hasIdleLeading || reservesPendingSlot;
  const hasEmptyPendingSlot = reservesPendingSlot && !isPending && !hasIdleLeading;
  const resolvedLabelStyle = resolveControlLabelStyle(children, labelStyle);
  const isGlyphOnly = resolvedLabelStyle === "glyph" && !hasLeadingSlot;

  return (
    <JellySurface
      aria-busy={isBusy ? "true" : undefined}
      className={classNames("jungle-button", className)}
      data-glyph-only={isGlyphOnly ? "true" : undefined}
      data-label-style={resolvedLabelStyle}
      data-size={size}
      data-variant={variant}
      interaction="press"
      isDisabled={isNativelyDisabled}
      isPending={isPending}
      tone={surfaceTone(variant)}
    >
      <AriaButton
        {...props}
        aria-busy={isBusy ? "true" : undefined}
        className={classNames("jungle-button__control", controlClassName)}
        data-pending-leading-empty={hasEmptyPendingSlot ? "true" : undefined}
        isDisabled={isNativelyDisabled}
        isPending={isPending}
        onPress={(event) => {
          dispatchButtonHaptic({
            feedback: hapticFeedback,
            isDisabled,
            isPending,
            trigger: triggerHaptic,
          });
          onPress?.(event);
        }}
        ref={buttonRef}
      >
        {(renderProps) => {
          const content = resolveButtonChildren(children, renderProps);
          if (!hasLeadingSlot) return content;
          return (
            <>
              <span aria-hidden="true" className="jungle-button__leading">
                {isPending ? <Spinner className="jungle-button__spinner" /> : leading}
              </span>
              <span className="jungle-button__label">{content}</span>
            </>
          );
        }}
      </AriaButton>
    </JellySurface>
  );
}

export type IconButtonProps = Omit<
  AriaButtonProps,
  "aria-label" | "aria-labelledby" | "className" | "title"
> & IconAffordanceLabel & IconAffordanceTooltipOptions & BusyAriaProps & {
  readonly buttonRef?: Ref<HTMLButtonElement>;
  readonly className?: string;
  readonly controlClassName?: string;
  readonly hapticFeedback?: HapticFeedback;
  readonly size?: ButtonSize;
  /**
   * Dense repeated toolbars can retain the complete semantic control while
   * omitting the continuously animated membrane surface.
   */
} & (
  | {
      readonly surfaceMotion?: "animated";
      readonly variant?: ButtonVariant;
    }
  | {
      readonly surfaceMotion: "static";
      readonly variant?: "quiet";
    }
);

export function IconButton({
  "aria-busy": ariaBusy,
  buttonRef,
  children,
  className,
  controlClassName,
  hapticFeedback,
  isDisabled = false,
  isPending = false,
  onPress,
  size = "default",
  surfaceMotion = "animated",
  tooltip,
  tooltipDelay,
  tooltipPlacement,
  variant = "quiet",
  ...props
}: IconButtonProps) {
  const triggerHaptic = useHapticFeedback(hapticFeedback !== undefined);
  const isBusy = isPending || ariaBusy === true || ariaBusy === "true";
  const isNativelyDisabled = isDisabled && !isPending;
  const iconTooltip = useIconTooltipAnchor<HTMLButtonElement>({
    enabled: true,
    ...(buttonRef === undefined ? {} : { forwardedRef: buttonRef }),
    ...(tooltipDelay === undefined ? {} : { delay: tooltipDelay }),
  });
  const tooltipLabel = iconAffordanceTooltipLabel({
    ...(props["aria-label"] === undefined ? {} : { "aria-label": props["aria-label"] }),
    ...(props["aria-labelledby"] === undefined
      ? {}
      : { "aria-labelledby": props["aria-labelledby"] }),
    ...(tooltip === undefined ? {} : { tooltip }),
  });

  const control = (
    <AriaButton
      {...props}
      aria-busy={isBusy ? "true" : undefined}
      className={surfaceMotion === "static"
        ? classNames(
            "jungle-icon-button",
            "jungle-icon-button--static",
            className,
            controlClassName,
          )
        : classNames("jungle-icon-button__control", controlClassName)}
      data-size={surfaceMotion === "static" ? size : undefined}
      data-surface-motion={surfaceMotion === "static" ? "static" : undefined}
      data-variant={surfaceMotion === "static" ? variant : undefined}
      isDisabled={isNativelyDisabled}
      isPending={isPending}
      onPress={(event) => {
        dispatchButtonHaptic({
          feedback: hapticFeedback,
          isDisabled,
          isPending,
          trigger: triggerHaptic,
        });
        onPress?.(event);
      }}
      ref={iconTooltip.ref}
    >
      {(renderProps) => isPending
        ? <Spinner className="jungle-icon-button__spinner" size="small" />
        : resolveButtonChildren(children, renderProps)}
    </AriaButton>
  );

  if (surfaceMotion === "static") {
    return (
      <IconAffordanceTooltip
        isOpen={iconTooltip.tooltipOpen}
        label={tooltipLabel}
        {...(tooltipDelay === undefined ? {} : { tooltipDelay })}
        {...(tooltipPlacement === undefined ? {} : { tooltipPlacement })}
      >
        {control}
      </IconAffordanceTooltip>
    );
  }

  return (
    <JellySurface
      aria-busy={isBusy ? "true" : undefined}
      className={classNames("jungle-icon-button", className)}
      data-size={size}
      data-variant={variant}
      interaction="press"
      isDisabled={isNativelyDisabled}
      isPending={isPending}
      tone={surfaceTone(variant)}
    >
      <IconAffordanceTooltip
        isOpen={iconTooltip.tooltipOpen}
        label={tooltipLabel}
        {...(tooltipDelay === undefined ? {} : { tooltipDelay })}
        {...(tooltipPlacement === undefined ? {} : { tooltipPlacement })}
      >
        {control}
      </IconAffordanceTooltip>
    </JellySurface>
  );
}

export type ToggleButtonProps = Omit<AriaToggleButtonProps, "className"> & {
  readonly buttonRef?: Ref<HTMLButtonElement>;
  readonly className?: string;
  readonly controlClassName?: string;
  readonly hapticFeedback?: HapticFeedback;
  /** Gives a labelled icon-only toggle congruent square host and control geometry. */
  readonly isIconOnly?: boolean;
  readonly labelStyle?: ControlLabelStyle;
  readonly size?: ButtonSize;
  readonly variant?: ButtonVariant;
};

export function ToggleButton({
  buttonRef,
  children,
  className,
  controlClassName,
  hapticFeedback,
  isDisabled = false,
  isIconOnly = false,
  labelStyle,
  onPress,
  size = "default",
  variant = "secondary",
  ...props
}: ToggleButtonProps) {
  const triggerHaptic = useHapticFeedback(hapticFeedback !== undefined);
  const resolvedLabelStyle = resolveControlLabelStyle(children, labelStyle);
  const isGlyphOnly = resolvedLabelStyle === "glyph" && !isIconOnly;

  return (
    <JellySurface
      className={classNames("jungle-button", "jungle-toggle-button", className)}
      data-glyph-only={isGlyphOnly ? "true" : undefined}
      data-icon-only={isIconOnly ? "true" : undefined}
      data-label-style={resolvedLabelStyle}
      data-size={size}
      data-variant={variant}
      interaction="press"
      isDisabled={isDisabled}
      tone={surfaceTone(variant)}
    >
      <AriaToggleButton
        {...props}
        className={classNames(
          "jungle-button__control",
          "jungle-toggle-button",
          controlClassName,
        )}
        isDisabled={isDisabled}
        onPress={(event) => {
          dispatchButtonHaptic({
            feedback: hapticFeedback,
            isDisabled,
            isPending: false,
            trigger: triggerHaptic,
          });
          onPress?.(event);
        }}
        ref={buttonRef}
      >
        {children}
      </AriaToggleButton>
    </JellySurface>
  );
}
