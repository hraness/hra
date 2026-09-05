/**
 * Image downscaling arithmetic.
 *
 * A pasted screenshot is routinely several megabytes and the hosted command
 * envelope is small (`cloudLimits.ciphertextCharacters` bounds one command at
 * 350k base64url characters), so an image reaches the daemon only after the
 * browser has shrunk it. Everything here is arithmetic over sizes and a plan of
 * encode attempts: the encoder itself is injected, so `bun test ./app` proves
 * the ladder without a canvas, a document, or an image decoder.
 *
 * The ladder is deliberately short and fixed. It walks the longest edge down,
 * then the quality down, and at every step it encodes both WebP and JPEG and
 * keeps whichever came out smaller. It stops at the first result inside the
 * budget and otherwise returns the smallest thing it produced, which the
 * composer then refuses with the measured size rather than sending something
 * the daemon would reject.
 */

/** The two formats a re-encode may produce. Both are in the accepted set. */
export type ReencodeMediaType = "image/jpeg" | "image/webp";

export type EncodeRequest = Readonly<{
  height: number;
  mediaType: ReencodeMediaType;
  quality: number;
  width: number;
}>;

export type EncodedImage = Readonly<{ bytes: Uint8Array; mediaType: ReencodeMediaType }>;

/**
 * Draws the source at the requested size and encodes it. Returns null when the
 * browser cannot produce that format, which is how a WebP-less browser falls
 * back to JPEG without a feature-detection branch in the caller.
 */
export type ImageEncoder = (request: EncodeRequest) => Promise<EncodedImage | null>;

export type ImageSize = Readonly<{ height: number; width: number }>;

/** Quality steps, tried in order. The first is visually lossless for text. */
export const downscaleQualitySteps: readonly number[] = Object.freeze([0.82, 0.62, 0.45]);

/**
 * Fits a size inside a longest-edge bound, preserving the aspect ratio.
 *
 * An image already inside the bound is returned unchanged: this never upscales.
 * Both sides round to at least one pixel, so a very long, very thin image still
 * produces a canvas a browser will accept.
 */
export function fitWithin(size: ImageSize, longestEdge: number): ImageSize {
  const longest = Math.max(size.height, size.width);
  if (longest <= longestEdge || longest <= 0) return { height: size.height, width: size.width };
  const scale = longestEdge / longest;
  return {
    height: Math.max(1, Math.round(size.height * scale)),
    width: Math.max(1, Math.round(size.width * scale)),
  };
}

export type DownscaleStep = Readonly<{ height: number; quality: number; width: number }>;

/**
 * The attempt ladder for one image.
 *
 * The first pass holds the long edge at the bound and walks quality down. If
 * nothing there fits, a second pass halves the long edge and repeats, which is
 * what rescues a full-height retina screenshot of a terminal. Duplicate sizes
 * are dropped, so an image that is already small produces a short ladder rather
 * than the same encode twice.
 */
export function downscalePlan(
  size: ImageSize,
  longestEdge: number,
): readonly DownscaleStep[] {
  const steps: DownscaleStep[] = [];
  const seen = new Set<string>();
  for (const edge of [longestEdge, Math.max(1, Math.round(longestEdge / 2))]) {
    const fitted = fitWithin(size, edge);
    const key = `${String(fitted.width)}x${String(fitted.height)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const quality of downscaleQualitySteps) {
      steps.push({ height: fitted.height, quality, width: fitted.width });
    }
  }
  return steps;
}

/**
 * Whether an image is worth re-encoding at all.
 *
 * Over the inline budget, always. Merely large in pixels, only when the format
 * survives the trip: an animated GIF inside the budget is left alone, because a
 * canvas re-encode would silently flatten it to its first frame.
 */
export function shouldDownscale(input: Readonly<{
  byteLength: number;
  budgetBytes: number;
  longestEdge: number;
  mediaType: string;
  size: ImageSize;
}>): boolean {
  if (input.byteLength > input.budgetBytes) return true;
  if (input.mediaType === "image/gif") return false;
  return Math.max(input.size.height, input.size.width) > input.longestEdge;
}

export type DownscaleResult = Readonly<{
  bytes: Uint8Array;
  mediaType: string;
  /** True when the returned bytes came out of the encoder rather than the file. */
  reencoded: boolean;
  /** True when the returned bytes are still over the budget. */
  overBudget: boolean;
}>;

/**
 * Runs the ladder and returns the smallest result, the source included.
 *
 * The source is always a candidate: a small PNG screenshot of flat colour beats
 * both re-encodes, and sending the file the reader actually pasted is the right
 * answer whenever it is smaller.
 */
export async function downscaleImage(input: Readonly<{
  budgetBytes: number;
  encode: ImageEncoder;
  longestEdge: number;
  mediaType: string;
  size: ImageSize;
  source: Uint8Array;
}>): Promise<DownscaleResult> {
  const overBudget = (bytes: Uint8Array): boolean => bytes.byteLength > input.budgetBytes;
  let best: DownscaleResult = {
    bytes: input.source,
    mediaType: input.mediaType,
    overBudget: overBudget(input.source),
    reencoded: false,
  };
  if (!shouldDownscale({
    budgetBytes: input.budgetBytes,
    byteLength: input.source.byteLength,
    longestEdge: input.longestEdge,
    mediaType: input.mediaType,
    size: input.size,
  })) return best;

  for (const step of downscalePlan(input.size, input.longestEdge)) {
    const produced = await Promise.all(([
      "image/webp",
      "image/jpeg",
    ] as const).map(async (mediaType) => input.encode({
      height: step.height,
      mediaType,
      quality: step.quality,
      width: step.width,
    })));
    for (const candidate of produced) {
      if (candidate === null || candidate.bytes.byteLength >= best.bytes.byteLength) continue;
      best = {
        bytes: candidate.bytes,
        mediaType: candidate.mediaType,
        overBudget: overBudget(candidate.bytes),
        reencoded: true,
      };
    }
    if (!best.overBudget) return best;
  }
  return best;
}
