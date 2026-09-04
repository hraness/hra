import { describe, expect, test } from "bun:test";

import {
  downscaleImage,
  downscalePlan,
  downscaleQualitySteps,
  fitWithin,
  shouldDownscale,
  type EncodedImage,
  type ImageEncoder,
} from "./image-downscale";

const bytes = (length: number): Uint8Array => new Uint8Array(length);

/**
 * A stub encoder whose output size is a function of the request, so the ladder
 * is provable without a codec. `sizeFor` returns the byte length the encode
 * would produce, or null for a format the browser cannot write.
 */
function stubEncoder(
  sizeFor: (request: Parameters<ImageEncoder>[0]) => number | null,
): Readonly<{ calls: Parameters<ImageEncoder>[0][]; encode: ImageEncoder }> {
  const calls: Parameters<ImageEncoder>[0][] = [];
  const encode: ImageEncoder = async (request) => {
    calls.push(request);
    const size = sizeFor(request);
    if (size === null) return null;
    const result: EncodedImage = { bytes: bytes(size), mediaType: request.mediaType };
    return result;
  };
  return { calls, encode };
}

describe("fitWithin", () => {
  test("never upscales", () => {
    expect(fitWithin({ height: 400, width: 600 }, 1568)).toEqual({ height: 400, width: 600 });
  });

  test("clamps the longest edge and keeps the aspect ratio", () => {
    expect(fitWithin({ height: 2000, width: 3000 }, 1568)).toEqual({
      height: 1045,
      width: 1568,
    });
    expect(fitWithin({ height: 3000, width: 2000 }, 1568)).toEqual({
      height: 1568,
      width: 1045,
    });
  });

  test("a very thin image still keeps a pixel on the short side", () => {
    expect(fitWithin({ height: 2, width: 10_000 }, 1568)).toEqual({ height: 1, width: 1568 });
  });

  test("an exactly bounded image is left alone", () => {
    expect(fitWithin({ height: 1568, width: 900 }, 1568)).toEqual({ height: 1568, width: 900 });
  });
});

describe("shouldDownscale", () => {
  const base = {
    budgetBytes: 1000,
    longestEdge: 1568,
    mediaType: "image/png",
    size: { height: 100, width: 100 },
  };

  test("anything over the budget is downscaled", () => {
    expect(shouldDownscale({ ...base, byteLength: 1001 })).toBe(true);
  });

  test("a large image inside the budget is still fitted to the edge", () => {
    expect(shouldDownscale({
      ...base,
      byteLength: 10,
      size: { height: 4000, width: 4000 },
    })).toBe(true);
  });

  test("a small image inside the budget is left alone", () => {
    expect(shouldDownscale({ ...base, byteLength: 10 })).toBe(false);
  });

  test("a GIF inside the budget is never re-encoded, whatever its size", () => {
    expect(shouldDownscale({
      ...base,
      byteLength: 10,
      mediaType: "image/gif",
      size: { height: 4000, width: 4000 },
    })).toBe(false);
    // Over the budget it is still re-encoded: a still frame beats no send.
    expect(shouldDownscale({
      ...base,
      byteLength: 5000,
      mediaType: "image/gif",
      size: { height: 4000, width: 4000 },
    })).toBe(true);
  });
});

describe("downscalePlan", () => {
  test("walks quality down at the bound, then halves the bound", () => {
    const plan = downscalePlan({ height: 2000, width: 4000 }, 1568);
    expect(plan.length).toBe(downscaleQualitySteps.length * 2);
    expect(plan[0]).toEqual({ height: 784, quality: downscaleQualitySteps[0]!, width: 1568 });
    expect(plan[downscaleQualitySteps.length]).toEqual({
      height: 392,
      quality: downscaleQualitySteps[0]!,
      width: 784,
    });
  });

  test("an image smaller than half the bound produces one pass, not two", () => {
    const plan = downscalePlan({ height: 100, width: 100 }, 1568);
    expect(plan.length).toBe(downscaleQualitySteps.length);
    expect(plan.every((step) => step.width === 100 && step.height === 100)).toBe(true);
  });
});

describe("downscaleImage", () => {
  const size = { height: 2000, width: 3000 };

  test("leaves a small image alone and never calls the encoder", async () => {
    const encoder = stubEncoder(() => 1);
    const result = await downscaleImage({
      budgetBytes: 1000,
      encode: encoder.encode,
      longestEdge: 1568,
      mediaType: "image/png",
      size: { height: 10, width: 10 },
      source: bytes(500),
    });
    expect(encoder.calls.length).toBe(0);
    expect(result.reencoded).toBe(false);
    expect(result.overBudget).toBe(false);
    expect(result.bytes.byteLength).toBe(500);
    expect(result.mediaType).toBe("image/png");
  });

  test("keeps the smaller of the two encodes and stops at the first that fits", async () => {
    const encoder = stubEncoder((request) => (request.mediaType === "image/webp" ? 400 : 900));
    const result = await downscaleImage({
      budgetBytes: 1000,
      encode: encoder.encode,
      longestEdge: 1568,
      mediaType: "image/png",
      size,
      source: bytes(4_000_000),
    });
    expect(result.mediaType).toBe("image/webp");
    expect(result.bytes.byteLength).toBe(400);
    expect(result.reencoded).toBe(true);
    expect(result.overBudget).toBe(false);
    // One step, both formats: the ladder does not keep going once it fits.
    expect(encoder.calls.length).toBe(2);
    expect(encoder.calls[0]).toEqual({
      height: 1045,
      mediaType: "image/webp",
      quality: downscaleQualitySteps[0]!,
      width: 1568,
    });
  });

  test("falls back to JPEG when the browser cannot write WebP", async () => {
    const encoder = stubEncoder((request) => (request.mediaType === "image/webp" ? null : 900));
    const result = await downscaleImage({
      budgetBytes: 1000,
      encode: encoder.encode,
      longestEdge: 1568,
      mediaType: "image/png",
      size,
      source: bytes(4_000_000),
    });
    expect(result.mediaType).toBe("image/jpeg");
    expect(result.bytes.byteLength).toBe(900);
  });

  test("walks the whole ladder and reports the smallest when nothing fits", async () => {
    let produced = 5000;
    const encoder = stubEncoder(() => {
      produced -= 100;
      return produced;
    });
    const result = await downscaleImage({
      budgetBytes: 1000,
      encode: encoder.encode,
      longestEdge: 1568,
      mediaType: "image/png",
      size,
      source: bytes(4_000_000),
    });
    expect(encoder.calls.length).toBe(downscaleQualitySteps.length * 2 * 2);
    expect(result.overBudget).toBe(true);
    expect(result.bytes.byteLength).toBe(produced);
  });

  test("keeps the source when every re-encode comes out larger", async () => {
    const encoder = stubEncoder(() => 9_000);
    const result = await downscaleImage({
      budgetBytes: 1000,
      encode: encoder.encode,
      longestEdge: 1568,
      mediaType: "image/png",
      size,
      source: bytes(2000),
    });
    expect(result.reencoded).toBe(false);
    expect(result.mediaType).toBe("image/png");
    expect(result.bytes.byteLength).toBe(2000);
    expect(result.overBudget).toBe(true);
  });
});
