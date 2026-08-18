import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";

const helper = resolve(import.meta.dir, "../../zig-out/bin/hra-image-normalizer");
const maximumSourceBytes = 24 * 1024 * 1024;
const validJPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQIACgAKAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAMDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAcEAEAAgEFAAAAAAAAAAAAAAABAAIDBAUUIWP/xAAUAQEAAAAAAAAAAAAAAAAAAAAF/8QAFxEAAwEAAAAAAAAAAAAAAAAAAAECMv/aAAwDAQACEQMRAD8Ah+7VK6qgAHHwPR5ViIhsZQ7Wmf/Z",
  "base64",
);
const validHEIC = Buffer.from(
  "AAAAHGZ0eXBoZWljAAAAAG1pZjFoZWljbWlhZgAAAWltZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAAA5waXRtAAAAAAABAAAAImlsb2MAAAAAREAAAQABAAAAAAGNAAEAAAAAAAAATAAAACNpaW5mAAAAAAABAAAAFWluZmUCAAAAAAEAAGh2YzEAAAAA6WlwcnAAAADKaXBjbwAAAHZodmNDAQNwAAAAAAAAAAAAHvAA/P34+AAADwMgAAEAGEABDAH//wNwAAADAJAAAAMAAAMAHroCQCEAAQAqQgEBA3AAAAMAkAAAAwAAAwAeoCCBBZbqrprm4CGgwIAAAAMAgAAAAwCEIgABAAZEAcFzwYkAAAAUaXNwZQAAAAAAAABAAAAAQAAAAChjbGFwAAAAAgAAAAEAAAACAAAAAf///8IAAAAC////wgAAAAIAAAAQcGl4aQAAAAADCAgIAAAAF2lwbWEAAAAAAAAAAQABBIECBIMAAABUbWRhdAAAAEgoAa8TIXGTQPVK/MXZGHzKB6U5l/fQ/q/XgA1gkjI0Mx3DRMsd9E9i8J+AlMP91jA6hKPrF46JHxRVwMShTdPYBJCTjcO411Y=",
  "base64",
);
const validWebP = Buffer.from(
  "UklGRjgAAABXRUJQVlA4ICwAAADwAQCdASoCAAIAAgA0JZACdLoAAwkG+4AA/vr+i71fN9j2eD9qYJIycgAAAA==",
  "base64",
);

type NormalizerResult = Readonly<{
  exitCode: number;
  stderr: string;
  stdout: string;
}>;

type NormalizedImage = Readonly<{
  canonical: Readonly<{
    bytes: number;
    height: number;
    sha256: string;
    width: number;
  }>;
  mediaType: string;
  preview: Readonly<{
    bytes: number;
    height: number;
    sha256: string;
    width: number;
  }>;
  schemaVersion: 1;
  sourceBytes: number;
}>;

let fixtureRoot = "";

beforeAll(async () => {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("The image normalizer suite requires Apple Silicon macOS.");
  }
  fixtureRoot = await mkdtemp("/private/tmp/hra-image-normalizer-test-");
});

