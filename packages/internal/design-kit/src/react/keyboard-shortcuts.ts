"use client";

import { useEffect, useRef, type RefObject } from "react";

const interactiveTargetSelector = [
  "a[href]",
  "area[href]",
  "button",
  "input",
  "select",
  "summary",
  "textarea",
  "[contenteditable]:not([contenteditable='false'])",
  "[role='button']",
  "[role='checkbox']",
  "[role='combobox']",
  "[role='gridcell']",
  "[role='link']",
  "[role='menuitem']",
  "[role='option']",
  "[role='radio']",
  "[role='slider']",
  "[role='spinbutton']",
  "[role='switch']",
  "[role='tab']",
  "[role='textbox']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const textEntryTargetSelector = [
  "input:not([type='button']):not([type='checkbox']):not([type='color']):not([type='file']):not([type='hidden']):not([type='image']):not([type='radio']):not([type='range']):not([type='reset']):not([type='submit'])",
  "select",
  "textarea",
  "[contenteditable]:not([contenteditable='false'])",
  "[role='combobox']",
  "[role='textbox']",
].join(",");

type ClosestEventTarget = EventTarget & {
  closest(selectors: string): Element | null;
};

function hasClosest(target: EventTarget | null): target is ClosestEventTarget {
  return target !== null && "closest" in target && typeof target.closest === "function";
}

export function isKeyboardInteractionTarget(target: EventTarget | null): boolean {
  return hasClosest(target) && target.closest(interactiveTargetSelector) !== null;
}

export function isKeyboardTextEntryTarget(target: EventTarget | null): boolean {
  return hasClosest(target) && target.closest(textEntryTargetSelector) !== null;
}

export type KeyboardShortcutEvent = Pick<
  KeyboardEvent,
  | "altKey"
  | "ctrlKey"
  | "defaultPrevented"
  | "isComposing"
  | "key"
  | "metaKey"
  | "repeat"
  | "shiftKey"
>;

export interface KeyboardShortcutDefinition {
  readonly allowRepeat?: boolean;
  readonly allowWhenEditable?: boolean;
  readonly allowWhenInteractive?: boolean;
  /**
   * Grants a matched shortcut to one explicitly recognized, non-editable
   * interactive target without opening the shortcut to every control.
   */
  readonly allowWhenInteractiveTarget?: (
    target: EventTarget | null,
  ) => boolean;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly id: string;
  readonly isDisabled?: boolean;
  readonly key: string;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
}

export interface KeyboardShortcutBinding extends KeyboardShortcutDefinition {
  readonly onAction: (event: KeyboardEvent) => void;
}

export type KeyboardShortcutDecision =
  | {
      readonly bindingId: string;
      readonly bindingIndex: number;
      readonly kind: "handle";
    }
  | {
      readonly kind: "ignore";
      readonly reason:
        | "composing"
        | "default-prevented"
        | "disabled"
        | "editable-target"
        | "interactive-target"
        | "no-match"
        | "repeat";
    };

export interface KeyboardShortcutContext {
  readonly isDisabled?: boolean;
  readonly isEditableTarget?: boolean;
  readonly isInteractiveTarget?: boolean;
  readonly target?: EventTarget | null;
}

function normalizedKey(key: string): string {
  switch (key) {
    case "Esc":
      return "Escape";
    case "Left":
      return "ArrowLeft";
    case "Right":
      return "ArrowRight";
    case "Up":
      return "ArrowUp";
    case "Down":
      return "ArrowDown";
    case "Space":
    case "Spacebar":
      return " ";
    default:
      return key.length === 1 ? key.toLocaleLowerCase("en-US") : key;
  }
}

export function matchesKeyboardShortcut(
  event: KeyboardShortcutEvent,
  shortcut: KeyboardShortcutDefinition,
): boolean {
  return (
    normalizedKey(event.key) === normalizedKey(shortcut.key) &&
    event.altKey === (shortcut.altKey ?? false) &&
    event.ctrlKey === (shortcut.ctrlKey ?? false) &&
    event.metaKey === (shortcut.metaKey ?? false) &&
    event.shiftKey === (shortcut.shiftKey ?? false)
  );
}

export function decideKeyboardShortcut(
  shortcuts: readonly KeyboardShortcutDefinition[],
  event: KeyboardShortcutEvent,
  context: KeyboardShortcutContext = {},
): KeyboardShortcutDecision {
  if (context.isDisabled === true) return { kind: "ignore", reason: "disabled" };
  if (event.defaultPrevented) return { kind: "ignore", reason: "default-prevented" };
  if (event.isComposing) return { kind: "ignore", reason: "composing" };

  let suppressedReason: Extract<KeyboardShortcutDecision, { readonly kind: "ignore" }>["reason"] | null = null;
  for (const [bindingIndex, shortcut] of shortcuts.entries()) {
    if (shortcut.isDisabled === true || !matchesKeyboardShortcut(event, shortcut)) continue;
    if (event.repeat && shortcut.allowRepeat !== true) {
      suppressedReason ??= "repeat";
      continue;
    }
    if (
      context.isEditableTarget === true &&
      shortcut.allowWhenEditable !== true
    ) {
      suppressedReason ??= "editable-target";
      continue;
    }
    if (
      context.isInteractiveTarget === true &&
      context.isEditableTarget !== true &&
      shortcut.allowWhenInteractive !== true &&
      shortcut.allowWhenInteractiveTarget?.(context.target ?? null) !== true
    ) {
      suppressedReason ??= "interactive-target";
      continue;
    }
    return { bindingId: shortcut.id, bindingIndex, kind: "handle" };
  }

  return { kind: "ignore", reason: suppressedReason ?? "no-match" };
}

export interface UseKeyboardShortcutsOptions {
  readonly isDisabled?: boolean;
  readonly scopeRef?: RefObject<HTMLElement | null>;
}

function isNode(target: EventTarget | null): target is Node {
  return target !== null && typeof Node !== "undefined" && target instanceof Node;
}

/** Installs guarded document shortcuts without stealing keys from focused widgets by default. */
export function useKeyboardShortcuts(
  bindings: readonly KeyboardShortcutBinding[],
  options: UseKeyboardShortcutsOptions = {},
): void {
  const latestRef = useRef({ bindings, isDisabled: options.isDisabled ?? false });
  latestRef.current = { bindings, isDisabled: options.isDisabled ?? false };
  const scopeRef = options.scopeRef;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (scopeRef !== undefined) {
        const scope = scopeRef.current;
        if (scope === null || !isNode(event.target) || !scope.contains(event.target)) return;
      }

      const current = latestRef.current;
      const decision = decideKeyboardShortcut(current.bindings, event, {
        isDisabled: current.isDisabled,
        isEditableTarget: isKeyboardTextEntryTarget(event.target),
        isInteractiveTarget: isKeyboardInteractionTarget(event.target),
        target: event.target,
      });
      if (decision.kind === "ignore") return;

      event.preventDefault();
      current.bindings[decision.bindingIndex]?.onAction(event);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [scopeRef]);
}
