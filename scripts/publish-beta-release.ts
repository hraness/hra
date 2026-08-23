import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { assertProductionPackageOnly } from "./package-policy";
import { assertPublicTree } from "./public-text-policy";

const repository = "hraness/hra";
const repositoryId = 1_343_008_607;
const releaseVersion = "0.1.0";
const releaseTag = `v${releaseVersion}`;
const workflowName = "Release";
const workflowPath = ".github/workflows/release.yml";
const artifactName = `hra-release-${releaseTag}`;
const title = `HRA ${releaseTag}`;
const repositoryRoot = resolve(import.meta.dir, "..");
const commandOutputMaximumBytes = 64 * 1024 * 1024;
const providerJsonMaximumBytes = 2 * 1024 * 1024;
const markerMaximumBytes = 64 * 1024;

const commitSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const positiveIntegerSchema = z.number().int().positive().safe();

export type PublicationAction = "accept" | "publish";

export type PublicationArguments = Readonly<{
  action: PublicationAction;
  expectedCommit: string;
  ghCli: string;
  runAttempt: number;
  runId: number;
  tag: typeof releaseTag;
}>;

export type PublicationPhase =
  | "before_publication"
  | "publication_unknown"
  | "published_acceptance_failed";

type PublicationFailureCode =
  | "accepted_artifact_invalid"
  | "command_failed"
  | "draft_invalid"
  | "immutable_release_disabled"
  | "local_source_invalid"
  | "marker_invalid"
  | "provider_result_invalid"
  | "public_acceptance_failed"
  | "publication_unknown"
  | "published_release_invalid"
  | "release_authority_changed"
  | "usage_invalid"
  | "workflow_run_invalid";

export class ReleasePublicationError extends Error {
  constructor(
    readonly code: PublicationFailureCode,
    readonly phase: PublicationPhase = "before_publication",
  ) {
    super(code);
    this.name = "ReleasePublicationError";
  }
}

const takeOption = (values: string[], name: string): string => {
  const index = values.indexOf(name);
  if (index < 0) throw new ReleasePublicationError("usage_invalid");
  const value = values[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new ReleasePublicationError("usage_invalid");
  }
  values.splice(index, 2);
  return value;
};

const takeFlag = (values: string[], name: string): boolean => {
  const index = values.indexOf(name);
  if (index < 0) return false;
  values.splice(index, 1);
  return true;
};

export function parsePublicationArguments(arguments_: readonly string[]): PublicationArguments {
  const values = [...arguments_];
  const action = values.shift();
  if (action !== "publish" && action !== "accept") {
    throw new ReleasePublicationError("usage_invalid");
  }
  const tag = takeOption(values, "--tag");
  const expectedCommit = takeOption(values, "--expected-commit");
  const runIdText = takeOption(values, "--run-id");
  const runAttemptText = takeOption(values, "--run-attempt");
  const ghCli = takeOption(values, "--gh-cli");
  const acknowledged = takeFlag(values, "--acknowledge-immutable-publication");
  const runId = Number(runIdText);
  const runAttempt = Number(runAttemptText);
  if (
    values.length !== 0
    || tag !== releaseTag
    || !commitSchema.safeParse(expectedCommit).success
    || !/^[1-9][0-9]*$/u.test(runIdText)
    || !/^[1-9][0-9]*$/u.test(runAttemptText)
    || !positiveIntegerSchema.safeParse(runId).success
    || !positiveIntegerSchema.safeParse(runAttempt).success
    || !isAbsolute(ghCli)
    || (action === "publish") !== acknowledged
  ) throw new ReleasePublicationError("usage_invalid");
  return {
    action,
    expectedCommit,
    ghCli,
    runAttempt,
    runId,
    tag: releaseTag,
  };
}

type MarkerReadback = Readonly<{
  body: unknown;
  redirected: boolean;
  status: number;
  url: string;
}>;

export interface ReleasePublicationProvider {
  acceptPackedInstall(archive: string, temporaryRoot: string): Promise<void>;
  acceptPublicInstall(url: string, temporaryRoot: string, expectedDigest: string): Promise<void>;
  downloadReleaseAsset(assetId: number, destination: string): Promise<void>;
  downloadRunArtifact(runId: number, name: string, destination: string): Promise<void>;
  listReleaseAssets(releaseId: number): Promise<unknown>;
  listReleases(): Promise<unknown>;
  publishDraft(releaseId: number): Promise<void>;
  readImmutableSetting(): Promise<unknown>;
  readMainCommit(): Promise<string>;
  readMarker(cacheKey: string): Promise<MarkerReadback>;
  readRepository(): Promise<unknown>;
  readRun(runId: number): Promise<unknown>;
  readRunArtifacts(runId: number): Promise<unknown>;
  readTagCommit(tag: string): Promise<string>;
  readWorkflow(): Promise<unknown>;
  verifyLocalSource(expectedCommit: string, requireCurrentMain: boolean): Promise<void>;
}

const repositorySchema = z.object({
  full_name: z.literal(repository),
  id: z.literal(repositoryId),
}).passthrough();

const workflowSchema = z.object({
  id: positiveIntegerSchema,
  name: z.literal(workflowName),
  path: z.literal(workflowPath),
  state: z.literal("active"),
}).passthrough();

