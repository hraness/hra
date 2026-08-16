import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { z } from "@hra-internal/schema";
import {
  runtimePins,
  verifyRuntimePinMetadata,
  verifyRuntimePins,
} from "./verify-runtime-pins";

const desktopRoot = join(import.meta.dir, "..");
const committedRoot = join(
  desktopRoot,
  "contracts",
  "generated",
  "codex",
  runtimePins.codex.version,
);
const manifestPath = join(desktopRoot, "contracts", "generated", "codex", "manifest.json");

const generatedManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    codexVersion: z.literal(runtimePins.codex.version),
    fileCount: z.number().int().positive(),
    treeSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

async function generate(outRoot: string, codex: string): Promise<void> {
  const commands = [
    [
      codex,
      "app-server",
      "generate-ts",
      "--experimental",
      "--out",
      join(outRoot, "typescript"),
    ],
    [
      codex,
      "app-server",
      "generate-json-schema",
      "--experimental",
      "--out",
      join(outRoot, "json-schema"),
    ],
  ] as const;

  for (const command of commands) {
    const child = Bun.spawn([...command], { stdout: "inherit", stderr: "inherit" });
    const exitCode = await child.exited;
    if (exitCode !== 0) {
      throw new Error(`Codex schema generation failed with exit code ${exitCode}`);
    }
  }
}

async function fileMap(root: string): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        files.set(relative(root, path).split(sep).join("/"), await readFile(path));
      }
    }
  }

  if ((await stat(root).catch(() => null))?.isDirectory()) {
    await visit(root);
  }
  return files;
}

function generatedTreeDigest(files: ReadonlyMap<string, Uint8Array>): string {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const [name, bytes] of [...files.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    hasher.update(`${String(name.length)}:${name}:${String(bytes.byteLength)}:`);
    hasher.update(bytes);
  }
  return hasher.digest("hex");
}

async function writeGeneratedManifest(): Promise<void> {
  const files = await fileMap(committedRoot);
  const manifest = generatedManifestSchema.parse({
    schemaVersion: 1,
    codexVersion: runtimePins.codex.version,
    fileCount: files.size,
    treeSha256: generatedTreeDigest(files),
  });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function checkGeneratedManifest(): Promise<void> {
  const manifest = generatedManifestSchema.parse(
    JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
  );
  const files = await fileMap(committedRoot);
  if (files.size !== manifest.fileCount || generatedTreeDigest(files) !== manifest.treeSha256) {
    throw new Error("Committed Codex schema does not match its portable manifest");
  }
}

async function checkGenerated(codex: string): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "hra-codex-schema-"));
  try {
    await generate(scratch, codex);
    const [expected, actual] = await Promise.all([fileMap(committedRoot), fileMap(scratch)]);
    const names = new Set([...expected.keys(), ...actual.keys()]);
    const changed = [...names].filter((name) => {
      const left = expected.get(name);
      const right = actual.get(name);
      if (left === undefined || right === undefined) return true;
      if (name.endsWith(".json")) {
        const decoder = new TextDecoder();
        return !Bun.deepEquals(
          JSON.parse(decoder.decode(left)) as unknown,
          JSON.parse(decoder.decode(right)) as unknown,
        );
      }
      return left.length !== right.length || left.some((byte, index) => byte !== right[index]);
    });
    if (changed.length > 0) {
      throw new Error(`Generated Codex schema is stale:\n${changed.slice(0, 25).join("\n")}`);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const check = process.argv.includes("--check");
const verifyBinary = process.argv.includes("--verify-binary");

if (verifyBinary && !check) {
  throw new Error("--verify-binary is valid only with --check");
}

if (check) {
  await verifyRuntimePinMetadata();
  await checkGeneratedManifest();
  if (verifyBinary) {
    const verified = await verifyRuntimePins();
    await checkGenerated(verified.codexBinary);
    process.stdout.write(
      `Codex ${runtimePins.codex.version} schema matches the pinned macOS binary.\n`,
    );
  } else {
    process.stdout.write(
      `Codex ${runtimePins.codex.version} committed schema manifest is current.\n`,
    );
  }
} else {
  const verified = await verifyRuntimePins();
  await rm(committedRoot, { recursive: true, force: true });
  await generate(committedRoot, verified.codexBinary);
  await writeGeneratedManifest();
  process.stdout.write(`Generated Codex ${runtimePins.codex.version} schema.\n`);
}
