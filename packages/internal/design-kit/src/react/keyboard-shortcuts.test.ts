import { expect, test } from "bun:test";

import {
  decideKeyboardShortcut,
  isKeyboardInteractionTarget,
  isKeyboardTextEntryTarget,
  matchesKeyboardShortcut,
  type KeyboardShortcutEvent,
} from "./keyboard-shortcuts";

function keyboardEvent(
  overrides: Partial<KeyboardShortcutEvent> = {},
): KeyboardShortcutEvent {
  return {
    altKey: false,
    ctrlKey: false,
    defaultPrevented: false,
    isComposing: false,
    key: " ",
    metaKey: false,
    repeat: false,
    shiftKey: false,
    ...overrides,
  };
}

test("shortcut matching normalizes named space, legacy names, and letter case", () => {
  expect(matchesKeyboardShortcut(keyboardEvent(), { id: "play", key: "Space" })).toBe(true);
  expect(matchesKeyboardShortcut(keyboardEvent({ key: "Esc" }), {
    id: "close",
    key: "Escape",
  })).toBe(true);
  expect(matchesKeyboardShortcut(keyboardEvent({ key: "L" }), {
    id: "loop",
    key: "l",
  })).toBe(true);
});

test("shortcut matching requires an exact modifier chord", () => {
  const event = keyboardEvent({ key: "z", metaKey: true, shiftKey: true });
  expect(matchesKeyboardShortcut(event, {
    id: "redo",
    key: "z",
    metaKey: true,
    shiftKey: true,
  })).toBe(true);
  expect(matchesKeyboardShortcut(event, {
    id: "undo",
    key: "z",
    metaKey: true,
  })).toBe(false);
});

test("decision refuses composing, prevented, disabled, repeated, and widget-owned events", () => {
  const shortcuts = [{ id: "play", key: "Space" }] as const;

  expect(decideKeyboardShortcut(shortcuts, keyboardEvent({ isComposing: true }))).toEqual({
    kind: "ignore",
    reason: "composing",
  });
  expect(decideKeyboardShortcut(shortcuts, keyboardEvent({ defaultPrevented: true }))).toEqual({
    kind: "ignore",
    reason: "default-prevented",
  });
  expect(decideKeyboardShortcut(shortcuts, keyboardEvent(), { isDisabled: true })).toEqual({
    kind: "ignore",
    reason: "disabled",
  });
  expect(decideKeyboardShortcut(shortcuts, keyboardEvent({ repeat: true }))).toEqual({
    kind: "ignore",
    reason: "repeat",
  });
  expect(decideKeyboardShortcut(shortcuts, keyboardEvent(), {
    isInteractiveTarget: true,
  })).toEqual({ kind: "ignore", reason: "interactive-target" });
});

test("a binding may deliberately opt into repeat or an interactive target", () => {
  expect(decideKeyboardShortcut(
    [{ allowRepeat: true, allowWhenInteractive: true, id: "nudge", key: "ArrowUp" }],
    keyboardEvent({ key: "ArrowUp", repeat: true }),
    { isInteractiveTarget: true },
  )).toEqual({ bindingId: "nudge", bindingIndex: 0, kind: "handle" });
});

test("an interactive binding may opt into one exact target without opening every control", () => {
  const allowedTarget = new EventTarget();
  const otherTarget = new EventTarget();
  const shortcut = [{
    allowWhenInteractiveTarget: (target: EventTarget | null) =>
      target === allowedTarget,
    id: "transport",
    key: "Space",
  }] as const;

  expect(decideKeyboardShortcut(shortcut, keyboardEvent(), {
    isInteractiveTarget: true,
    target: allowedTarget,
  })).toEqual({ bindingId: "transport", bindingIndex: 0, kind: "handle" });
  expect(decideKeyboardShortcut(shortcut, keyboardEvent(), {
    isInteractiveTarget: true,
    target: otherTarget,
  })).toEqual({ kind: "ignore", reason: "interactive-target" });
  expect(decideKeyboardShortcut(shortcut, keyboardEvent(), {
    isEditableTarget: true,
    isInteractiveTarget: true,
    target: allowedTarget,
  })).toEqual({ kind: "ignore", reason: "editable-target" });
});

test("interactive opt-in never steals typing without an editable opt-in", () => {
  const shortcut = [{ allowWhenInteractive: true, id: "add", key: "a" }] as const;
  expect(decideKeyboardShortcut(shortcut, keyboardEvent({ key: "a" }), {
    isEditableTarget: true,
    isInteractiveTarget: true,
  })).toEqual({ kind: "ignore", reason: "editable-target" });

  expect(decideKeyboardShortcut(
    [{ allowWhenEditable: true, id: "editor-command", key: "a" }],
    keyboardEvent({ key: "a" }),
    { isEditableTarget: true, isInteractiveTarget: true },
  )).toEqual({ bindingId: "editor-command", bindingIndex: 0, kind: "handle" });
});

test("the first actionable duplicate binding owns the event", () => {
  const decision = decideKeyboardShortcut([
    { id: "disabled", isDisabled: true, key: "l" },
    { id: "loop", key: "l" },
    { id: "later", key: "l" },
  ], keyboardEvent({ key: "L" }));

  expect(decision).toEqual({ bindingId: "loop", bindingIndex: 1, kind: "handle" });
});

test("interactive-target detection is guarded for foreign EventTargets", () => {
  expect(isKeyboardInteractionTarget(null)).toBe(false);
  expect(isKeyboardTextEntryTarget(null)).toBe(false);
  expect(isKeyboardInteractionTarget(new EventTarget())).toBe(false);
  expect(isKeyboardTextEntryTarget(new EventTarget())).toBe(false);

  const matchingTarget = new EventTarget();
  Object.defineProperty(matchingTarget, "closest", { value: () => ({}) });
  expect(isKeyboardInteractionTarget(matchingTarget)).toBe(true);

  const nonMatchingTarget = new EventTarget();
  Object.defineProperty(nonMatchingTarget, "closest", { value: () => null });
  expect(isKeyboardInteractionTarget(nonMatchingTarget)).toBe(false);
});
