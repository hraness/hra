import { accessSync, constants, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "@hra-internal/schema";
import { ChatAttachmentVaultError } from "./contracts";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const rasterSchema = z.object({
  width: z.number().int().min(1).max(8192),
  height: z.number().int().min(1).max(8192),
  bytes: z.number().int().min(1).max(64 * 1024 * 1024),
  sha256: sha256Schema,
}).strict();
const nativeImageNormalizerReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  mediaType: z.enum([
    "image/png",
    "image/jpeg",
    "image/heic",
    "image/webp",
  ]),
  sourceBytes: z.number().int().min(1).max(24 * 1024 * 1024),
  canonical: rasterSchema,
  preview: rasterSchema.extend({
    bytes: z.number().int().min(1).max(512 * 1024),
  }).strict(),
}).strict().superRefine((receipt, context) => {
  if (receipt.canonical.width * receipt.canonical.height > 16_777_216) {
    context.addIssue({
      code: "custom",
      message: "canonical image pixel count exceeds the vault limit",
      path: ["canonical"],
    });
  }
  if (Math.max(receipt.preview.width, receipt.preview.height) > 320) {
    context.addIssue({
      code: "custom",
      message: "preview dimensions exceed the vault limit",
      path: ["preview"],
    });
  }
});

export type NativeImageNormalizerReceipt = z.infer<
  typeof nativeImageNormalizerReceiptSchema
>;

export interface ChatImageNormalizer {
  normalize(
    inputPath: string,
    outputDirectory: string,
  ): Promise<NativeImageNormalizerReceipt>;
}

export interface NativeImageNormalizerProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(signal: "SIGKILL"): void;
}

export type NativeImageNormalizerSpawn = (
  args: readonly string[],
) => NativeImageNormalizerProcess;

export class NativeChatImageNormalizer implements ChatImageNormalizer {
  readonly #binary: string;
  readonly #timeoutMs: number;
  readonly #spawn: NativeImageNormalizerSpawn;

  constructor(
    binary: string,
    timeoutMs = 30_000,
    spawn: NativeImageNormalizerSpawn = spawnNativeImageNormalizer,
  ) {
    if (!isAbsolute(binary)) {
      throw new Error("Image normalizer path must be absolute.");
    }
    const canonical = realpathSync(binary);
    accessSync(canonical, constants.X_OK);
    this.#binary = canonical;
    this.#timeoutMs = timeoutMs;
    this.#spawn = spawn;
  }

  async normalize(
    inputPath: string,
    outputDirectory: string,
  ): Promise<NativeImageNormalizerReceipt> {
    if (!isAbsolute(inputPath) || !isAbsolute(outputDirectory)) {
      throw new ChatAttachmentVaultError(
        "unsafe_filesystem",
        "Image normalization requires absolute vault paths.",
      );
    }
    const child = this.#spawn([
      this.#binary,
      "normalize",
      "--input",
      inputPath,
      "--output-directory",
      outputDirectory,
    ]);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, this.#timeoutMs);
    try {
      const [stdoutResult, stderrResult, exitResult] = await Promise.allSettled([
        readBoundedText(child.stdout, 4_096, () => child.kill("SIGKILL")),
        readBoundedText(child.stderr, 256, () => child.kill("SIGKILL")),
        child.exited,
      ]);
      if (timedOut) {
        throw new ChatAttachmentVaultError(
          "corrupt",
          "Image normalization exceeded its execution boundary.",
        );
      }
      if (stdoutResult.status === "rejected") throw stdoutResult.reason;
      if (stderrResult.status === "rejected") throw stderrResult.reason;
      if (exitResult.status === "rejected") {
        throw new ChatAttachmentVaultError(
          "corrupt",
          "Image normalization process could not be reaped.",
        );
      }
      const stdout = stdoutResult.value;
      const stderr = stderrResult.value;
      const exitCode = exitResult.value;
      if (exitCode !== 0) {
        if (!/^hra-image-normalizer:error:[0-9]+\n$/u.test(stderr)) {
          throw new ChatAttachmentVaultError(
            "corrupt",
            "Image normalization failed without a valid receipt.",
          );
        }
        throw new ChatAttachmentVaultError(
          "invalid_input",
          "The selected image could not be normalized safely.",
        );
      }
      if (stderr !== "" || !stdout.endsWith("\n") || stdout.length > 4_096) {
        throw new ChatAttachmentVaultError(
          "corrupt",
          "Image normalization returned an invalid receipt envelope.",
        );
      }
      try {
        return nativeImageNormalizerReceiptSchema.parse(JSON.parse(stdout));
      } catch {
        throw new ChatAttachmentVaultError(
          "corrupt",
          "Image normalization returned an invalid receipt.",
        );
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

function spawnNativeImageNormalizer(
  args: readonly string[],
): NativeImageNormalizerProcess {
  const child = Bun.spawn([...args], {
    cwd: "/",
    env: { PATH: "/usr/bin:/bin" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    exited: child.exited,
    kill: (signal) => {
      child.kill(signal);
    },
  };
}

async function readBoundedText(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  onOverflow: () => void,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximumBytes) {
        onOverflow();
        throw new ChatAttachmentVaultError(
          "corrupt",
          "Image normalization exceeded its output boundary.",
        );
      }
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error: unknown) {
    onOverflow();
    throw error;
  } finally {
    reader.releaseLock();
  }
}
