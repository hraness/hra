import { expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";
import { createHash } from "node:crypto";

import {
  createParticleHaloRecipe,
  createProceduralBackdropRecipe,
  proceduralBackdropVariants,
  proceduralRecipeVersion,
  type ProceduralEffectPalette,
} from "./procedural-recipe";

const nonblankSeed = fc.string({ minLength: 1, maxLength: 64 })
  .filter((seed) => seed.trim().length > 0);
const variation = fc.integer({ min: -1_000_000, max: 1_000_000 });
const palette = {
  highlight: "#f9dca8",
  key: "#ef8f82",
  shadow: "#78667d",
  support: "#79bec5",
} as const satisfies ProceduralEffectPalette;

function expectBetween(value: number, minimum: number, maximum: number): void {
  expect(Number.isFinite(value)).toBeTrue();
  expect(value).toBeGreaterThanOrEqual(minimum);
  expect(value).toBeLessThanOrEqual(maximum);
}

test("property: backdrop recipes are deterministic, serializable, and bounded", () => {
  assertProperty(fc.property(
    nonblankSeed,
    variation,
    fc.constantFrom(...proceduralBackdropVariants),
    (seed, selectedVariation, variant) => {
      const input = {
        palette,
        seed,
        variation: selectedVariation,
        variant,
      } as const;
      const recipe = createProceduralBackdropRecipe(input);

      expect(createProceduralBackdropRecipe(input)).toEqual(recipe);
      expect(JSON.parse(JSON.stringify(recipe))).toEqual(recipe);
      expect(recipe.seed).toBe(seed.trim());
      expect(recipe.variation).toBe(selectedVariation);
      expect(recipe.variant).toBe(variant);
      expect(recipe.atmosphere).toHaveLength(5);
      for (const layer of recipe.atmosphere) {
        expect(Object.is(layer.delay, -0)).toBeFalse();
        expectBetween(layer.blur, 24, 54);
        expectBetween(layer.delay, -9_000, 0);
        expectBetween(layer.driftX, -18, 18);
        expectBetween(layer.driftY, -14, 14);
        expectBetween(layer.duration, 10_000, 18_000);
        expectBetween(layer.height, 34, 68);
        expectBetween(layer.opacity, 0.16, 0.34);
        expectBetween(layer.rotation, -28, 28);
        expectBetween(layer.scale, 1.02, 1.12);
        expectBetween(layer.width, 42, 78);
        expectBetween(layer.x, 8, 92);
        expectBetween(layer.y, 8, 92);
      }
      expectBetween(recipe.grid.size, 42, 72);
      expectBetween(recipe.grid.offsetX, 0, recipe.grid.size - 1);
      expectBetween(recipe.grid.offsetY, 0, recipe.grid.size - 1);
      expectBetween(recipe.grid.opacity, 0.045, 0.095);
      expectBetween(recipe.grid.rotation, -2.5, 2.5);
      expectBetween(recipe.ripple.aspect, 0.62, 0.9);
      expectBetween(recipe.ripple.rotation, -18, 18);
      expectBetween(recipe.ripple.x, 24, 76);
      expectBetween(recipe.ripple.y, 22, 78);
      expect(recipe.ripple.contours).toHaveLength(4);
      for (const contour of recipe.ripple.contours) {
        expect(Object.is(contour.delay, -0)).toBeFalse();
        expectBetween(contour.delay, -7_000, 0);
        expectBetween(contour.duration, 8_000, 14_000);
        expectBetween(contour.opacity, 0.08, 0.18);
        expectBetween(contour.size, 28, 84);
      }
    },
  ));
});

test("property: particle halo recipes stay deterministic and inside their field", () => {
  assertProperty(fc.property(
    nonblankSeed,
    variation,
    (seed, selectedVariation) => {
      const input = { palette, seed, variation: selectedVariation };
      const recipe = createParticleHaloRecipe(input);

      expect(createParticleHaloRecipe(input)).toEqual(recipe);
      expect(JSON.parse(JSON.stringify(recipe))).toEqual(recipe);
      expect(recipe.particles).toHaveLength(24);
      for (const particle of recipe.particles) {
        expect(Object.is(particle.delay, -0)).toBeFalse();
        expectBetween(particle.delay, -7_000, 0);
        expectBetween(particle.driftX, -7, 7);
        expectBetween(particle.driftY, -7, 7);
        expectBetween(particle.duration, 7_000, 13_000);
        expectBetween(particle.opacity, 0.26, 0.62);
        expectBetween(particle.size, 2, 6);
        expectBetween(particle.x, 1, 99);
        expectBetween(particle.y, 2, 98);
      }
    },
  ));
});

test("variation yields a stable alternate composition without changing identity colors", () => {
  const base = createProceduralBackdropRecipe({
    palette,
    seed: "example.com",
    variation: 0,
  });
  const alternate = createProceduralBackdropRecipe({
    palette,
    seed: "example.com",
    variation: 1,
  });

  expect(alternate).not.toEqual(base);
  expect(alternate.palette).toEqual(base.palette);
  expect(alternate.seed).toBe(base.seed);
  expect(alternate.variation).toBe(1);
});

test("recipe version pins a known brand composition across releases", () => {
  const artifact = {
    backdrop: createProceduralBackdropRecipe({
      palette,
      seed: "example.com",
      variation: 3,
      variant: "composite",
    }),
    halo: createParticleHaloRecipe({
      palette,
      seed: "example.com",
      variation: 1,
    }),
  };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(artifact))
    .digest("hex");

  expect(proceduralRecipeVersion).toBe(1);
  expect(artifact.backdrop.version).toBe(proceduralRecipeVersion);
  expect(artifact.halo.version).toBe(proceduralRecipeVersion);
  expect(fingerprint).toBe(
    "cc197bb649737a8605f7ee412783d6210501373659e4ecdcdb9feb411d0506e8",
  );
});