const runSchema = z.object({
  conclusion: z.literal("success"),
  event: z.literal("push"),
  head_branch: z.literal(releaseTag),
  head_sha: commitSchema,
  id: positiveIntegerSchema,
  name: z.literal(workflowName),
  path: z.string().min(1).max(512),
  repository: repositorySchema,
  run_attempt: positiveIntegerSchema,
  status: z.literal("completed"),
  workflow_id: positiveIntegerSchema,
}).passthrough();

const artifactSchema = z.object({
  expired: z.literal(false),
  id: positiveIntegerSchema,
  name: z.literal(artifactName),
  workflow_run: z.object({ id: positiveIntegerSchema }).passthrough(),
}).passthrough();

const artifactListSchema = z.object({
  artifacts: z.array(artifactSchema).max(2),
  total_count: z.number().int().nonnegative().max(2),
}).passthrough();

const releaseSchema = z.object({
  body: z.string().max(256 * 1024),
  draft: z.boolean(),
  id: positiveIntegerSchema,
  immutable: z.boolean(),
  name: z.string().max(256),
  prerelease: z.boolean(),
  tag_name: z.string().max(128),
}).passthrough();

const releaseAssetSchema = z.object({
  id: positiveIntegerSchema,
  name: z.string().min(1).max(256),
  state: z.literal("uploaded"),
}).passthrough();

const markerSchema = z.object({
  generation: z.literal(1),
  product: z.literal("HRA"),
  repository: z.object({
    id: z.literal(repositoryId),
    path: z.literal(repository),
  }).strict(),
  schemaVersion: z.literal(2),
  source: z.object({ commit: commitSchema }).strict(),
  version: z.literal(releaseVersion),
}).strict();

const immutableSettingSchema = z.object({
  enabled: z.literal(true),
  enforced_by_owner: z.boolean(),
}).passthrough();

const expectedReleaseAssetNames = [
  "SHA256SUMS",
  `hra-${releaseTag}.artifact.spdx.json`,
  `hra-${releaseTag}.tgz`,
  `hra-${releaseTag}.ubuntu-24.04-x64.runtime.spdx.json`,
] as const;

const expectedChecksumNames = [
  `hra-${releaseTag}.tgz`,
  `hra-${releaseTag}.artifact.spdx.json`,
  `hra-${releaseTag}.ubuntu-24.04-x64.runtime.spdx.json`,
] as const;

const expectedAcceptedNames = [
  ...expectedReleaseAssetNames,
  "RELEASE_COMMIT",
  "RELEASE_NOTES.md",
].sort();

const readBounded = async (file: string, maximumBytes: number): Promise<Buffer> => {
  const metadata = await lstat(file);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > maximumBytes) {
    throw new ReleasePublicationError("accepted_artifact_invalid");
  }
  return await readFile(file);
};

const sha256 = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const readResponseBounded = async (
  response: Response,
  maximumBytes: number,
  failureCode: "marker_invalid" | "public_acceptance_failed",
): Promise<Uint8Array> => {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null
    && (!/^[0-9]+$/u.test(contentLength) || Number(contentLength) > maximumBytes)
  ) throw new ReleasePublicationError(failureCode);
  const reader = response.body?.getReader();
  if (reader === undefined) throw new ReleasePublicationError(failureCode);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let next = await reader.read();
  while (!next.done) {
    bytes += next.value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      throw new ReleasePublicationError(failureCode);
    }
    chunks.push(next.value);
    next = await reader.read();
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
};

type AcceptedBundle = Readonly<{
  archive: string;
  commit: string;
  notes: string;
  releaseAssets: ReadonlyMap<string, Buffer>;
}>;

const parseJsonBuffer = (value: Buffer): unknown => {
  try {
    return JSON.parse(value.toString("utf8")) as unknown;
  } catch {
    throw new ReleasePublicationError("accepted_artifact_invalid");
  }
};

const asObject = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ReleasePublicationError("accepted_artifact_invalid");
  }
  return value as Record<string, unknown>;
};

const verifyArtifactSbom = (
  value: unknown,
  archiveDigest: string,
): void => {
  const packages = asObject(value).packages;
  if (!Array.isArray(packages) || packages.length !== 1) {
    throw new ReleasePublicationError("accepted_artifact_invalid");
  }
  const package_ = asObject(packages[0]);
  if (package_.name !== "hra" || package_.versionInfo !== releaseVersion) {
    throw new ReleasePublicationError("accepted_artifact_invalid");
  }
  if (
    !Array.isArray(package_.checksums)
    || !package_.checksums.some((entry) => {
      const checksum = asObject(entry);
      return checksum.algorithm === "SHA256" && checksum.checksumValue === archiveDigest;
    })
  ) throw new ReleasePublicationError("accepted_artifact_invalid");
};

const verifyRuntimeSbom = (value: unknown): void => {
  const packages = asObject(value).packages;
  if (!Array.isArray(packages)) {
    throw new ReleasePublicationError("accepted_artifact_invalid");
  }
  const required = [
    ["hra", releaseVersion],
    ["@openai/codex", "0.149.0"],
    ["convex", "1.45.0"],
    ["zod", "4.4.3"],
  ] as const;
  for (const [name, version] of required) {
    if (!packages.some((entry) => {
      const package_ = asObject(entry);
      return package_.name === name && package_.versionInfo === version;
    })) throw new ReleasePublicationError("accepted_artifact_invalid");
  }
  const serialized = JSON.stringify(value);
  if (/\/(?:home\/runner|private\/tmp|tmp\/hra-release-publish-)/u.test(serialized)) {
    throw new ReleasePublicationError("accepted_artifact_invalid");
  }
};