afterAll(async () => {
  if (fixtureRoot !== "") {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb8_8320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const result = Buffer.alloc(12 + data.byteLength);
  result.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(result, 4);
  Buffer.from(data).copy(result, 8);
  result.writeUInt32BE(
    crc32(Buffer.concat([typeBytes, Buffer.from(data)])),
    8 + data.byteLength,
  );
  return result;
}

function createPNG(width = 4, height = 2): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const rowOffset = row * (width * 4 + 1);
    for (let column = 0; column < width; column += 1) {
      const pixel = rowOffset + 1 + column * 4;
      scanlines[pixel] = column * 37;
      scanlines[pixel + 1] = row * 83;
      scanlines[pixel + 2] = 191;
      scanlines[pixel + 3] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function replacePNGDimensions(png: Buffer, width: number, height: number): Buffer {
  const header = Buffer.from(png.subarray(16, 29));
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  return Buffer.concat([png.subarray(0, 8), pngChunk("IHDR", header), png.subarray(33)]);
}

function insertBeforeIDAT(png: Buffer, chunk: Buffer): Buffer {
  let offset = 8;
  while (offset < png.length) {
    if (png.subarray(offset + 4, offset + 8).toString("ascii") === "IDAT") {
      return Buffer.concat([png.subarray(0, offset), chunk, png.subarray(offset)]);
    }
    offset += png.readUInt32BE(offset) + 12;
  }
  throw new Error("Fixture PNG has no IDAT chunk.");
}

function orientedJPEG(): Buffer {
  const exifOrientationSix = Buffer.from([
    0xff, 0xe1, 0x00, 0x22,
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,
    0x00, 0x01,
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01,
    0x00, 0x06, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]);
  return Buffer.concat([
    validJPEG.subarray(0, 2),
    exifOrientationSix,
    validJPEG.subarray(2),
  ]);
}

function animatedWebP(): Buffer {
  const animationChunk = Buffer.from([
    0x41, 0x4e, 0x49, 0x4d,
    0x06, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
  const result = Buffer.concat([
    validWebP.subarray(0, 12),
    animationChunk,
    validWebP.subarray(12),
  ]);
  result.writeUInt32LE(result.length - 8, 4);
  return result;
}

async function runNormalizer(
  input: string,
  outputDirectory: string,
): Promise<NormalizerResult> {
  const child = Bun.spawn([
    helper,
    "normalize",
    "--input",
    input,
    "--output-directory",
    outputDirectory,
  ], {
    cwd: "/",
    env: { PATH: "/usr/bin:/bin" },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stderr, stdout };
}

async function normalizeFixture(
  label: string,
  bytes: Uint8Array,
): Promise<Readonly<{
  canonical: string;
  outputDirectory: string;
  preview: string;
  result: NormalizerResult;
}>> {
  const root = resolve(fixtureRoot, label);
  await mkdir(root, { mode: 0o700 });
  const input = resolve(root, "input");
  const outputDirectory = resolve(root, "attachment_generation");
  const canonical = resolve(outputDirectory, "canonical.png");
  const preview = resolve(outputDirectory, "preview.png");
  await writeFile(input, bytes, { mode: 0o600 });
  return {
    canonical,
    outputDirectory,
    preview,
    result: await runNormalizer(input, outputDirectory),
  };
}

function parseSuccess(result: NormalizerResult, label = "fixture"): NormalizedImage {
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed (${result.exitCode}): ${result.stderr}`);
  }
  expect(result.stderr).toBe("");
  expect(result.stdout.endsWith("\n")).toBe(true);
  const parsed = JSON.parse(result.stdout) as NormalizedImage;
  expect(Object.keys(parsed)).toEqual([
    "schemaVersion",
    "mediaType",
    "sourceBytes",
    "canonical",
    "preview",
  ]);
  expect(parsed.schemaVersion).toBe(1);
  expect(parsed.canonical.sha256).toMatch(/^[0-9a-f]{64}$/u);
  expect(parsed.preview.sha256).toMatch(/^[0-9a-f]{64}$/u);
  expect(result.stdout).not.toContain(fixtureRoot);
  return parsed;
}

async function expectPathAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
    throw new Error("Expected path to be absent.");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
  }
}

async function expectRejected(
  label: string,
  bytes: Uint8Array,
): Promise<NormalizerResult> {
  const { outputDirectory, result } = await normalizeFixture(label, bytes);
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(/^hra-image-normalizer:error:[0-9]+\n$/u);
  expect(result.stderr).not.toContain(fixtureRoot);
  await expectPathAbsent(outputDirectory);
  return result;
}

describe("signed image normalizer helper", () => {
  test("accepts only the fixed ordered absolute-path protocol", async () => {
    const child = Bun.spawn([
      helper,
      "normalize",
      "--output-directory",
      "/private/tmp/unused-generation",
      "--input",
      "/private/tmp/unused-input",
    ], { stderr: "pipe", stdout: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(64);
    expect(stdout).toBe("");
    expect(stderr).toBe("hra-image-normalizer:error:64\n");

    const root = resolve(fixtureRoot, "relative-protocol");
    await mkdir(root, { mode: 0o700 });
    const input = resolve(root, "input.png");
    await writeFile(input, createPNG(), { mode: 0o600 });
    expect((await runNormalizer(input, "relative-generation")).exitCode).toBe(70);
  });

  test("normalizes every allowlisted container into deterministic bounded sRGB PNGs", async () => {
    const fixtures = [
      ["png", createPNG(), "image/png"],
      ["jpeg", validJPEG, "image/jpeg"],
      ["heic", validHEIC, "image/heic"],
      ["webp", validWebP, "image/webp"],
    ] as const;
    for (const [label, bytes, mediaType] of fixtures) {
      const first = await normalizeFixture(`${label}-first`, bytes);
      const second = await normalizeFixture(`${label}-second`, bytes);
      const firstEvidence = parseSuccess(first.result, `${label}-first`);
      const secondEvidence = parseSuccess(second.result, `${label}-second`);
      expect(firstEvidence.mediaType).toBe(mediaType);
      expect(secondEvidence).toEqual(firstEvidence);
      const [canonical, canonicalAgain, preview, previewAgain] = await Promise.all([
        readFile(first.canonical),
        readFile(second.canonical),
        readFile(first.preview),
        readFile(second.preview),
      ]);
      expect(canonical).toEqual(canonicalAgain);
      expect(preview).toEqual(previewAgain);
      expect(createHash("sha256").update(canonical).digest("hex"))
        .toBe(firstEvidence.canonical.sha256);
      expect(createHash("sha256").update(preview).digest("hex"))
        .toBe(firstEvidence.preview.sha256);
      expect(Math.max(firstEvidence.preview.width, firstEvidence.preview.height))
        .toBeLessThanOrEqual(320);
      expect(firstEvidence.preview.bytes).toBeLessThanOrEqual(512 * 1024);
      expect((await lstat(first.outputDirectory)).mode & 0o777).toBe(0o700);
      expect((await readdir(first.outputDirectory)).sort()).toEqual([
        "canonical.png",
        "preview.png",
      ]);
      expect((await lstat(first.canonical)).mode & 0o777).toBe(0o600);
      expect((await lstat(first.preview)).mode & 0o777).toBe(0o600);
    }
  });

  test("applies orientation and strips source metadata before encoding", async () => {
    const oriented = await normalizeFixture("oriented-jpeg", orientedJPEG());
    const orientationEvidence = parseSuccess(oriented.result, "oriented-jpeg");
    expect(orientationEvidence.canonical).toMatchObject({ width: 2, height: 3 });

    const comment = Buffer.from("Comment\0private-source-value", "latin1");
    const metadataPNG = insertBeforeIDAT(createPNG(), pngChunk("tEXt", comment));
    const metadata = await normalizeFixture("metadata-png", metadataPNG);
    parseSuccess(metadata.result, "metadata-png");
    expect((await readFile(metadata.canonical)).includes("private-source-value"))
      .toBe(false);
    expect((await readFile(metadata.preview)).includes("private-source-value"))
      .toBe(false);
  });

  test("rejects animation, excluded containers, and detectable polyglots", async () => {
    const animationControl = Buffer.alloc(8);
    animationControl.writeUInt32BE(1, 0);
    await expectRejected(
      "apng",
      insertBeforeIDAT(createPNG(), pngChunk("acTL", animationControl)),
    );
    await expectRejected("animated-webp", animatedWebP());
    await expectRejected(
      "gif",
      Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"),
    );
    await expectRejected("tiff", Buffer.from("II*\u0000\b\u0000\u0000\u0000", "latin1"));
    await expectRejected("pdf", Buffer.from("%PDF-1.7\n%%EOF\n"));
    await expectRejected("svg", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"));
    await expectRejected("png-polyglot", Buffer.concat([createPNG(), Buffer.from("PK\u0003\u0004")]));
    await expectRejected("jpeg-polyglot", Buffer.concat([validJPEG, Buffer.from("payload")]));
    await expectRejected("webp-polyglot", Buffer.concat([validWebP, Buffer.from("payload")]));
  });

  test("rejects declared dimensions, decompression bounds, and oversized sources", async () => {
    expect((await expectRejected(
      "dimension-overflow",
      replacePNGDimensions(createPNG(), 8193, 1),
    )).stderr).toContain(":68");
    expect((await expectRejected(
      "pixel-overflow",
      replacePNGDimensions(createPNG(), 8192, 8192),
    )).stderr).toContain(":68");

    const root = resolve(fixtureRoot, "source-overflow");
    await mkdir(root, { mode: 0o700 });
    const input = resolve(root, "input");
    const descriptor = await open(input, "wx", 0o600);
    await descriptor.truncate(maximumSourceBytes + 1);
    await descriptor.close();
    const outputDirectory = resolve(root, "attachment_generation");
    const result = await runNormalizer(input, outputDirectory);
    expect(result.exitCode).toBe(66);
    await expectPathAbsent(outputDirectory);
  });

  test("rejects symlinks, hardlinks, special files, and occupied outputs without residue", async () => {
    const root = resolve(fixtureRoot, "filesystem-authority");
    await mkdir(root, { mode: 0o700 });
    const source = resolve(root, "source.png");
    await writeFile(source, createPNG(), { mode: 0o600 });

    const sourceLink = resolve(root, "source-link.png");
    await symlink("source.png", sourceLink);
    expect((await runNormalizer(
      sourceLink,
      resolve(root, "symlink-generation"),
    )).exitCode).toBe(66);

    const hardlinked = resolve(root, "hardlinked.png");
    const hardlinkAlias = resolve(root, "hardlinked-alias.png");
    await copyFile(source, hardlinked);
    await link(hardlinked, hardlinkAlias);
    expect((await runNormalizer(
      hardlinked,
      resolve(root, "hardlink-generation"),
    )).exitCode).toBe(66);

    const fifo = resolve(root, "source.fifo");
    const mkfifo = Bun.spawn(["/usr/bin/mkfifo", fifo], {
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(await mkfifo.exited).toBe(0);
    expect((await runNormalizer(
      fifo,
      resolve(root, "fifo-generation"),
    )).exitCode).toBe(66);

    const occupiedOutput = resolve(root, "occupied-generation");
    await mkdir(occupiedOutput, { mode: 0o700 });
    await writeFile(resolve(occupiedOutput, "sentinel"), "sentinel", { mode: 0o600 });
    expect((await runNormalizer(source, occupiedOutput)).exitCode).toBe(70);
    expect(await readFile(resolve(occupiedOutput, "sentinel"), "utf8")).toBe("sentinel");

    const outputLink = resolve(root, "output-link");
    await symlink("absent-generation", outputLink);
    expect((await runNormalizer(
      source,
      outputLink,
    )).exitCode).toBe(70);
    expect((await lstat(outputLink)).isSymbolicLink()).toBe(true);
    expect((await readdir(root)).filter((name) =>
      name.startsWith(".hra-image-normalizer-"))).toEqual([]);
  });

  test("admits an entitlement-free ad-hoc signature with the fixed identifier", async () => {
    const source = await readFile(
      resolve(import.meta.dir, "../../src/macos_image_normalizer.m"),
      "utf8",
    );
    expect(source).not.toMatch(
      /\b(?:accept|bind|connect|getaddrinfo|listen|recv|send|socket|socketpair)\s*\(/u,
    );
    expect(source).not.toMatch(/NSURL|CFHTTP|Network\.framework/u);

    const signed = resolve(fixtureRoot, "signed-hra-image-normalizer");
    await copyFile(helper, signed);
    const sign = Bun.spawn([
      "/usr/bin/codesign",
      "--force",
      "--sign",
      "-",
      "--options",
      "runtime",
      "--identifier",
      "hra-image-normalizer",
      signed,
    ], { stderr: "pipe", stdout: "pipe" });
    expect(await sign.exited).toBe(0);
    const verify = Bun.spawn([
      "/usr/bin/codesign",
      "--verify",
      "--strict",
      signed,
    ], { stderr: "pipe", stdout: "pipe" });
    expect(await verify.exited).toBe(0);
    const details = Bun.spawn([
      "/usr/bin/codesign",
      "--display",
      "--verbose=4",
      "--entitlements",
      ":-",
      signed,
    ], { stderr: "pipe", stdout: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(details.stdout).text(),
      new Response(details.stderr).text(),
      details.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(`${stdout}\n${stderr}`).toContain("Identifier=hra-image-normalizer");
    expect(`${stdout}\n${stderr}`).not.toContain("<key>");
  });
});
