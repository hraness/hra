import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

import { CODEX_PIN, type CodexPinVersion } from "../src/codex/pin";
import {
  PINNED_CODEX_NOTIFICATION_MATRIX,
  PINNED_CODEX_SERVER_REQUEST_MATRIX,
  codexMatrixDigest,
} from "../src/codex/protocol";

/**
 * Rewrites `src/codex/pin.ts` for one exact Codex release: the pin constant,
 * the fifteen generated-schema digests, and the two reviewed matrix digests.
 * `--check` recomputes everything and reports whether the file is current.
 * The script refuses to run when the installed `@openai/codex` package or the
 * `package.json` dependency differs from the requested version.
 */

export const CODEX_PIN_RELATIVE_PATH = "src/codex/pin.ts";

/** Generated files whose digests `pin.ts` records, in emission order. */
export const TRACKED_CODEX_SCHEMA_FILES = [
  "ServerNotification.ts",
  "ServerRequest.ts",
  "ClientRequest.ts",
  "v2/ConsumeAccountRateLimitResetCreditParams.ts",
  "v2/ConsumeAccountRateLimitResetCreditResponse.ts",
  "v2/ConsumeAccountRateLimitResetCreditOutcome.ts",
  "v2/ThreadStartParams.ts",
  "v2/ThreadResumeParams.ts",
  "v2/DynamicToolCallParams.ts",
  "v2/DynamicToolCallResponse.ts",
  "v2/DynamicToolSpec.ts",
  "v2/DynamicToolNamespaceSpec.ts",
  "v2/DynamicToolNamespaceTool.ts",
  "v2/DynamicToolFunctionSpec.ts",
  "v2/DynamicToolCallOutputContentItem.ts",
] as const;

export type TrackedCodexSchemaFile = (typeof TRACKED_CODEX_SCHEMA_FILES)[number];
export type CodexSchemaDigests = Readonly<Record<TrackedCodexSchemaFile, string>>;
export type CodexMatrixDigests = Readonly<{ serverRequest: string; notification: string }>;

export type CodexBumpMode = "write" | "check";
export type CodexBumpArguments = Readonly<{ version: CodexPinVersion; mode: CodexBumpMode }>;

export const CODEX_BUMP_EXIT = Object.freeze({
  ok: 0,
  reviewRequired: 1,
  refused: 2,
} as const);

const SEMVER_PATTERN = /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const GENERATE_TIMEOUT_MS = 120_000;
const GENERATE_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const SCHEMA_FILE_MAX_BYTES = 8 * 1024 * 1024;
const MANIFEST_MAX_BYTES = 256 * 1024;
const USAGE = "usage: bun run codex:bump <major.minor.patch> [--check]";

export class CodexBumpRefusedError extends Error {
  override readonly name = "CodexBumpRefusedError";
}

export const isCodexPinVersion = (value: string): value is CodexPinVersion =>
  SEMVER_PATTERN.test(value);

export function parseCodexBumpArguments(argv: readonly string[]): CodexBumpArguments {
  if (argv.length === 0 || argv.length > 2) throw new CodexBumpRefusedError(USAGE);
  let version: CodexPinVersion | undefined;
  let mode: CodexBumpMode = "write";
  for (const argument of argv) {
    if (argument === "--check") {
      if (mode === "check") throw new CodexBumpRefusedError(USAGE);
      mode = "check";
      continue;
    }
    if (argument.startsWith("-") || version !== undefined || argument.length > 32) {
      throw new CodexBumpRefusedError(USAGE);
    }
    if (!isCodexPinVersion(argument)) {
      throw new CodexBumpRefusedError(
        `${USAGE}\nThe version must be an exact release like 1.2.3, not a range or prerelease.`,
      );
    }
    version = argument;
  }
  if (version === undefined) throw new CodexBumpRefusedError(USAGE);
  return { version, mode };
}

const codexManifestSchema = z.object({
  name: z.literal("@openai/codex"),
  version: z.string().regex(SEMVER_PATTERN),
  bin: z.union([
    z.string().min(1).max(2_048),
    z.object({ codex: z.string().min(1).max(2_048) }).passthrough(),
  ]),
}).passthrough();

export type CodexManifest = Readonly<{ version: CodexPinVersion; launcher: string }>;