export async function verifyAcceptedBundle(
  directory: string,
  expectedCommit: string,
): Promise<AcceptedBundle> {
  const names = (await readdir(directory)).sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedAcceptedNames)) {
    throw new ReleasePublicationError("accepted_artifact_invalid");
  }
  const commit = (await readBounded(join(directory, "RELEASE_COMMIT"), 128))
    .toString("utf8").trimEnd();
  if (commit !== expectedCommit || !commitSchema.safeParse(commit).success) {
    throw new ReleasePublicationError("accepted_artifact_invalid");
  }
  const notesBuffer = await readBounded(join(directory, "RELEASE_NOTES.md"), 256 * 1024);
  const notes = notesBuffer.toString("utf8");
  if (notes.trim().length === 0 || notes !== notes.trimEnd()) {
    throw new ReleasePublicationError("accepted_artifact_invalid");
  }
  const checksumBuffer = await readBounded(join(directory, "SHA256SUMS"), 8 * 1024);
  const checksumText = checksumBuffer.toString("utf8");
  if (!checksumText.endsWith("\n")) {
    throw new ReleasePublicationError("accepted_artifact_invalid");
  }
  const checksumLines = checksumText.slice(0, -1).split("\n");
  const checksums = new Map<string, string>();
  for (const line of checksumLines) {
    const match = /^([0-9a-f]{64}) {2}([^/]+)$/u.exec(line);
    if (match === null || checksums.has(match[2] ?? "")) {
      throw new ReleasePublicationError("accepted_artifact_invalid");
    }
    checksums.set(match[2] ?? "", match[1] ?? "");
  }
  if (JSON.stringify([...checksums.keys()]) !== JSON.stringify([...expectedChecksumNames])) {
    throw new ReleasePublicationError("accepted_artifact_invalid");
  }
  const releaseAssets = new Map<string, Buffer>();
  for (const name of expectedReleaseAssetNames) {
    const value = await readBounded(
      join(directory, name),
      name.endsWith(".tgz") ? 32 * 1024 * 1024 : 16 * 1024 * 1024,
    );
    releaseAssets.set(name, value);
    const expectedDigest = checksums.get(name);
    if (expectedDigest !== undefined && sha256(value) !== expectedDigest) {
      throw new ReleasePublicationError("accepted_artifact_invalid");
    }
  }
  const archiveName = `hra-${releaseTag}.tgz`;
  const archive = join(directory, archiveName);
  const archiveDigest = sha256(releaseAssets.get(archiveName) ?? Buffer.alloc(0));
  verifyArtifactSbom(
    parseJsonBuffer(releaseAssets.get(`hra-${releaseTag}.artifact.spdx.json`) ?? Buffer.alloc(0)),
    archiveDigest,
  );
  verifyRuntimeSbom(
    parseJsonBuffer(
      releaseAssets.get(`hra-${releaseTag}.ubuntu-24.04-x64.runtime.spdx.json`)
        ?? Buffer.alloc(0),
    ),
  );
  return { archive, commit, notes, releaseAssets };
}

const exactRelease = (value: unknown): z.infer<typeof releaseSchema> => {
  if (!Array.isArray(value)) throw new ReleasePublicationError("provider_result_invalid");
  const matches = value
    .map((entry) => releaseSchema.parse(entry))
    .filter((entry) => entry.tag_name === releaseTag);
  if (matches.length !== 1) throw new ReleasePublicationError("draft_invalid");
  return matches[0] as z.infer<typeof releaseSchema>;
};

const exactAssets = (value: unknown): readonly z.infer<typeof releaseAssetSchema>[] => {
  if (!Array.isArray(value)) throw new ReleasePublicationError("provider_result_invalid");
  const assets = value.map((entry) => releaseAssetSchema.parse(entry));
  const names = assets.map((entry) => entry.name).sort();
  if (JSON.stringify(names) !== JSON.stringify([...expectedReleaseAssetNames])) {
    throw new ReleasePublicationError("draft_invalid");
  }
  return assets;
};

const downloadAndVerifyAssets = async (
  provider: ReleasePublicationProvider,
  releaseId: number,
  directory: string,
  accepted: AcceptedBundle,
): Promise<void> => {
  await mkdir(directory, { mode: 0o700 });
  const assets = exactAssets(await provider.listReleaseAssets(releaseId));
  for (const asset of assets) {
    const destination = join(directory, asset.name);
    await provider.downloadReleaseAsset(asset.id, destination);
    const downloaded = await readBounded(destination, 32 * 1024 * 1024);
    const expected = accepted.releaseAssets.get(asset.name);
    if (expected === undefined || !downloaded.equals(expected)) {
      throw new ReleasePublicationError("draft_invalid");
    }
  }
};

