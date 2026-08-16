import { expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";

import {
  decideKeyboardShortcut,
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
    key: "k",
    metaKey: false,
    repeat: false,
    shiftKey: false,
    ...overrides,
  };
}

const modifiers = fc.record({
  altKey: fc.boolean(),
  ctrlKey: fc.boolean(),
  metaKey: fc.boolean(),
  shiftKey: fc.boolean(),
});

test("property: an exact modifier chord matches and any flipped modifier does not", () => {
  assertProperty(fc.property(
    modifiers,
    fc.constantFrom("altKey", "ctrlKey", "metaKey", "shiftKey"),
    (chord, flippedKey) => {
      const shortcut = { id: "command", key: "k", ...chord };
      expect(matchesKeyboardShortcut(keyboardEvent(chord), shortcut)).toBe(true);
      expect(matchesKeyboardShortcut(
        keyboardEvent({ ...chord, [flippedKey]: !chord[flippedKey] }),
        shortcut,
      )).toBe(false);
    },
  ));
});

test("property: decisions return only the first actionable owned binding", () => {
  assertProperty(fc.property(
    fc.uniqueArray(fc.string({ minLength: 1, maxLength: 24 }), {
      minLength: 1,
      maxLength: 24,
    }),
    fc.nat(),
    (ids, offset) => {
      const selectedIndex = offset % ids.length;
      const shortcuts = ids.map((id, index) => ({
        id,
        isDisabled: index !== selectedIndex,
        key: "k",
      }));
      const selectedId = ids[selectedIndex];
      if (selectedId === undefined) throw new Error("A non-empty shortcut set lost its selected id.");

      expect(decideKeyboardShortcut(shortcuts, keyboardEvent())).toEqual({
        bindingId: selectedId,
        bindingIndex: selectedIndex,
        kind: "handle",
      });
    },
  ));
});

test("property: foreign keys never resolve to an owned binding", () => {
  assertProperty(fc.property(
    fc.array(fc.constantFrom("a", "b", "Space", "Escape", "ArrowLeft"), {
      maxLength: 24,
    }),
    keys => {
      const shortcuts = keys.map((key, index) => ({ id: `command-${index}`, key }));
      expect(decideKeyboardShortcut(shortcuts, keyboardEvent({ key: "Unidentified" }))).toEqual({
        kind: "ignore",
        reason: "no-match",
      });
    },
  ));
});

test("property: repeat and interactive suppression may only be bypassed explicitly", () => {
  assertProperty(fc.property(fc.boolean(), fc.boolean(), (allowRepeat, allowWhenInteractive) => {
    const decision = decideKeyboardShortcut(
      [{ allowRepeat, allowWhenInteractive, id: "command", key: "k" }],
      keyboardEvent({ repeat: true }),
      { isInteractiveTarget: true },
    );
    expect(decision.kind === "handle").toBe(allowRepeat && allowWhenInteractive);
  }));
});

test("property: a target predicate grants only the target it accepts", () => {
  assertProperty(fc.property(fc.boolean(), allowsTarget => {
    const target = new EventTarget();
    const decision = decideKeyboardShortcut(
      [{
        allowWhenInteractiveTarget: candidate =>
          candidate === target && allowsTarget,
        id: "command",
        key: "k",
      }],
      keyboardEvent(),
      { isInteractiveTarget: true, target },
    );
    expect(decision.kind === "handle").toBe(allowsTarget);
  }));
});

test("property: editable targets require their own explicit opt-in", () => {
  assertProperty(fc.property(
    fc.boolean(),
    fc.boolean(),
    (allowWhenEditable, allowWhenInteractive) => {
      const decision = decideKeyboardShortcut(
        [{ allowWhenEditable, allowWhenInteractive, id: "command", key: "k" }],
        keyboardEvent(),
        { isEditableTarget: true, isInteractiveTarget: true },
      );
      expect(decision.kind === "handle").toBe(allowWhenEditable);
    },
  ));
});
