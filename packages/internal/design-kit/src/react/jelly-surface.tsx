"use client";

import {
  createElement,
  type FocusEvent as ReactFocusEvent,
  forwardRef,
  type HTMLAttributes,
  type InputEvent as ReactInputEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useRef,
} from "react";
import type { JellyElement } from "../../vendor/jelly-ui/jelly.js";

import { classNames } from "./class-names";
import { ensureJellyRuntime } from "./jelly-runtime";

export type JellySurfaceElement = JellyElement;
export type JellySurfaceInteraction = "field" | "passive" | "press";
export type JellySurfaceTone = "danger" | "field" | "neutral" | "overlay" | "primary" | "quiet";

interface JellyPointerReleaseTarget {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

interface JellyDisabledSurfaceTarget {
  matches(selector: string): boolean;
}

/** Returns whether the painted host explicitly suppresses interaction feedback. */
export function isJellySurfaceDisabled(target: JellyDisabledSurfaceTarget): boolean {
  return target.matches("[data-disabled], [data-pending]");
}

function ownsJellyInteraction(host: HTMLElement, target: EventTarget | null): boolean {
  return target instanceof Element
    && target.closest(".jungle-jelly-surface") === host;
}

/** Installs one idempotent release boundary for an active Jelly pointer press. */
export function bindJellyPointerRelease(
  target: JellyPointerReleaseTarget,
  pointerId: number,
  onRelease: () => void,
): () => void {
  let active = true;
  const dispose = (): void => {
    if (!active) return;
    active = false;
    target.removeEventListener("blur", handleBlur);
    target.removeEventListener("pointercancel", handlePointerFinish);
    target.removeEventListener("pointerup", handlePointerFinish);
  };
  const finish = (): void => {
    if (!active) return;
    dispose();
    onRelease();
  };
  const handleBlur: EventListener = () => finish();
  const handlePointerFinish: EventListener = (event) => {
    const candidate = event as Event & { readonly pointerId?: unknown };
    if (candidate.pointerId === pointerId) finish();
  };

  target.addEventListener("blur", handleBlur);
  target.addEventListener("pointercancel", handlePointerFinish);
  target.addEventListener("pointerup", handlePointerFinish);
  return dispose;
}

export type JellySurfaceProps = Omit<
  HTMLAttributes<HTMLElement>,
  "children" | "onPointerCancel" | "onPointerDown" | "onPointerMove" | "onPointerUp"
> & {
  readonly children: ReactNode;
  readonly interaction?: JellySurfaceInteraction;
  readonly isDisabled?: boolean;
  readonly isPending?: boolean;
  readonly surfaceRef?: Ref<JellySurfaceElement>;
  readonly tone?: JellySurfaceTone;
};

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") {
    ref(value);
  } else if (ref !== null && ref !== undefined) {
    ref.current = value;
  }
}

/**
 * A non-interactive Jelly card used strictly as a painted surface. The owned
 * native or React Aria descendant remains the only focusable control.
 */