const verifyRunAuthority = async (
  provider: ReleasePublicationProvider,
  arguments_: PublicationArguments,
): Promise<void> => {
  repositorySchema.parse(await provider.readRepository());
  const workflow = workflowSchema.parse(await provider.readWorkflow());
  const run = runSchema.parse(await provider.readRun(arguments_.runId));
  const fullTagRef = ["refs", "tags", releaseTag].join("/");
  const acceptedPaths = [workflowPath, `${workflowPath}@${releaseTag}`, `${workflowPath}@${fullTagRef}`];
  if (
    run.id !== arguments_.runId
    || run.run_attempt !== arguments_.runAttempt
    || run.workflow_id !== workflow.id
    || run.head_sha !== arguments_.expectedCommit
    || !acceptedPaths.includes(run.path)
  ) throw new ReleasePublicationError("workflow_run_invalid");
  const artifactList = artifactListSchema.parse(await provider.readRunArtifacts(arguments_.runId));
  if (
    artifactList.total_count !== 1
    || artifactList.artifacts.length !== 1
    || artifactList.artifacts[0]?.workflow_run.id !== arguments_.runId
  ) throw new ReleasePublicationError("workflow_run_invalid");
};

const verifyReleaseMetadata = (
  release: z.infer<typeof releaseSchema>,
  accepted: AcceptedBundle,
  expectedDraft: boolean,
): void => {
  if (
    release.tag_name !== releaseTag
    || release.name !== title
    || release.body !== accepted.notes
    || !release.prerelease
    || release.draft !== expectedDraft
    || release.immutable !== !expectedDraft
  ) throw new ReleasePublicationError(expectedDraft ? "draft_invalid" : "published_release_invalid");
};

const verifyCanonicalMarker = async (
  provider: ReleasePublicationProvider,
  arguments_: PublicationArguments,
): Promise<void> => {
  const marker = await provider.readMarker(
    `run-${String(arguments_.runId)}-attempt-${String(arguments_.runAttempt)}-${crypto.randomUUID()}`,
  );
  let markerUrl: URL;
  try {
    markerUrl = new URL(marker.url);
  } catch {
    throw new ReleasePublicationError("marker_invalid");
  }
  if (
    marker.status !== 200
    || marker.redirected
    || markerUrl.origin !== "https://hra.sh"
    || markerUrl.pathname !== "/.well-known/hra.json"
  ) throw new ReleasePublicationError("marker_invalid");
  const parsedMarker = markerSchema.safeParse(marker.body);
  if (!parsedMarker.success || parsedMarker.data.source.commit !== arguments_.expectedCommit) {
    throw new ReleasePublicationError("marker_invalid");
  }
};

const verifyFinalPublicationAuthority = async (
  provider: ReleasePublicationProvider,
  arguments_: PublicationArguments,
): Promise<void> => {
  const [tagCommit, mainCommit] = await Promise.all([
    provider.readTagCommit(arguments_.tag),
    provider.readMainCommit(),
  ]);
  if (tagCommit !== arguments_.expectedCommit || mainCommit !== arguments_.expectedCommit) {
    throw new ReleasePublicationError("release_authority_changed");
  }
  try {
    immutableSettingSchema.parse(await provider.readImmutableSetting());
  } catch {
    throw new ReleasePublicationError("immutable_release_disabled");
  }
};

const verifyPublished = async (
  provider: ReleasePublicationProvider,
  accepted: AcceptedBundle,
  temporaryRoot: string,
  expectedReleaseId: number,
): Promise<void> => {
  try {
    const release = exactRelease(await provider.listReleases());
    verifyReleaseMetadata(release, accepted, false);
    if (release.id !== expectedReleaseId) {
      throw new ReleasePublicationError("published_release_invalid");
    }
    await downloadAndVerifyAssets(provider, release.id, join(temporaryRoot, "published-assets"), accepted);
    const publicUrl = `https://github.com/${repository}/releases/download/${releaseTag}/hra-${releaseTag}.tgz`;
    const archive = accepted.releaseAssets.get(`hra-${releaseTag}.tgz`);
    if (archive === undefined) throw new ReleasePublicationError("published_release_invalid");
    await provider.acceptPublicInstall(
      publicUrl,
      join(temporaryRoot, "public-install"),
      sha256(archive),
    );
  } catch (error: unknown) {
    const code = error instanceof ReleasePublicationError
      ? error.code
      : "published_release_invalid";
    throw new ReleasePublicationError(
      code === "public_acceptance_failed" ? code : "published_release_invalid",
      "published_acceptance_failed",
    );
  }
};