/** Parses the installed package manifest from `unknown` and resolves its launcher. */
export function parseCodexManifest(value: unknown, manifestPath: string): CodexManifest {
  const parsed = codexManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new CodexBumpRefusedError("The installed @openai/codex package manifest is not a pinned release manifest.");
  }
  const relativeBin = typeof parsed.data.bin === "string" ? parsed.data.bin : parsed.data.bin.codex;
  const packageRoot = dirname(manifestPath);
  const launcher = resolve(packageRoot, relativeBin);
  if (!launcher.startsWith(`${packageRoot}/`)) {
    throw new CodexBumpRefusedError("The installed @openai/codex launcher escapes its package root.");
  }
  if (!isCodexPinVersion(parsed.data.version)) {
    throw new CodexBumpRefusedError("The installed @openai/codex version is not an exact release.");
  }
  return { version: parsed.data.version, launcher };
}

const repoManifestSchema = z.object({
  dependencies: z.object({ "@openai/codex": z.string().min(1).max(64) }).passthrough(),
}).passthrough();

export function parseRepositoryCodexDependency(value: unknown): string {
  const parsed = repoManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new CodexBumpRefusedError("package.json does not declare an exact @openai/codex dependency.");
  }
  return parsed.data.dependencies["@openai/codex"];
}

export function renderCodexPinSource(input: Readonly<{
  version: CodexPinVersion;
  schemaDigests: CodexSchemaDigests;
  matrixDigests: CodexMatrixDigests;
}>): string {
  const digestLine = (key: string, digest: string): string => {
    if (!DIGEST_PATTERN.test(digest)) throw new CodexBumpRefusedError(`Invalid digest for ${key}.`);
    return `  ${JSON.stringify(key)}: ${JSON.stringify(digest)},`;
  };
  const schemaLines = TRACKED_CODEX_SCHEMA_FILES
    .map((file) => digestLine(file, input.schemaDigests[file]))
    .join("\n");
  return `// Written by \`bun run codex:bump <version>\`. Do not edit by hand.
//
// This module is the only place in \`src/\` that spells the pinned Codex
// version. Every other site imports \`CODEX_PIN\`, and the reviewed digests
// below are regenerated from the installed \`@openai/codex\` executable.

/** Exact release semver, never a range or prerelease. */
export type CodexPinVersion = \`\${number}.\${number}.\${number}\`;

export const CODEX_PIN = ${JSON.stringify(input.version)} satisfies CodexPinVersion;

/**
 * SHA-256 of files produced by the pinned executable's
 * \`app-server generate-ts --experimental\`, keyed by output path.
 */
export const PINNED_CODEX_SCHEMA_DIGESTS = Object.freeze({
${schemaLines}
} as const);

/**
 * SHA-256 of \`CODEX_PIN\`, a newline, then each reviewed matrix entry as
 * \`method:disposition\` joined by newlines. See \`codexMatrixDigest\` in
 * \`protocol.ts\`.
 */
export const PINNED_CODEX_MATRIX_DIGESTS = Object.freeze({
  serverRequest: ${JSON.stringify(input.matrixDigests.serverRequest)},
  notification: ${JSON.stringify(input.matrixDigests.notification)},
} as const);
`;
}

export type MatrixDrift = Readonly<{ added: readonly string[]; removed: readonly string[] }>;

export function matrixDrift(
  generatedMethods: readonly string[],
  reviewedMethods: readonly string[],
): MatrixDrift {
  const generated = new Set(generatedMethods);
  const reviewed = new Set(reviewedMethods);
  return {
    added: generatedMethods.filter((method) => !reviewed.has(method)),
    removed: reviewedMethods.filter((method) => !generated.has(method)),
  };
}

