/**
 * The one place the app touches a canvas.
 *
 * `model/image-downscale.ts` owns the ladder and the arithmetic and takes an
 * encoder as an argument, so this wrapper is the only code that needs a
 * document, a decoder, or a codec. It is deliberately tiny and untested by
 * `bun test ./app`: everything with a decision in it lives in the model, and a
 * browser that cannot decode the image returns null here so the file is sent as
 * it arrived rather than not at all.
 */
import type { EncodedImage, ImageEncoder, ImageSize } from "../model/image-downscale";

export type MeasuredImage = Readonly<{
  dispose?: () => void;
  encode: ImageEncoder;
  size: ImageSize;
}>;

async function toBlob(
  canvas: HTMLCanvasElement,
  mediaType: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, mediaType, quality);
  });
}

/**
 * Decodes an image and returns its pixel size with an encoder bound to it.
 *
 * Returns null when the browser has no `createImageBitmap`, no document, or
 * cannot decode these bytes. A `toBlob` that ignored the requested type (which
 * is how a browser without a WebP encoder answers) is reported as a miss rather
 * than as a PNG pretending to be a WebP, so the ladder simply keeps the JPEG.
 */
export async function measureImage(source: Blob): Promise<MeasuredImage | null> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source);
  } catch {
    return null;
  }
  if (bitmap.width <= 0 || bitmap.height <= 0) {
    bitmap.close();
    return null;
  }

  const encode: ImageEncoder = async (request): Promise<EncodedImage | null> => {
    const canvas = document.createElement("canvas");
    canvas.width = request.width;
    canvas.height = request.height;
    const context = canvas.getContext("2d");
    if (context === null) return null;
    // JPEG carries no alpha, so a transparent screenshot would composite onto
    // black. Paint the sheet first and the transparent parts come out white.
    if (request.mediaType === "image/jpeg") {
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, request.width, request.height);
    }
    context.drawImage(bitmap, 0, 0, request.width, request.height);
    const blob = await toBlob(canvas, request.mediaType, request.quality);
    if (blob === null || blob.type !== request.mediaType || blob.size === 0) return null;
    return {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      mediaType: request.mediaType,
    };
  };

  return { dispose: () => { bitmap.close(); }, encode, size: { height: bitmap.height, width: bitmap.width } };
}