export async function executeReleasePublication(options: Readonly<{
  arguments: PublicationArguments;
  provider: ReleasePublicationProvider;
  temporaryRoot: string;
}>): Promise<Readonly<{ commit: string; status: "accepted" | "published"; tag: string }>> {
  const { arguments: arguments_, provider, temporaryRoot } = options;
  await provider.verifyLocalSource(
    arguments_.expectedCommit,
    arguments_.action === "publish",
  );
  await verifyRunAuthority(provider, arguments_);
  const acceptedDirectory = join(temporaryRoot, "accepted");
  await mkdir(acceptedDirectory, { mode: 0o700 });
  await provider.downloadRunArtifact(arguments_.runId, artifactName, acceptedDirectory);
  const accepted = await verifyAcceptedBundle(acceptedDirectory, arguments_.expectedCommit);
  try {
    await provider.acceptPackedInstall(accepted.archive, join(temporaryRoot, "packed-install"));
  } catch {
    throw new ReleasePublicationError("accepted_artifact_invalid");
  }
  if (arguments_.action === "accept") {
    let acceptedReleaseId: number | undefined;
    try {
      const release = exactRelease(await provider.listReleases());
      verifyReleaseMetadata(release, accepted, false);
      acceptedReleaseId = release.id;
      await downloadAndVerifyAssets(
        provider,
        release.id,
        join(temporaryRoot, "staged-assets"),
        accepted,
      );
    } catch (error: unknown) {
      const code = error instanceof ReleasePublicationError
        ? error.code
        : "published_release_invalid";
      throw new ReleasePublicationError(code, "published_acceptance_failed");
    }
    await verifyPublished(provider, accepted, temporaryRoot, acceptedReleaseId);
    return { commit: accepted.commit, status: "accepted", tag: releaseTag };
  }

  await verifyCanonicalMarker(provider, arguments_);
  const release = exactRelease(await provider.listReleases());
  verifyReleaseMetadata(release, accepted, true);
  await downloadAndVerifyAssets(provider, release.id, join(temporaryRoot, "staged-assets"), accepted);

  await verifyFinalPublicationAuthority(provider, arguments_);
  try {
    await provider.publishDraft(release.id);
  } catch {
    try {
      const recovered = exactRelease(await provider.listReleases());
      verifyReleaseMetadata(recovered, accepted, false);
      if (recovered.id !== release.id) {
        throw new ReleasePublicationError("publication_unknown", "publication_unknown");
      }
    } catch {
      throw new ReleasePublicationError("publication_unknown", "publication_unknown");
    }
  }
  await verifyPublished(provider, accepted, temporaryRoot, release.id);
  return { commit: accepted.commit, status: "published", tag: releaseTag };
}

type ProcessResult = Readonly<{
  exitCode: number;
  stderr: Buffer;
  stdout: Buffer;
}>;

type ProcessRequest = Readonly<{
  arguments: readonly string[];
  cwd?: string;
  environment?: Readonly<NodeJS.ProcessEnv>;
  executable: string;
  outputMaximumBytes?: number;
  timeoutMs?: number;
}>;

const runProcess = async (request: ProcessRequest): Promise<ProcessResult> =>
  await new Promise<ProcessResult>((resolvePromise) => {
    const child = spawn(request.executable, [...request.arguments], {
      cwd: request.cwd ?? repositoryRoot,
      env: request.environment ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let finished = false;
    const maximum = request.outputMaximumBytes ?? commandOutputMaximumBytes;
    const finish = (exitCode: number): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolvePromise({
        exitCode,
        stderr: Buffer.concat(stderr),
        stdout: Buffer.concat(stdout),
      });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(124);
    }, request.timeoutMs ?? 120_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes <= maximum) stdout.push(chunk);
      else {
        child.kill("SIGKILL");
        finish(1);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= maximum) stderr.push(chunk);
      else {
        child.kill("SIGKILL");
        finish(1);
      }
    });
    child.once("error", () => finish(1));
    child.once("close", (exitCode) => finish(exitCode ?? 1));
  });

const requireSuccess = (result: ProcessResult): ProcessResult => {
  if (result.exitCode !== 0) throw new ReleasePublicationError("command_failed");
  return result;
};

const parseJson = (result: ProcessResult): unknown => {
  const stdout = requireSuccess(result).stdout;
  if (stdout.byteLength === 0 || stdout.byteLength > providerJsonMaximumBytes) {
    throw new ReleasePublicationError("provider_result_invalid");
  }
  try {
    return JSON.parse(stdout.toString("utf8")) as unknown;
  } catch {
    throw new ReleasePublicationError("provider_result_invalid");
  }
};

const assertInstalledExecutable = async (
  globalRoot: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  doctorStateRoot: string,
): Promise<void> => {
  const installedRoot = await realpath(join(globalRoot, "install", "global", "node_modules", "hra"));
  await assertProductionPackageOnly(installedRoot);
  const executable = join(globalRoot, "bin", "hra");
  const version = requireSuccess(await runProcess({
    arguments: ["--version"],
    environment,
    executable,
  })).stdout.toString("utf8");
  if (version !== `hra ${releaseVersion}\n`) {
    throw new ReleasePublicationError("accepted_artifact_invalid");
  }
  type InstalledCliModule = Readonly<{
    main(
      arguments_: readonly string[],
      output: Readonly<{ writeStderr(value: string): void; writeStdout(value: string): void }>,
      input: Readonly<{ statePaths: unknown }>,
    ): Promise<number>;
  }>;
  type InstalledPathsModule = Readonly<{
    resolveStatePaths(input: Readonly<{ rootDirectory: string }>): unknown;
  }>;
  const [cliModule, pathsModule] = await Promise.all([
    import(pathToFileURL(join(installedRoot, "src", "cli.ts")).href) as Promise<InstalledCliModule>,
    import(pathToFileURL(join(installedRoot, "src", "storage", "paths.ts")).href) as Promise<InstalledPathsModule>,
  ]);
  let doctorStdout = "";
  let doctorStderr = "";
  const doctorCode = await cliModule.main(
    ["doctor", "--offline", "--json"],
    {
      writeStderr: (value) => { doctorStderr += value; },
      writeStdout: (value) => { doctorStdout += value; },
    },
    { statePaths: pathsModule.resolveStatePaths({ rootDirectory: doctorStateRoot }) },
  );
  const doctorValue = z.object({
    data: z.object({ offline: z.literal(true) }).passthrough(),
    ok: z.literal(true),
  }).passthrough().safeParse(((): unknown => {
    try {
      return JSON.parse(doctorStdout) as unknown;
    } catch {
      return null;
    }
  })());
  if (!doctorValue.success || doctorCode !== 0 || doctorStderr !== "") {
    throw new ReleasePublicationError("accepted_artifact_invalid");
  }
};

