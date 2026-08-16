"use client";

import {
  type ReactElement,
  type Ref,
  type RefCallback,
  useCallback,
  useRef,
  useState,
} from "react";

import {
  DEFAULT_TOOLTIP_CLOSE_DELAY,
  DEFAULT_TOOLTIP_DELAY,
  Tooltip,
  type TooltipProps,
} from "./tooltip";

export type IconTooltipContent = ReactElement | string;

/**
 * An icon affordance always owns both an accessible name and visible tooltip
 * copy. A literal accessible name can supply both; an external labelled-by
 * relationship must provide its tooltip copy explicitly.
 */
export type IconAffordanceLabel =
  | {
    readonly "aria-label": string;
    readonly "aria-labelledby"?: never;
    readonly tooltip?: IconTooltipContent;
  }
  | {
    readonly "aria-label"?: never;
    readonly "aria-labelledby": string;
    readonly tooltip: IconTooltipContent;
  };

export type IconAffordanceTooltipOptions = Readonly<{
  readonly tooltipDelay?: number;
  readonly tooltipPlacement?: TooltipProps["placement"];
}>;

interface RuntimeIconAffordanceLabel {
  readonly "aria-label"?: string;
  readonly "aria-labelledby"?: string;
  readonly tooltip?: IconTooltipContent;
}

function requireNonBlank(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new Error(`Icon affordance ${field} must not be blank.`);
  }
  return value;
}

/** Resolves the one visible label shared by pointer and keyboard discovery. */
export function iconAffordanceTooltipLabel(
  label: RuntimeIconAffordanceLabel,
  compatibilityTitle?: string,
): IconTooltipContent {
  if (typeof label["aria-label"] === "string") {
    requireNonBlank(label["aria-label"], "aria-label");
  } else {
    const labelledBy = label["aria-labelledby"];
    if (labelledBy === undefined) {
      throw new Error("Icon affordances require aria-label or aria-labelledby.");
    }
    requireNonBlank(labelledBy, "aria-labelledby");
  }

  if (typeof label.tooltip === "string") {
    return requireNonBlank(label.tooltip, "tooltip");
  }
  if (label.tooltip !== undefined) return label.tooltip;
  if (compatibilityTitle !== undefined) return requireNonBlank(compatibilityTitle, "title");
  if (label["aria-label"] !== undefined) return label["aria-label"];

  // `IconAffordanceLabel` makes this state impossible at compile time. Keep the
  // runtime boundary total for untyped JavaScript and foreign spread values.
  throw new Error("Icon affordances labelled by another element require tooltip copy.");
}

interface IconAffordanceTooltipProps extends IconAffordanceTooltipOptions {
  readonly children: ReactElement;
  readonly isOpen?: boolean;
  readonly label: IconTooltipContent;
}

/** Adds the required tooltip as an intrinsic part of every icon affordance. */
export function IconAffordanceTooltip({
  children,
  isOpen,
  label,
  tooltipDelay,
  tooltipPlacement,
}: IconAffordanceTooltipProps) {
  return (
    <Tooltip
      label={label}
      {...(isOpen === undefined ? {} : { isOpen })}
      {...(tooltipDelay === undefined ? {} : { delay: tooltipDelay })}
      {...(tooltipPlacement === undefined ? {} : { placement: tooltipPlacement })}
    >
      {children}
    </Tooltip>
  );
}

interface IconTooltipAnchorOptions<T extends HTMLElement> {
  readonly closeDelay?: number;
  readonly delay?: number;
  readonly enabled: boolean;
  readonly forwardedRef?: Ref<T>;
}

interface IconTooltipAnchor<T extends HTMLElement> {
  readonly ref: RefCallback<T>;
  readonly tooltipOpen: boolean;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") ref(value);
  else if (ref !== null && ref !== undefined) ref.current = value;
}

/** Keeps pointer-transparent tooltip hit testing inclusive at every visual edge. */
export function pointIsInsideRectangle(
  point: Readonly<{ x: number; y: number }>,
  rectangle: Readonly<{ bottom: number; left: number; right: number; top: number }>,
): boolean {
  return point.x >= rectangle.left
    && point.x <= rectangle.right
    && point.y >= rectangle.top
    && point.y <= rectangle.bottom;
}

/**
 * Owns discovery on the semantic DOM control. Native focus listeners avoid
 * nested composite-toolbar context races, while pointer listeners keep inert
 * controls hover-discoverable. The hook owns document-level dismissal and
 * tooltip-hover continuity because nested React Aria composite contexts can
 * suppress the trigger callbacks; React Aria still owns positioning and the
 * accessible trigger/tooltip relationship.
 */
