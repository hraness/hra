export const proceduralBackdropVariants = [
  "atmosphere",
  "grid",
  "ripple",
  "composite",
] as const;

/**
 * Increment this whenever recipe generation changes intentionally. The value
 * participates in the PRNG namespace so old and new compositions cannot be
 * mistaken for the same brand artifact.
 */
export const proceduralRecipeVersion = 1 as const;

export type ProceduralBackdropVariant =
  (typeof proceduralBackdropVariants)[number];

export type ProceduralEffectPalette = Readonly<{
  highlight: string;
  key: string;
  shadow: string;
  support: string;
}>;

export type ProceduralEffectInput = Readonly<{
  palette?: ProceduralEffectPalette;
  seed: string;
  variation?: number;
}>;

export type ProceduralBackdropInput = ProceduralEffectInput & Readonly<{
  variant?: ProceduralBackdropVariant;
}>;

export type ProceduralColorRole = keyof ProceduralEffectPalette;

export type ProceduralAtmosphereLayer = Readonly<{
  blur: number;
  color: ProceduralColorRole;
  delay: number;
  driftX: number;
  driftY: number;
  duration: number;
  height: number;
  opacity: number;
  rotation: number;
  scale: number;
  width: number;
  x: number;
  y: number;
}>;

export type ProceduralGridRecipe = Readonly<{
  offsetX: number;
  offsetY: number;
  opacity: number;
  rotation: number;
  size: number;
}>;

export type ProceduralRippleContour = Readonly<{
  delay: number;
  duration: number;
  opacity: number;
  size: number;
}>;

export type ProceduralRippleRecipe = Readonly<{
  aspect: number;
  color: ProceduralColorRole;
  contours: readonly ProceduralRippleContour[];
  rotation: number;
  x: number;
  y: number;
}>;

export type ProceduralBackdropRecipe = Readonly<{
  atmosphere: readonly ProceduralAtmosphereLayer[];
  grid: ProceduralGridRecipe;
  palette: ProceduralEffectPalette;
  ripple: ProceduralRippleRecipe;
  seed: string;
  variation: number;
  variant: ProceduralBackdropVariant;
  version: typeof proceduralRecipeVersion;
}>;

export type ParticleHaloParticle = Readonly<{
  color: ProceduralColorRole;
  delay: number;
  driftX: number;
  driftY: number;
  duration: number;
  opacity: number;
  size: number;
  x: number;
  y: number;
}>;

export type ParticleHaloRecipe = Readonly<{
  palette: ProceduralEffectPalette;
  particles: readonly ParticleHaloParticle[];
  seed: string;
  variation: number;
  version: typeof proceduralRecipeVersion;
}>;

const defaultProceduralEffectPalette = {
  highlight: "var(--aurora-gold)",
  key: "var(--aurora-rose)",
  shadow: "var(--aurora-violet)",
  support: "var(--aurora-cyan)",
} as const satisfies ProceduralEffectPalette;

const colorRoles = [
  "key",
  "support",
  "highlight",
  "shadow",
] as const satisfies readonly ProceduralColorRole[];

function normalizeSeed(seed: string): string {
  const normalized = seed.trim();
  if (normalized.length === 0) {
    throw new RangeError("A procedural effect seed must contain a non-whitespace character.");
  }
  return normalized;
}

function normalizeVariation(variation: number | undefined): number {
  const normalized = variation ?? 0;
  if (!Number.isSafeInteger(normalized)) {
    throw new RangeError("A procedural effect variation must be a safe integer.");
  }
  return normalized === 0 ? 0 : normalized;
}

function normalizePalette(
  palette: ProceduralEffectPalette | undefined,
): ProceduralEffectPalette {
  const normalized = palette ?? defaultProceduralEffectPalette;
  for (const role of colorRoles) {
    if (normalized[role].trim().length === 0) {
      throw new RangeError(`A procedural effect palette requires a nonblank ${role} color.`);
    }
  }
  return {
    highlight: normalized.highlight.trim(),
    key: normalized.key.trim(),
    shadow: normalized.shadow.trim(),
    support: normalized.support.trim(),
  };
}

function seedHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function seededUnitSequence(seed: string): () => number {
  let state = seedHash(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function rounded(value: number, places = 3): number {
  const scale = 10 ** places;
  const result = Math.round(value * scale) / scale;
  return result === 0 ? 0 : result;
}

function between(
  next: () => number,
  minimum: number,
  maximum: number,
): number {
  return rounded(minimum + next() * (maximum - minimum));
}

function integerBetween(
  next: () => number,
  minimum: number,
  maximum: number,
): number {
  return Math.floor(minimum + next() * (maximum - minimum + 1));
}

function negativeIntegerBetween(
  next: () => number,
  minimum: number,
  maximum: number,
): number {
  const value = integerBetween(next, minimum, maximum);
  return value === 0 ? 0 : -value;
}

function colorRole(next: () => number): ProceduralColorRole {
  return colorRoles[integerBetween(next, 0, colorRoles.length - 1)] ?? "key";
}

function proceduralIdentity(
  input: ProceduralEffectInput,
  recipeName: "backdrop" | "halo",
) {
  const seed = normalizeSeed(input.seed);
  const variation = normalizeVariation(input.variation);
  return {
    next: seededUnitSequence(
      `jungle-procedural-v${proceduralRecipeVersion}\0${recipeName}\0${seed}\0${variation}`,
    ),
    palette: normalizePalette(input.palette),
    seed,
    variation,
  };
}

/**
 * Produces stable, bounded, JSON-serializable geometry for the decorative
 * backdrop. Rendering stays separate so this recipe can be tested without a
 * browser and emitted during server rendering.
 */
export function createProceduralBackdropRecipe(
  input: ProceduralBackdropInput,
): ProceduralBackdropRecipe {
  const { next, palette, seed, variation } = proceduralIdentity(
    input,
    "backdrop",
  );
  const variant = input.variant ?? "composite";
  if (!proceduralBackdropVariants.includes(variant)) {
    throw new RangeError(`Unsupported procedural backdrop variant: ${variant}.`);
  }

  const atmosphere = Array.from({ length: 5 }, () => ({
    blur: between(next, 24, 54),
    color: colorRole(next),
    delay: negativeIntegerBetween(next, 0, 9_000),
    driftX: between(next, -18, 18),
    driftY: between(next, -14, 14),
    duration: integerBetween(next, 10_000, 18_000),
    height: between(next, 34, 68),
    opacity: between(next, 0.16, 0.34),
    rotation: between(next, -28, 28),
    scale: between(next, 1.02, 1.12),
    width: between(next, 42, 78),
    x: between(next, 8, 92),
    y: between(next, 8, 92),
  }));

  const gridSize = integerBetween(next, 42, 72);
  const grid = {
    offsetX: integerBetween(next, 0, gridSize - 1),
    offsetY: integerBetween(next, 0, gridSize - 1),
    opacity: between(next, 0.045, 0.095),
    rotation: between(next, -2.5, 2.5),
    size: gridSize,
  };

  const ripple = {
    aspect: between(next, 0.62, 0.9),
    color: colorRole(next),
    contours: Array.from({ length: 4 }, (_, index) => ({
      delay: negativeIntegerBetween(next, 0, 7_000),
      duration: integerBetween(next, 8_000, 14_000),
      opacity: between(next, 0.08, 0.18),
      size: between(next, 28 + index * 13, 36 + index * 16),
    })),
    rotation: between(next, -18, 18),
    x: between(next, 24, 76),
    y: between(next, 22, 78),
  };

  return {
    atmosphere,
    grid,
    palette,
    ripple,
    seed,
    variation,
    variant,
    version: proceduralRecipeVersion,
  };
}

/** Produces a stable particle ring while leaving semantic content untouched. */
export function createParticleHaloRecipe(
  input: ProceduralEffectInput,
): ParticleHaloRecipe {
  const { next, palette, seed, variation } = proceduralIdentity(input, "halo");
  const particles = Array.from({ length: 24 }, (_, index) => {
    const angle = (index / 24) * Math.PI * 2 + between(next, -0.11, 0.11);
    const radiusX = between(next, 35, 49);
    const radiusY = between(next, 34, 48);
    return {
      color: colorRole(next),
      delay: negativeIntegerBetween(next, 0, 7_000),
      driftX: between(next, -7, 7),
      driftY: between(next, -7, 7),
      duration: integerBetween(next, 7_000, 13_000),
      opacity: between(next, 0.26, 0.62),
      size: between(next, 2, 6),
      x: rounded(50 + Math.cos(angle) * radiusX),
      y: rounded(50 + Math.sin(angle) * radiusY),
    };
  });

  return {
    palette,
    particles,
    seed,
    variation,
    version: proceduralRecipeVersion,
  };
}