export const JellySurface = forwardRef<JellySurfaceElement, JellySurfaceProps>(
  function JellySurface(
    {
      children,
      className,
      interaction = "passive",
      isDisabled = false,
      isPending = false,
      onBlurCapture,
      onFocusCapture,
      onInputCapture,
      onKeyDownCapture,
      onKeyUpCapture,
      onPointerEnter,
      onPointerLeave,
      surfaceRef,
      tone = "neutral",
      ...props
    },
    forwardedRef,
  ) {
    const hostRef = useRef<JellySurfaceElement | null>(null);
    const activePointer = useRef<number | null>(null);
    const activeReleaseListeners = useRef<(() => void) | null>(null);

    const setHost = useCallback((host: JellySurfaceElement | null) => {
      hostRef.current = host;
      assignRef(surfaceRef, host);
      assignRef(forwardedRef, host);
    }, [forwardedRef, surfaceRef]);

    const release = useCallback((): void => {
      activeReleaseListeners.current?.();
      activeReleaseListeners.current = null;
      activePointer.current = null;
      const host = hostRef.current;
      host?.removeAttribute("data-pressed");
      host?.releaseBody?.();
    }, []);

    useEffect(() => {
      void ensureJellyRuntime();
      return release;
    }, [release]);

    const handlePointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
      if (
        interaction === "passive"
        || activePointer.current !== null
        || !ownsJellyInteraction(event.currentTarget, event.target)
        || isJellySurfaceDisabled(event.currentTarget)
      ) return;
      activePointer.current = event.pointerId;
      const host = hostRef.current;
      host?.setAttribute("data-pressed", "true");
      host?.pressAt?.(event.clientX, event.clientY);
      activeReleaseListeners.current = bindJellyPointerRelease(
        globalThis,
        event.pointerId,
        release,
      );
    };

    const handlePointerMove = (event: ReactPointerEvent<HTMLElement>): void => {
      if (event.pointerId === activePointer.current) {
        hostRef.current?.moveAt?.(event.clientX, event.clientY);
      }
    };

    return createElement(
      "jelly-card",
      {
        ...props,
        className: classNames("jungle-jelly-surface", className),
        "data-disabled": isDisabled ? "true" : undefined,
        "data-pending": isPending ? "true" : undefined,
        "data-interaction": interaction,
        "data-tone": tone,
        onBlurCapture: (event: ReactFocusEvent<HTMLElement>) => {
          onBlurCapture?.(event);
          if (!event.currentTarget.contains(event.relatedTarget)) {
            event.currentTarget.removeAttribute("data-focus-within");
            release();
          }
        },
        onFocusCapture: (event: ReactFocusEvent<HTMLElement>) => {
          onFocusCapture?.(event);
          event.currentTarget.setAttribute("data-focus-within", "true");
          if (
            ownsJellyInteraction(event.currentTarget, event.target)
            && !isJellySurfaceDisabled(event.currentTarget)
          ) {
            hostRef.current?.centerPop?.(interaction === "field" ? 0.55 : 0.35);
          }
        },
        onInputCapture: (event: ReactInputEvent<HTMLElement>) => {
          onInputCapture?.(event);
          if (
            interaction === "field"
            && ownsJellyInteraction(event.currentTarget, event.target)
            && !isJellySurfaceDisabled(event.currentTarget)
          ) {
            hostRef.current?.centerPop?.(0.16);
          }
        },
        onKeyDownCapture: (event: ReactKeyboardEvent<HTMLElement>) => {
          onKeyDownCapture?.(event);
          if (
            interaction === "press"
            && !event.defaultPrevented
            && !event.repeat
            && ownsJellyInteraction(event.currentTarget, event.target)
            && !isJellySurfaceDisabled(event.currentTarget)
            && (event.key === "Enter" || event.key === " ")
          ) {
            event.currentTarget.setAttribute("data-pressed", "true");
            hostRef.current?.centerPulse?.(1.12);
          }
        },
        onKeyUpCapture: (event: ReactKeyboardEvent<HTMLElement>) => {
          onKeyUpCapture?.(event);
          if (interaction === "press" && (event.key === "Enter" || event.key === " ")) release();
        },
        onPointerDownCapture: handlePointerDown,
        onPointerEnter: (event: ReactPointerEvent<HTMLElement>) => {
          onPointerEnter?.(event);
          if (
            !ownsJellyInteraction(event.currentTarget, event.target)
            || isJellySurfaceDisabled(event.currentTarget)
          ) return;
          event.currentTarget.setAttribute("data-hovered", "true");
          if (interaction !== "passive") hostRef.current?.centerPop?.(0.18);
        },
        onPointerLeave: (event: ReactPointerEvent<HTMLElement>) => {
          onPointerLeave?.(event);
          event.currentTarget.removeAttribute("data-hovered");
        },
        onPointerMoveCapture: handlePointerMove,
        ref: setHost,
      },
      children,
    );
  },
);