export function useIconTooltipAnchor<T extends HTMLElement>({
  closeDelay = DEFAULT_TOOLTIP_CLOSE_DELAY,
  delay = DEFAULT_TOOLTIP_DELAY,
  enabled,
  forwardedRef,
}: IconTooltipAnchorOptions<T>): IconTooltipAnchor<T> {
  const cleanupRef = useRef<() => void>(() => undefined);
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const updateOpen = useCallback((isOpen: boolean): void => {
    if (openRef.current === isOpen) return;
    openRef.current = isOpen;
    setOpen(isOpen);
  }, []);
  const setElement = useCallback((element: T | null): void => {
    cleanupRef.current();
    cleanupRef.current = () => undefined;
    assignRef(forwardedRef, element);
    if (element === null) return;
    updateOpen(false);
    if (!enabled) return;

    let focusFrame: number | undefined;
    let pointerDownAt = Number.NEGATIVE_INFINITY;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let openTimer: ReturnType<typeof setTimeout> | undefined;
    let pointerInsideOwnedTooltip = false;
    const clearTimers = (): void => {
      if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
      if (closeTimer !== undefined) clearTimeout(closeTimer);
      if (openTimer !== undefined) clearTimeout(openTimer);
      focusFrame = undefined;
      closeTimer = undefined;
      openTimer = undefined;
    };
    const handlePointerEnter = (event: PointerEvent): void => {
      if (event.pointerType === "touch") return;
      clearTimers();
      openTimer = setTimeout(() => setElementOpen(true), delay);
    };
    const ownedTooltip = (): HTMLElement | null => {
      const describedBy = element.getAttribute("aria-describedby")?.split(/\s+/) ?? [];
      for (const id of describedBy) {
        const describedElement = document.getElementById(id);
        if (describedElement?.classList.contains("jungle-tooltip") === true) {
          return describedElement;
        }
      }
      return null;
    };
    const updatePointerInsideOwnedTooltip = (event: PointerEvent): void => {
      const tooltip = ownedTooltip();
      pointerInsideOwnedTooltip = tooltip !== null && pointIsInsideRectangle(
        { x: event.clientX, y: event.clientY },
        tooltip.getBoundingClientRect(),
      );
    };
    const clearPointerClose = (): void => {
      if (closeTimer !== undefined) clearTimeout(closeTimer);
      closeTimer = undefined;
    };
    const schedulePointerClose = (): void => {
      if (closeTimer !== undefined) return;
      closeTimer = setTimeout(() => {
        closeTimer = undefined;
        if (!element.matches(":hover") && !pointerInsideOwnedTooltip) {
          setElementOpen(false);
        }
      }, closeDelay);
    };
    const handlePointerLeave = (): void => {
      if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
      if (openTimer !== undefined) clearTimeout(openTimer);
      focusFrame = undefined;
      openTimer = undefined;
      schedulePointerClose();
    };
    const handleFocus = (): void => {
      clearTimers();
      focusFrame = requestAnimationFrame(() => {
        focusFrame = undefined;
        if (
          document.activeElement === element
          && performance.now() - pointerDownAt > 250
        ) setElementOpen(true);
      });
    };
    const handleImmediateClose = (): void => {
      clearTimers();
      setElementOpen(false);
    };
    const handlePointerDown = (): void => {
      pointerDownAt = performance.now();
      handleImmediateClose();
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Enter" || event.key === " ") handleImmediateClose();
    };
    const handleDocumentKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") handleImmediateClose();
    };
    const handleDocumentPointerOver = (event: PointerEvent): void => {
      if (!openRef.current || event.pointerType === "touch") return;
      updatePointerInsideOwnedTooltip(event);
      const target = event.target;
      if (
        pointerInsideOwnedTooltip
        || (target instanceof Node && element.contains(target))
      ) {
        clearPointerClose();
        return;
      }
      schedulePointerClose();
    };
    const handleDocumentPointerMove = (event: PointerEvent): void => {
      if (!openRef.current || event.pointerType === "touch") return;
      updatePointerInsideOwnedTooltip(event);
      if (pointerInsideOwnedTooltip || element.matches(":hover")) {
        clearPointerClose();
        return;
      }
      schedulePointerClose();
    };
    let listeningToDocument = false;
    const setElementOpen = (isOpen: boolean): void => {
      if (isOpen && !listeningToDocument) {
        document.addEventListener("keydown", handleDocumentKeyDown, true);
        document.addEventListener("pointermove", handleDocumentPointerMove, true);
        document.addEventListener("pointerover", handleDocumentPointerOver, true);
        listeningToDocument = true;
      } else if (!isOpen && listeningToDocument) {
        document.removeEventListener("keydown", handleDocumentKeyDown, true);
        document.removeEventListener("pointermove", handleDocumentPointerMove, true);
        document.removeEventListener("pointerover", handleDocumentPointerOver, true);
        listeningToDocument = false;
      }
      if (!isOpen) pointerInsideOwnedTooltip = false;
      updateOpen(isOpen);
    };

    element.addEventListener("blur", handleImmediateClose);
    element.addEventListener("focus", handleFocus);
    element.addEventListener("keydown", handleKeyDown);
    element.addEventListener("pointerdown", handlePointerDown);
    element.addEventListener("pointerenter", handlePointerEnter);
    element.addEventListener("pointerleave", handlePointerLeave);
    cleanupRef.current = () => {
      clearTimers();
      pointerInsideOwnedTooltip = false;
      if (listeningToDocument) {
        document.removeEventListener("keydown", handleDocumentKeyDown, true);
        document.removeEventListener("pointermove", handleDocumentPointerMove, true);
        document.removeEventListener("pointerover", handleDocumentPointerOver, true);
      }
      element.removeEventListener("blur", handleImmediateClose);
      element.removeEventListener("focus", handleFocus);
      element.removeEventListener("keydown", handleKeyDown);
      element.removeEventListener("pointerdown", handlePointerDown);
      element.removeEventListener("pointerenter", handlePointerEnter);
      element.removeEventListener("pointerleave", handlePointerLeave);
    };
  }, [closeDelay, delay, enabled, forwardedRef, updateOpen]);

  return { ref: setElement, tooltipOpen: enabled && open };
}
