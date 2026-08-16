import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export const PHOENIX_SOURCE_PATH = "assets/brand/phoenix/emoji_u1f426_200d_1f525.svg" as const;
export const PHOENIX_LICENSE_PATH = "assets/brand/phoenix/LICENSE" as const;
export const PHOENIX_SOURCE_SHA256 =
  "823a9add5f88eb5e92582855698ab55ce5f9e96aa29523d7aac799b1ef1ca629" as const;
export const PHOENIX_LICENSE_SHA256 =
  "611ceab36dae96644ca84e8ace6873821790192bf6f73b0d0624a21b24b4b332" as const;
export const PHOENIX_UPSTREAM_COMMIT =
  "8998f5dd683424a73e2314a8c1f1e359c19e8742" as const;
export const PHOENIX_SOURCE_PATH_UPSTREAM = "svg/emoji_u1f426_200d_1f525.svg" as const;
export const PHOENIX_INSET = 0.08 as const;
export const PHOENIX_SHARP_VERSION = "0.35.3" as const;

export const PHOENIX_TARGETS = [
  { path: "apps/desktop/assets/icon.png", size: 1024 },
  { path: "apps/web/app/apple-icon.png", size: 180 },
  { path: "apps/web/app/icon.png", size: 512 },
] as const;

export const PHOENIX_OUTPUT_SHA256 = {
  "apps/desktop/assets/icon.png": "451bf4681fe1ac0b1210e0d53668d13ea47405df41f29bb8998e40fa401e8320",
  "apps/web/app/apple-icon.png": "b9d3d18a3375f026afca7a82c222ce961187e3383714a8f600a5dc9692e98520",
  "apps/web/app/icon.png": "17f58b8c253691f5302d5a742f540e04e7b8105bad1032cd1f1320a9388029e1",
} as const;