test("regression: a previously reported atmosphere recipe remains inside every bound", () => {
  const recipe = createProceduralBackdropRecipe({
    palette,
    seed: "FOs|NHVOwd;x",
    variation: 54_751,
    variant: "atmosphere",
  });

  for (const layer of recipe.atmosphere) {
    expectBetween(layer.blur, 24, 54);
    expectBetween(layer.delay, -9_000, 0);
    expectBetween(layer.driftX, -18, 18);
    expectBetween(layer.driftY, -14, 14);
    expectBetween(layer.duration, 10_000, 18_000);
    expectBetween(layer.height, 34, 68);
    expectBetween(layer.opacity, 0.16, 0.34);
    expectBetween(layer.rotation, -28, 28);
    expectBetween(layer.scale, 1.02, 1.12);
    expectBetween(layer.width, 42, 78);
    expectBetween(layer.x, 8, 92);
    expectBetween(layer.y, 8, 92);
  }
});

test("recipes reject ambiguous identity inputs and never use ambient randomness", async () => {
  expect(() => createProceduralBackdropRecipe({ seed: " \n " })).toThrow(
    "must contain a non-whitespace character",
  );
  expect(() => createParticleHaloRecipe({ seed: "brand", variation: 1.5 }))
    .toThrow("must be a safe integer");
  expect(() => createProceduralBackdropRecipe({
    palette: { ...palette, key: " " },
    seed: "brand",
  })).toThrow("requires a nonblank key color");
  const canonicalZero = createParticleHaloRecipe({
    seed: "brand",
    variation: -0,
  });
  expect(Object.is(canonicalZero.variation, -0)).toBeFalse();
  expect(JSON.parse(JSON.stringify(canonicalZero))).toEqual(canonicalZero);

  const source = await Bun.file(
    new URL("./procedural-recipe.ts", import.meta.url),
  ).text();
  expect(source).not.toContain("Math.random");
});