const withoutEnvironmentKeys = (
  source: Readonly<NodeJS.ProcessEnv>,
  names: readonly string[],
): NodeJS.ProcessEnv => {
  const omitted = new Set(names);
  return Object.fromEntries(
    Object.entries(source).filter(([name]) => !omitted.has(name)),
  );
};

export const buildGitHubCliEnvironment = (
  source: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv => withoutEnvironmentKeys(source, [
    "GH_ENTERPRISE_TOKEN",
    "GH_HOST",
    "GH_TOKEN",
    "GITHUB_AUTH_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "GITHUB_TOKEN",
  ]);

export const assertLocalOperatorEnvironment = (
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  if (
    environment.GITHUB_ACTIONS === "true"
    || ["1", "true"].includes(environment.CI?.toLowerCase() ?? "")
  ) throw new ReleasePublicationError("local_source_invalid");
};

export const buildIsolatedInstallEnvironment = async (
  source: Readonly<NodeJS.ProcessEnv>,
  temporaryRoot: string,
): Promise<Readonly<{ environment: NodeJS.ProcessEnv; globalRoot: string }>> => {
  const globalRoot = join(temporaryRoot, "bun-global");
  const temporaryDirectory = join(temporaryRoot, "tmp");
  const xdgRoot = join(temporaryRoot, "xdg");
  const npmConfig = join(temporaryRoot, "empty.npmrc");
  const netrc = join(temporaryRoot, "empty.netrc");
  const gitConfig = join(temporaryRoot, "empty.gitconfig");
  const bunConfig = join(xdgRoot, "config", ".bunfig.toml");
  await Promise.all([
    mkdir(temporaryDirectory, { mode: 0o700 }),
    mkdir(join(xdgRoot, "cache"), { recursive: true, mode: 0o700 }),
    mkdir(join(xdgRoot, "config"), { recursive: true, mode: 0o700 }),
    mkdir(join(xdgRoot, "data"), { recursive: true, mode: 0o700 }),
    mkdir(join(xdgRoot, "state"), { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    writeFile(npmConfig, "", { flag: "wx", mode: 0o600 }),
    writeFile(netrc, "", { flag: "wx", mode: 0o600 }),
    writeFile(gitConfig, "", { flag: "wx", mode: 0o600 }),
    writeFile(
      bunConfig,
      '[install]\nregistry = "https://registry.npmjs.org"\n',
      { flag: "wx", mode: 0o600 },
    ),
  ]);
  const environment: NodeJS.ProcessEnv = {
    ...withoutEnvironmentKeys(source, [
      "BUN_AUTH_TOKEN",
      "BUN_CONFIG_TOKEN",
      "GIT_ASKPASS",
      "GH_ENTERPRISE_TOKEN",
      "GH_TOKEN",
      "GITHUB_AUTH_TOKEN",
      "GITHUB_ENTERPRISE_TOKEN",
      "GITHUB_TOKEN",
      "NODE_AUTH_TOKEN",
      "NPM_TOKEN",
      "SSH_ASKPASS",
      "SSH_AUTH_SOCK",
      "npm_config__auth",
      "npm_config__authToken",
    ]),
    BUN_CONFIG_REGISTRY: "https://registry.npmjs.org",
    BUN_INSTALL: globalRoot,
    DO_NOT_TRACK: "1",
    GIT_CONFIG_GLOBAL: gitConfig,
    NETRC: netrc,
    NPM_CONFIG_REGISTRY: "https://registry.npmjs.org",
    NPM_CONFIG_USERCONFIG: npmConfig,
    TMPDIR: temporaryDirectory,
    XDG_CACHE_HOME: join(xdgRoot, "cache"),
    XDG_CONFIG_HOME: join(xdgRoot, "config"),
    XDG_DATA_HOME: join(xdgRoot, "data"),
    XDG_STATE_HOME: join(xdgRoot, "state"),
  };
  return { environment, globalRoot };
};

export class GitHubReleasePublicationProvider implements ReleasePublicationProvider {
  constructor(
    private readonly options: Readonly<{
      environment?: Readonly<NodeJS.ProcessEnv>;
      fetcher?: typeof fetch;
      ghCli: string;
      root?: string;
    }>,
  ) {}

  private get environment(): Readonly<NodeJS.ProcessEnv> {
    return this.options.environment ?? process.env;
  }

  private get ghEnvironment(): Readonly<NodeJS.ProcessEnv> {
    return buildGitHubCliEnvironment(this.environment);
  }

  private get root(): string {
    return this.options.root ?? repositoryRoot;
  }

  private async gh(arguments_: readonly string[], maximum = providerJsonMaximumBytes): Promise<ProcessResult> {
    return await runProcess({
      arguments: [...arguments_],
      cwd: this.root,
      environment: this.ghEnvironment,
      executable: this.options.ghCli,
      outputMaximumBytes: maximum,
    });
  }

  private async ghJson(arguments_: readonly string[]): Promise<unknown> {
    return parseJson(await this.gh(arguments_));
  }

  async verifyLocalSource(expectedCommit: string, requireCurrentMain: boolean): Promise<void> {
    assertLocalOperatorEnvironment(this.environment);
    requireSuccess(await runProcess({
      arguments: ["fetch", "origin", "main", "--tags"],
      cwd: this.root,
      environment: this.environment,
      executable: "git",
    }));
    const query = async (arguments_: readonly string[]): Promise<string> =>
      requireSuccess(await runProcess({
        arguments: [...arguments_],
        cwd: this.root,
        environment: this.environment,
        executable: "git",
        outputMaximumBytes: 64 * 1024,
      })).stdout.toString("utf8").trimEnd();
    const [status, head, tagCommit, remote, branch, main] = await Promise.all([
      query(["status", "--porcelain=v1", "--untracked-files=all"]),
      query(["rev-parse", "HEAD^{commit}"]),
      query(["rev-parse", `refs/tags/${releaseTag}^{commit}`]),
      query(["remote", "get-url", "origin"]),
      query(["branch", "--show-current"]),
      query(["rev-parse", "origin/main^{commit}"]),
    ]);
    const remoteAccepted = remote === "https://github.com/hraness/hra.git"
      || remote === "git@github.com:hraness/hra.git";
    if (
      status !== ""
      || head !== expectedCommit
      || tagCommit !== expectedCommit
      || !remoteAccepted
      || (requireCurrentMain && (branch !== "main" || main !== expectedCommit))
    ) throw new ReleasePublicationError("local_source_invalid");
  }

  async readRepository(): Promise<unknown> {
    return await this.ghJson(["api", `repos/${repository}`]);
  }

  async readWorkflow(): Promise<unknown> {
    return await this.ghJson(["api", `repos/${repository}/actions/workflows/release.yml`]);
  }

  async readRun(runId: number): Promise<unknown> {
    return await this.ghJson(["api", `repos/${repository}/actions/runs/${String(runId)}`]);
  }

  async readRunArtifacts(runId: number): Promise<unknown> {
    return await this.ghJson([
      "api",
      `repos/${repository}/actions/runs/${String(runId)}/artifacts?per_page=100`,
    ]);
  }

  async downloadRunArtifact(runId: number, name: string, destination: string): Promise<void> {
    requireSuccess(await this.gh([
      "run",
      "download",
      String(runId),
      "--repo",
      repository,
      "--name",
      name,
      "--dir",
      destination,
    ]));
  }

  async listReleases(): Promise<unknown> {
    const pages = await this.ghJson([
      "api",
      "--paginate",
      "--slurp",
      `repos/${repository}/releases?per_page=100`,
    ]);
    if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
      throw new ReleasePublicationError("provider_result_invalid");
    }
    return pages.flat();
  }

  async listReleaseAssets(releaseId: number): Promise<unknown> {
    return await this.ghJson([
      "api",
      `repos/${repository}/releases/${String(releaseId)}/assets?per_page=100`,
    ]);
  }

  async downloadReleaseAsset(assetId: number, destination: string): Promise<void> {
    const result = requireSuccess(await this.gh([
      "api",
      "-H",
      "Accept: application/octet-stream",
      `repos/${repository}/releases/assets/${String(assetId)}`,
    ], commandOutputMaximumBytes));
    await writeFile(destination, result.stdout, { flag: "wx", mode: 0o600 });
  }

  async readTagCommit(tag: string): Promise<string> {
    const value = z.object({ sha: commitSchema }).passthrough().parse(
      await this.ghJson(["api", `repos/${repository}/commits/refs/tags/${tag}`]),
    );
    return value.sha;
  }

  async readMainCommit(): Promise<string> {
    const value = z.object({
      object: z.object({ sha: commitSchema }).passthrough(),
    }).passthrough().parse(
      await this.ghJson(["api", `repos/${repository}/git/ref/heads/main`]),
    );
    return value.object.sha;
  }

  async readImmutableSetting(): Promise<unknown> {
    return await this.ghJson(["api", `repos/${repository}/immutable-releases`]);
  }

  async readMarker(cacheKey: string): Promise<MarkerReadback> {
    const fetcher = this.options.fetcher ?? fetch;
    let response: Response;
    try {
      response = await fetcher(
        `https://hra.sh/.well-known/hra.json?release-check=${encodeURIComponent(cacheKey)}`,
        {
          cache: "no-store",
          headers: { "Cache-Control": "no-cache, no-store, max-age=0", Pragma: "no-cache" },
          redirect: "manual",
          signal: AbortSignal.timeout(30_000),
        },
      );
    } catch {
      throw new ReleasePublicationError("marker_invalid");
    }
    let bytes: Uint8Array;
    try {
      bytes = await readResponseBounded(response, markerMaximumBytes, "marker_invalid");
    } catch {
      throw new ReleasePublicationError("marker_invalid");
    }
    if (bytes.byteLength === 0) {
      throw new ReleasePublicationError("marker_invalid");
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      throw new ReleasePublicationError("marker_invalid");
    }
    return {
      body,
      redirected: response.redirected,
      status: response.status,
      url: response.url,
    };
  }

  async publishDraft(releaseId: number): Promise<void> {
    requireSuccess(await this.gh([
      "api",
      "--method",
      "PATCH",
      "--silent",
      "-F",
      "draft=false",
      "-F",
      "prerelease=true",
      `repos/${repository}/releases/${String(releaseId)}`,
    ]));
  }

  async acceptPackedInstall(archive: string, temporaryRoot: string): Promise<void> {
    await mkdir(temporaryRoot, { mode: 0o700 });
    const listing = requireSuccess(await runProcess({
      arguments: ["-tzf", archive],
      cwd: this.root,
      executable: "tar",
      outputMaximumBytes: 4 * 1024 * 1024,
    })).stdout.toString("utf8");
    const verboseListing = requireSuccess(await runProcess({
      arguments: ["-tvzf", archive],
      cwd: this.root,
      executable: "tar",
      outputMaximumBytes: 8 * 1024 * 1024,
    })).stdout.toString("utf8").trimEnd().split("\n");
    const entries = listing.trimEnd().split("\n");
    if (
      entries.length === 0
      || entries.length > 10_000
      || verboseListing.length !== entries.length
      || verboseListing.some((entry) => !entry.startsWith("-") && !entry.startsWith("d"))
      || entries.some((entry) => {
        const segments = entry.split("/");
        return !entry.startsWith("package/")
          || entry.startsWith("/")
          || segments.includes("..")
          || entry.includes("\\");
      })
    ) throw new ReleasePublicationError("accepted_artifact_invalid");
    const extracted = join(temporaryRoot, "extracted");
    await mkdir(extracted, { mode: 0o700 });
    requireSuccess(await runProcess({
      arguments: ["-xzf", archive, "-C", extracted],
      cwd: this.root,
      executable: "tar",
    }));
    await assertPublicTree(extracted);
    await assertProductionPackageOnly(extracted);
    const { environment, globalRoot } = await buildIsolatedInstallEnvironment(
      this.environment,
      temporaryRoot,
    );
    requireSuccess(await runProcess({
      arguments: ["add", "--global", "--ignore-scripts", archive],
      cwd: temporaryRoot,
      environment,
      executable: process.execPath,
    }));
    await assertInstalledExecutable(
      globalRoot,
      environment,
      join(temporaryRoot, "doctor-state"),
    );
  }

  async acceptPublicInstall(
    url: string,
    temporaryRoot: string,
    expectedDigest: string,
  ): Promise<void> {
    await mkdir(temporaryRoot, { mode: 0o700 });
    const { environment, globalRoot } = await buildIsolatedInstallEnvironment(
      this.environment,
      temporaryRoot,
    );
    const fetcher = this.options.fetcher ?? fetch;
    let response: Response;
    try {
      response = await fetcher(url, {
        cache: "no-store",
        redirect: "follow",
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new ReleasePublicationError("public_acceptance_failed", "published_acceptance_failed");
    }
    let publicBytes: Uint8Array;
    try {
      publicBytes = await readResponseBounded(
        response,
        32 * 1024 * 1024,
        "public_acceptance_failed",
      );
    } catch {
      throw new ReleasePublicationError("public_acceptance_failed", "published_acceptance_failed");
    }
    if (
      response.status !== 200
      || !response.url.startsWith("https://")
      || publicBytes.byteLength === 0
      || sha256(publicBytes) !== expectedDigest
    ) throw new ReleasePublicationError("public_acceptance_failed", "published_acceptance_failed");
    requireSuccess(await runProcess({
      arguments: ["add", "--global", url],
      cwd: temporaryRoot,
      environment,
      executable: process.execPath,
    }));
    await assertInstalledExecutable(
      globalRoot,
      environment,
      join(temporaryRoot, "doctor-state"),
    );
  }
}

export async function withBestEffortReleaseCleanup<T>(
  operation: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> {
  try {
    return await operation();
  } finally {
    // Cleanup contains only public release bytes and isolated empty state. It must
    // never replace the authoritative pre- or post-publication outcome.
    await cleanup().catch(() => undefined);
  }
}

export async function runReleasePublication(options: Readonly<{
  arguments: PublicationArguments;
  provider: ReleasePublicationProvider;
  temporaryParent?: string;
}>): Promise<Readonly<{ commit: string; status: "accepted" | "published"; tag: string }>> {
  const parent = options.temporaryParent ?? tmpdir();
  const temporaryRoot = await realpath(await mkdtemp(join(parent, "hra-release-publish-")));
  return await withBestEffortReleaseCleanup(
    async () => await executeReleasePublication({
      arguments: options.arguments,
      provider: options.provider,
      temporaryRoot,
    }),
    async () => await rm(temporaryRoot, { force: true, recursive: true }),
  );
}

if (import.meta.main) {
  let exitCode = 1;
  try {
    const arguments_ = parsePublicationArguments(process.argv.slice(2));
    const result = await runReleasePublication({
      arguments: arguments_,
      provider: new GitHubReleasePublicationProvider({ ghCli: arguments_.ghCli }),
    });
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ...result })}\n`);
    exitCode = 0;
  } catch (error: unknown) {
    const failure = error instanceof ReleasePublicationError
      ? error
      : new ReleasePublicationError("provider_result_invalid");
    process.stderr.write(`${JSON.stringify({
      code: failure.code,
      phase: failure.phase,
      schemaVersion: 1,
      status: "refused",
    })}\n`);
  }
  process.exitCode = exitCode;
}