export const methodsInGeneratedUnion = (source: string): readonly string[] =>
  [...source.matchAll(/\{ "method": "([^"]+)"/gu)].flatMap((match) => match[1] === undefined ? [] : [match[1]]);

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export type GeneratedCodexSchemas = Readonly<{
  schemaDigests: CodexSchemaDigests;
  notificationMethods: readonly string[];
  serverRequestMethods: readonly string[];
}>;

export async function generateCodexSchemas(input: Readonly<{
  bunExecutable: string;
  launcher: string;
}>): Promise<GeneratedCodexSchemas> {
  if (!isAbsolute(input.bunExecutable) || !isAbsolute(input.launcher)) {
    throw new CodexBumpRefusedError("Executable paths must be absolute.");
  }
  const outputDirectory = await mkdtemp(join(tmpdir(), "hra-codex-bump-"));
  try {
    const generated = Bun.spawnSync({
      cmd: [input.bunExecutable, input.launcher, "app-server", "generate-ts", "--experimental", "--out", outputDirectory],
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      timeout: GENERATE_TIMEOUT_MS,
      maxBuffer: GENERATE_MAX_OUTPUT_BYTES,
    });
    if (generated.exitCode !== 0) {
      throw new CodexBumpRefusedError(
        `codex app-server generate-ts failed with exit code ${generated.exitCode}.`,
      );
    }
    const digests: Partial<Record<TrackedCodexSchemaFile, string>> = {};
    let notificationMethods: readonly string[] = [];
    let serverRequestMethods: readonly string[] = [];
    for (const file of TRACKED_CODEX_SCHEMA_FILES) {
      const path = join(outputDirectory, file);
      const size = Bun.file(path).size;
      if (size === 0 || size > SCHEMA_FILE_MAX_BYTES) {
        throw new CodexBumpRefusedError(`Generated ${file} is missing or exceeds ${SCHEMA_FILE_MAX_BYTES} bytes.`);
      }
      const source = await readFile(path, "utf8");
      digests[file] = sha256(source);
      if (file === "ServerNotification.ts") notificationMethods = methodsInGeneratedUnion(source);
      if (file === "ServerRequest.ts") serverRequestMethods = methodsInGeneratedUnion(source);
    }
    return {
      schemaDigests: digests as CodexSchemaDigests,
      notificationMethods,
      serverRequestMethods,
    };
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

export type CodexBumpIo = Readonly<{
  repoRoot: string;
  bunExecutable: string;
  stdout: (line: string) => void;
}>;

const readBoundedJson = async (path: string, label: string): Promise<unknown> => {
  const file = Bun.file(path);
  if (!(await file.exists()) || file.size > MANIFEST_MAX_BYTES) {
    throw new CodexBumpRefusedError(`${label} is missing or larger than ${MANIFEST_MAX_BYTES} bytes.`);
  }
  try {
    return JSON.parse(await file.text()) as unknown;
  } catch {
    throw new CodexBumpRefusedError(`${label} is not valid JSON.`);
  }
};

const changedKeys = <Key extends string>(
  before: Readonly<Record<Key, string>>,
  after: Readonly<Record<Key, string>>,
  keys: readonly Key[],
): readonly Key[] => keys.filter((key) => before[key] !== after[key]);

/** Runs one bump or check. Returns the process exit code and never throws for a refusal. */
export async function runCodexBump(args: CodexBumpArguments, io: CodexBumpIo): Promise<number> {
  const { stdout } = io;
  try {
    if (!isAbsolute(io.repoRoot)) throw new CodexBumpRefusedError("The repository root must be absolute.");
    const dependency = parseRepositoryCodexDependency(
      await readBoundedJson(join(io.repoRoot, "package.json"), "package.json"),
    );
    if (dependency !== args.version) {
      throw new CodexBumpRefusedError(
        `package.json pins @openai/codex ${dependency}, not ${args.version}. Set the exact dependency, run \`bun install\`, then rerun.`,
      );
    }
    let manifestPath: string;
    try {
      manifestPath = Bun.resolveSync("@openai/codex/package.json", io.repoRoot);
    } catch {
      throw new CodexBumpRefusedError("@openai/codex is not installed. Run `bun install`, then rerun.");
    }
    const manifest = parseCodexManifest(await readBoundedJson(manifestPath, "@openai/codex manifest"), manifestPath);
    if (manifest.version !== args.version) {
      throw new CodexBumpRefusedError(
        `Installed @openai/codex is ${manifest.version}, not ${args.version}. Run \`bun install\`, then rerun.`,
      );
    }

    const pinPath = join(io.repoRoot, CODEX_PIN_RELATIVE_PATH);
    const currentSource = await readFile(pinPath, "utf8");
    const current = await import(pinPath) as Readonly<{
      PINNED_CODEX_SCHEMA_DIGESTS: CodexSchemaDigests;
      PINNED_CODEX_MATRIX_DIGESTS: CodexMatrixDigests;
    }>;

    const generated = await generateCodexSchemas({ bunExecutable: io.bunExecutable, launcher: manifest.launcher });
    const matrixDigests: CodexMatrixDigests = {
      serverRequest: codexMatrixDigest(args.version, PINNED_CODEX_SERVER_REQUEST_MATRIX),
      notification: codexMatrixDigest(args.version, PINNED_CODEX_NOTIFICATION_MATRIX),
    };
    const nextSource = renderCodexPinSource({
      version: args.version,
      schemaDigests: generated.schemaDigests,
      matrixDigests,
    });
    const notificationDrift = matrixDrift(generated.notificationMethods, Object.keys(PINNED_CODEX_NOTIFICATION_MATRIX));
    const requestDrift = matrixDrift(generated.serverRequestMethods, Object.keys(PINNED_CODEX_SERVER_REQUEST_MATRIX));
    const drifted = [notificationDrift, requestDrift].some((drift) => drift.added.length > 0 || drift.removed.length > 0);
    const changed = nextSource !== currentSource;

    stdout(`codex:bump ${CODEX_PIN} -> ${args.version} (${args.mode})`);
    const changedSchemas = changedKeys(current.PINNED_CODEX_SCHEMA_DIGESTS, generated.schemaDigests, TRACKED_CODEX_SCHEMA_FILES);
    stdout(`  schema digests: ${changedSchemas.length} of ${TRACKED_CODEX_SCHEMA_FILES.length} changed${changedSchemas.length === 0 ? "" : ` (${changedSchemas.join(", ")})`}`);
    const changedMatrices = changedKeys(current.PINNED_CODEX_MATRIX_DIGESTS, matrixDigests, ["serverRequest", "notification"] as const);
    stdout(`  matrix digests: ${changedMatrices.length} of 2 changed${changedMatrices.length === 0 ? "" : ` (${changedMatrices.join(", ")})`}`);
    const describeDrift = (label: string, drift: MatrixDrift): void => {
      if (drift.added.length === 0 && drift.removed.length === 0) {
        stdout(`  ${label} methods: unchanged`);
        return;
      }
      stdout(`  ${label} methods: +${drift.added.length} -${drift.removed.length}`);
      for (const method of drift.added) stdout(`    added   ${method}`);
      for (const method of drift.removed) stdout(`    removed ${method}`);
    };
    describeDrift("ServerNotification", notificationDrift);
    describeDrift("ServerRequest", requestDrift);

    if (args.mode === "check") {
      stdout(changed ? `  ${CODEX_PIN_RELATIVE_PATH}: stale` : `  ${CODEX_PIN_RELATIVE_PATH}: current`);
    } else if (changed) {
      await writeFile(pinPath, nextSource, "utf8");
      stdout(`  ${CODEX_PIN_RELATIVE_PATH}: written`);
    } else {
      stdout(`  ${CODEX_PIN_RELATIVE_PATH}: unchanged`);
    }

    stdout("Review before commit:");
    if (drifted) {
      stdout(`  1. Classify each added method and remove each removed method in the matrices in src/codex/protocol.ts, then rerun \`bun run codex:bump ${args.version}\` to sign the reviewed matrices.`);
    }
    stdout("  - src/domain/usage-metrics.ts: bump ACCOUNT_USAGE_SCHEMA_ID only if this release changes what lifetimeTokens means.");
    stdout("  - Prose that names the pin: README.md, site/content.ts, kb/plans, docs/live-acceptance.md plan vocabulary.");
    stdout("  - Run `bun test src/codex --isolate --max-concurrency=1`, then the docs/live-acceptance.md gate before release.");

    if (drifted) return CODEX_BUMP_EXIT.reviewRequired;
    if (args.mode === "check" && changed) return CODEX_BUMP_EXIT.reviewRequired;
    return CODEX_BUMP_EXIT.ok;
  } catch (error: unknown) {
    if (error instanceof CodexBumpRefusedError) {
      stdout(`codex:bump refused: ${error.message}`);
      return CODEX_BUMP_EXIT.refused;
    }
    throw error;
  }
}

if (import.meta.main) {
  let args: CodexBumpArguments;
  try {
    args = parseCodexBumpArguments(process.argv.slice(2));
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : USAGE}\n`);
    process.exit(CODEX_BUMP_EXIT.refused);
  }
  const exitCode = await runCodexBump(args, {
    repoRoot: resolve(import.meta.dir, ".."),
    bunExecutable: process.execPath,
    stdout: (line) => process.stdout.write(`${line}\n`),
  });
  process.exit(exitCode);
}
