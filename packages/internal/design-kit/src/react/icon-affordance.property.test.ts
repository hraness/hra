import { expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";

import {
  iconAffordanceTooltipLabel,
  pointIsInsideRectangle,
} from "./icon-affordance";

const nonBlankText = fc.string({ minLength: 1, maxLength: 120 })
  .filter((value) => value.trim().length > 0);

test("property: every non-blank literal accessible name round trips to tooltip copy", () => {
  assertProperty(fc.property(nonBlankText, (label) => {
    expect(iconAffordanceTooltipLabel({ "aria-label": label })).toBe(label);
  }));
});

test("property: explicit tooltip copy always wins without replacing the accessible name", () => {
  assertProperty(fc.property(nonBlankText, nonBlankText, (accessibleName, tooltip) => {
    expect(iconAffordanceTooltipLabel({
      "aria-label": accessibleName,
      tooltip,
    })).toBe(tooltip);
  }));
});

test("property: whitespace-only accessible names and tooltip strings fail closed", () => {
  assertProperty(fc.property(
    fc.array(fc.constantFrom(" ", "\t", "\n", "\r"), { minLength: 1, maxLength: 24 })
      .map((characters) => characters.join("")),
    (whitespace) => {
      expect(() => iconAffordanceTooltipLabel({ "aria-label": whitespace })).toThrow();
      expect(() => iconAffordanceTooltipLabel({
        "aria-labelledby": "external-label",
        tooltip: whitespace,
      })).toThrow();
    },
  ));
});

test("property: rectangle edges are inside and points beyond any edge are outside", () => {
  assertProperty(fc.property(
    fc.integer({ min: -10_000, max: 10_000 }),
    fc.integer({ min: -10_000, max: 10_000 }),
    fc.integer({ min: 0, max: 1_000 }),
    fc.integer({ min: 0, max: 1_000 }),
    (left, top, width, height) => {
      const right = left + width;
      const bottom = top + height;
      const rectangle = { bottom, left, right, top };

      expect(pointIsInsideRectangle({ x: left, y: top }, rectangle)).toBe(true);
      expect(pointIsInsideRectangle({ x: right, y: bottom }, rectangle)).toBe(true);
      expect(pointIsInsideRectangle({ x: left - 1, y: top }, rectangle)).toBe(false);
      expect(pointIsInsideRectangle({ x: right + 1, y: bottom }, rectangle)).toBe(false);
      expect(pointIsInsideRectangle({ x: left, y: top - 1 }, rectangle)).toBe(false);
      expect(pointIsInsideRectangle({ x: right, y: bottom + 1 }, rectangle)).toBe(false);
    },
  ));
});
