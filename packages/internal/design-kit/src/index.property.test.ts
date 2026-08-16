import { expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";

import {
  breakpoints,
  colors,
  motion,
  spacing,
  stacking,
  typeScale,
} from "./index";

test("property: the spacing scale is non-negative and strictly increasing", () => {
  assertProperty(fc.property(fc.integer({ min: 1, max: spacing.length - 1 }), (index) => {
    const previous = spacing[index - 1];
    const current = spacing[index];
    expect(previous).toBeDefined();
    expect(current).toBeDefined();
    expect(current).toBeGreaterThan(previous ?? Number.POSITIVE_INFINITY);
  }));
});

test("property: the type scale is positive and non-decreasing", () => {
  const values = Object.values(typeScale);
  assertProperty(fc.property(fc.integer({ min: 1, max: values.length - 1 }), (index) => {
    const previous = values[index - 1];
    const current = values[index];
    expect(previous).toBeDefined();
    expect(current).toBeDefined();
    expect(previous).toBeGreaterThan(0);
    expect(current).toBeGreaterThanOrEqual(previous ?? Number.POSITIVE_INFINITY);
  }));
});

test("property: light and dark themes expose the same semantic roles", () => {
  const lightRoles = Object.keys(colors.light).sort();
  const darkRoles = Object.keys(colors.dark).sort();
  expect(darkRoles).toHaveLength(lightRoles.length);
  assertProperty(fc.property(fc.integer({ min: 0, max: lightRoles.length - 1 }), (index) => {
    expect(darkRoles[index]).toBe(lightRoles[index]);
  }));
});

test("property: motion durations and responsive breakpoints are ordered", () => {
  const durations = Object.values(motion.duration);
  const widths = Object.values(breakpoints);

  assertProperty(fc.property(fc.integer({ min: 1, max: durations.length - 1 }), (index) => {
    expect(durations[index]).toBeGreaterThanOrEqual(durations[index - 1] ?? Number.POSITIVE_INFINITY);
  }));
  assertProperty(fc.property(fc.integer({ min: 1, max: widths.length - 1 }), (index) => {
    expect(widths[index]).toBeGreaterThan(widths[index - 1] ?? Number.POSITIVE_INFINITY);
  }));
});

test("property: shared interaction layers are strictly ordered", () => {
  const layers = Object.values(stacking);

  assertProperty(fc.property(
    fc.integer({ min: 1, max: layers.length - 1 }),
    (index) => {
      expect(layers[index]).toBeGreaterThan(
        layers[index - 1] ?? Number.POSITIVE_INFINITY,
      );
    },
  ));
});