function absoluteRepositoryPath(repositoryPath: string): string {
  const absolute = resolve(repositoryRoot, repositoryPath);
  const relativePath = relative(repositoryRoot, absolute);
  if (relativePath === "" || relativePath.startsWith("..")) {
    throw new Error(`Brand asset path escapes the repository: ${repositoryPath}`);
  }
  return absolute;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function insetPixels(size: number): number {
  return Math.round(size * PHOENIX_INSET);
}

function contentSize(size: number): number {
  const inset = insetPixels(size);
  return size - inset * 2;
}

export async function renderPhoenixPng(
  source: Uint8Array,
  size: number,
): Promise<Buffer> {
  const inset = insetPixels(size);
  const inner = contentSize(size);
  const renderedSource = await sharp(source, { density: 72 })
    .resize(inner, inner, { fit: "contain" })
    .png({ adaptiveFiltering: false, compressionLevel: 9 })
    .toBuffer();

  return sharp({
    create: {
      channels: 4,
      height: size,
      width: size,
      background: { alpha: 1, b: 0, g: 0, r: 0 },
    },
  })
    .composite([{ input: renderedSource, left: inset, top: inset }])
    .flatten({ background: { b: 0, g: 0, r: 0 } })
    .removeAlpha()
    .png({ adaptiveFiltering: false, compressionLevel: 9 })
    .toBuffer();
}

async function readRequiredFile(repositoryPath: string): Promise<Uint8Array> {
  const absolutePath = absoluteRepositoryPath(repositoryPath);
  const status = await lstat(absolutePath);
  if (!status.isFile()) throw new Error(`${repositoryPath} must be a regular file.`);
  return readFile(absolutePath);
}

export async function expectedPhoenixOutputs(): Promise<ReadonlyMap<string, Buffer>> {
  if (sharp.versions.sharp !== PHOENIX_SHARP_VERSION) {
    throw new Error(
      `sharp ${sharp.versions.sharp ?? "unknown"} is installed; expected ${PHOENIX_SHARP_VERSION}.`,
    );
  }
  const source = await readRequiredFile(PHOENIX_SOURCE_PATH);
  const sourceHash = sha256(source);
  if (sourceHash !== PHOENIX_SOURCE_SHA256) {
    throw new Error(`${PHOENIX_SOURCE_PATH} has SHA-256 ${sourceHash}; expected ${PHOENIX_SOURCE_SHA256}.`);
  }
  const license = await readRequiredFile(PHOENIX_LICENSE_PATH);
  const licenseHash = sha256(license);
  if (licenseHash !== PHOENIX_LICENSE_SHA256) {
    throw new Error(`${PHOENIX_LICENSE_PATH} has SHA-256 ${licenseHash}; expected ${PHOENIX_LICENSE_SHA256}.`);
  }

  const outputs = new Map<string, Buffer>();
  for (const target of PHOENIX_TARGETS) {
    outputs.set(target.path, await renderPhoenixPng(source, target.size));
  }
  return outputs;
}

async function atomicWrite(path: string, bytes: Uint8Array): Promise<boolean> {
  const status = await lstat(path).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (status?.isFile()) {
    const existing = await readFile(path);
    if (Buffer.from(existing).equals(Buffer.from(bytes))) return false;
  }
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  try {
    await Bun.write(temporaryPath, bytes);
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return true;
}

export async function generatePhoenixAssets(): Promise<readonly string[]> {
  const outputs = await expectedPhoenixOutputs();
  const changed: string[] = [];
  for (const target of PHOENIX_TARGETS) {
    const bytes = outputs.get(target.path);
    if (bytes === undefined) throw new Error(`Missing generated bytes for ${target.path}.`);
    if (await atomicWrite(absoluteRepositoryPath(target.path), bytes)) changed.push(target.path);
  }
  return changed;
}

export async function checkPhoenixAssets(): Promise<readonly string[]> {
  const errors: string[] = [];
  let expectedOutputs: ReadonlyMap<string, Buffer>;
  try {
    expectedOutputs = await expectedPhoenixOutputs();
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }

  for (const target of PHOENIX_TARGETS) {
    let actual: Uint8Array;
    try {
      actual = await readRequiredFile(target.path);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    const expected = expectedOutputs.get(target.path);
    if (expected === undefined) {
      errors.push(`${target.path}: generated expectation is missing.`);
      continue;
    }
    const actualHash = sha256(actual);
    const expectedHash = sha256(expected);
    if (actualHash !== expectedHash) {
      errors.push(`${target.path}: output SHA-256 ${actualHash}; expected ${expectedHash}.`);
      continue;
    }
    const metadata = await sharp(actual).metadata();
    if (
      metadata.format !== "png"
      || metadata.width !== target.size
      || metadata.height !== target.size
      || metadata.channels !== 3
      || metadata.hasAlpha !== false
    ) {
      errors.push(
        `${target.path}: expected opaque RGB PNG ${target.size}x${target.size}; `
          + `got ${metadata.format ?? "unknown"} ${metadata.width ?? "?"}x${metadata.height ?? "?"} `
          + `with ${metadata.channels ?? "?"} channels and alpha=${String(metadata.hasAlpha)}.`,
      );
    }
    if (PHOENIX_OUTPUT_SHA256[target.path] !== expectedHash) {
      errors.push(`${target.path}: checked output hash constant is stale; expected ${expectedHash}.`);
    }
  }
  return errors;
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length > 1 || arguments_.some((argument) => argument !== "--check")) {
    throw new Error("Usage: bun run scripts/generate-brand-assets.ts [--check]");
  }
  if (arguments_.includes("--check")) {
    const errors = await checkPhoenixAssets();
    if (errors.length > 0) {
      for (const error of errors) console.error(`- ${error}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Validated ${PHOENIX_TARGETS.length} phoenix brand assets without rewriting.`);
    return;
  }
  const changed = await generatePhoenixAssets();
  console.log(
    `Generated ${PHOENIX_TARGETS.length} phoenix brand assets; ${changed.length} file${changed.length === 1 ? "" : "s"} changed.`,
  );
}

if (import.meta.main) await main();
