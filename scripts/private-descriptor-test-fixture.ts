import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { isatty } from "node:tty";

import { z } from "zod";

import { liveAcceptanceCandidateSchema } from "./live-acceptance-installation";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const integer = z.number().int().nonnegative().safe();
const identitySchema = z.object({
  ctimeMs: z.number().finite(),
  dev: integer,
  ino: integer,
  mode: integer,
  mtimeMs: z.number().finite(),
  nlink: integer,
  size: integer,
  uid: integer,
}).strict();
const operationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("vercel-token"), nowSeconds: integer }).strict(),
  z.object({ kind: z.literal("provider-activity") }).strict(),
  z.object({ candidate: liveAcceptanceCandidateSchema, kind: z.literal("claude-cleanup") }).strict(),
]);
const provenanceSchema = z.object({
  alias: digestSchema,
  claude: digestSchema,
  fixture: digestSchema,
  runtime: identitySchema,
}).strict();
const requestSchema = z.object({
  identity: identitySchema,
  operation: operationSchema,
  provenance: provenanceSchema,
  version: z.literal(1),
}).strict();
const resultSchema = z.object({
  closure: z.enum(["reader", "fixture"]),
  descriptor: z.literal(3),
  effects: z.literal(0),
  kind: z.enum(["vercel-token", "provider-activity", "claude-cleanup"]),
  outcome: z.enum(["accepted", "refused", "cleaned"]),
  sha256: digestSchema.nullable(),
  version: z.literal(1),
}).strict();
const failureStageSchema = z.enum([
  "arguments", "provenance", "descriptor-admission", "claude-import", "claude-cleanup",
  "claude-result", "alias-import", "alias-reader", "descriptor-close", "result",
]);
const failureCodeSchema = z.enum([
  "input_invalid", "login_unproven", "proof_unavailable", "shutdown_unproven", "cleanup_unproven",
  "operator_interrupted", "provider_credentials_refused", "recovery_evidence_invalid",
  "scope_refused", "custody_refused", "concurrent_owner", "primitive_unavailable",
  "receipt_present", "release_unproven", "closed",
  "ERR_ASSERTION", "EBADF", "EACCES", "ENOENT", "EPERM", "unclassified",
]);
const failureSchema = z.object({ code: failureCodeSchema, stage: failureStageSchema }).strict();
type FailureStage = z.infer<typeof failureStageSchema>;
type FixtureFailure = z.infer<typeof failureSchema>;

export type PrivateDescriptorFixtureOperation = z.infer<typeof operationSchema>;
export type PrivateDescriptorFixtureResult = z.infer<typeof resultSchema>;

export function privateDescriptorFixtureEnvironment(
  operation: PrivateDescriptorFixtureOperation,
  home: string | undefined,
  expectedHome: string,
  temporaryRoot: string,
): Record<string, string> {
  const environment = { LANG: "C", LC_ALL: "C", TZ: "UTC" };
  if (operation.kind !== "claude-cleanup") return environment;
  const canonical = (value: string): boolean => {
    if (value.length <= 1 || value.length > 4096 || !isAbsolute(value) || resolve(value) !== value) return false;
    for (const character of value) {
      const code = character.charCodeAt(0);
      if (code < 32 || code === 127) return false;
    }
    return true;
  };
  assert.ok(home !== undefined && canonical(home)
    && home === expectedHome, "Claude fixture requires the parent's exact canonical home identity");
  assert.ok(canonical(temporaryRoot), "Claude fixture requires the parent's physical temporary root");
  return { ...environment, HOME: home, TMPDIR: temporaryRoot };
}

export function privateDescriptorFixtureFailure(error: unknown, stage: FailureStage): FixtureFailure {
  const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
  const parsed = failureCodeSchema.safeParse(code);
  return { code: parsed.success ? parsed.data : "unclassified", stage };
}

export function privateDescriptorFixtureFailureMessage(stderr: string): string {
  try {
    if (Buffer.byteLength(stderr) > 1024) return "unclassified";
    const parsed = failureSchema.safeParse(JSON.parse(stderr) as unknown);
    return parsed.success ? JSON.stringify(parsed.data) : "unclassified";
  } catch { return "unclassified"; }
}

export function parsePrivateDescriptorFixtureRequest(value: unknown) {
  return requestSchema.parse(value);
}

export function assertPrivateDescriptorFixtureProvenance(actual: unknown, expected: unknown): void {
  assert.deepEqual(provenanceSchema.parse(actual), provenanceSchema.parse(expected), "Foreign fixture source or runtime provenance");
}

function identity(descriptor: number) {
  const value = fstatSync(descriptor);
  assert.ok(value.isFile(), "Fixture descriptor must identify a regular file");
  return identitySchema.parse({
    ctimeMs: value.ctimeMs,
    dev: value.dev,
    ino: value.ino,
    mode: value.mode,
    mtimeMs: value.mtimeMs,
    nlink: value.nlink,
    size: value.size,
    uid: value.uid,
  });
}

function sourceDigest(name: "private-descriptor-test-fixture.ts" | "current-project-alias-release.ts" | "claude-live-acceptance.ts"): string {
  const path = join(import.meta.dir, name);
  assert.equal(realpathSync(path), path, "Fixture source path must be physical");
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = identity(descriptor);
    assert.ok(before.size > 0 && before.size <= 512 * 1024 && before.nlink === 1, "Fixture source bounds changed");
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.byteLength) {
      const count = readSync(descriptor, bytes, length, bytes.byteLength - length, length);
      if (count === 0) break;
      length += count;
    }
    assert.equal(length, before.size, "Fixture source size changed");
    assert.deepEqual(identity(descriptor), before, "Fixture source identity changed");
    return createHash("sha256").update(bytes.subarray(0, length)).digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

function provenance() {
  assert.equal(Bun.version, "1.3.14", "Fixture requires the repository-pinned Bun");
  const runtime = openSync(realpathSync(process.execPath), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return {
      alias: sourceDigest("current-project-alias-release.ts"),
      claude: sourceDigest("claude-live-acceptance.ts"),
      fixture: sourceDigest("private-descriptor-test-fixture.ts"),
      runtime: identity(runtime),
    };
  } finally {
    closeSync(runtime);
  }
}

/** Borrow one fixture FD; remap only in a new process, never over a live parent FD. */
export function runPrivateDescriptorFixture(
  descriptor: number,
  operation: PrivateDescriptorFixtureOperation,
): PrivateDescriptorFixtureResult {
  assert.ok(Number.isSafeInteger(descriptor) && descriptor >= 3, "Invalid parent fixture descriptor");
  const before = provenance();
  const request = requestSchema.parse({ identity: identity(descriptor), operation, provenance: before, version: 1 });
  const encoded = JSON.stringify(request);
  assert.ok(Buffer.byteLength(encoded) <= 4096, "Fixture request exceeds its bound");
  const fixturePath = join(import.meta.dir, "private-descriptor-test-fixture.ts");
  assert.equal(realpathSync(fixturePath), fixturePath, "Fixture entry must be its physical source path");
  const child = spawnSync(realpathSync(process.execPath), [fixturePath, encoded], {
    cwd: join(import.meta.dir, ".."),
    encoding: "utf8",
    env: privateDescriptorFixtureEnvironment(operation, process.env.HOME, homedir(), realpathSync(tmpdir())),
    killSignal: "SIGKILL",
    maxBuffer: 4096,
    stdio: ["ignore", "pipe", "pipe", descriptor],
    // Preserve the cleanup regression's native child budget; protected token
    // and provider-activity reader fixtures retain their narrower deadline.
    timeout: operation.kind === "claude-cleanup" ? 10_000 : 3_000,
  });
  // No child-controlled output or error object is attached to assertion messages.
  assert.ok(child.error === undefined, "Fixture subprocess did not complete within its bounds");
  assert.equal(child.signal, null, "Fixture subprocess ended by signal");
  assert.equal(child.status, 0, `Fixture subprocess refused: ${privateDescriptorFixtureFailureMessage(child.stderr)}`);
  assert.ok(child.stderr === "", "Fixture subprocess emitted diagnostics");
  const result = resultSchema.parse(JSON.parse(child.stdout) as unknown);
  assert.equal(result.kind, operation.kind, "Fixture result belongs to another operation");
  assertPrivateDescriptorFixtureProvenance(provenance(), before);
  return result;
}

function proveClosed(descriptor: number): void {
  let closed = false;
  try { fstatSync(descriptor); } catch (error: unknown) {
    closed = error !== null && typeof error === "object" && "code" in error && error.code === "EBADF";
  }
  assert.ok(closed, "Fixture descriptor was not positively closed");
}

async function runChild(
  stage: (value: FailureStage) => void,
  preserveFailure: (error: unknown) => void,
): Promise<PrivateDescriptorFixtureResult> {
  assert.equal(process.argv.length, 3, "Fixture accepts one bounded protocol argument");
  assert.equal(process.argv[1], join(import.meta.dir, "private-descriptor-test-fixture.ts"), "Foreign fixture entry path");
  const encoded = process.argv[2];
  assert.ok(encoded !== undefined && Buffer.byteLength(encoded) <= 4096, "Invalid fixture request size");
  const request = parsePrivateDescriptorFixtureRequest(JSON.parse(encoded) as unknown);
  stage("provenance");
  assertPrivateDescriptorFixtureProvenance(provenance(), request.provenance);
  stage("descriptor-admission");
  assert.deepEqual(identity(3), request.identity, "Inherited descriptor is not the parent fixture");
  assert.equal(isatty(3), false, "Fixture descriptor must not be a terminal");
  assert.equal(request.identity.uid, process.getuid?.(), "Fixture descriptor has a foreign owner");
  const operation = request.operation;
  if (operation.kind === "claude-cleanup") {
    stage("claude-import");
    const { runClaudeLiveAcceptance } = await import("./claude-live-acceptance");
    let effects = 0;
    const forbidden = (): never => { effects += 1; throw new Error("Fixture forbids worker and provider effects"); };
    try {
      stage("claude-cleanup");
      const result = await runClaudeLiveAcceptance(["--resume-fd", "3"], {
        createLogout: forbidden,
        createReadback: forbidden,
        recoverProcessJournal: async () => undefined,
        sourceAttestation: async () => operation.candidate,
        startWorker: forbidden,
      });
      stage("claude-result");
      assert.equal(result, null, "Fixture cleanup did not complete");
      assert.equal(effects, 0, "Fixture cleanup performed a forbidden effect");
    } catch (error: unknown) {
      preserveFailure(error);
      throw error;
    } finally {
      stage("descriptor-close");
      closeSync(3);
    }
    proveClosed(3);
    return { closure: "fixture", descriptor: 3, effects: 0, kind: operation.kind, outcome: "cleaned", sha256: null, version: 1 };
  }
  stage("alias-import");
  const { readProtectedProviderActivityEvidence, readProtectedVercelAccessToken } = await import("./current-project-alias-release");
  let outcome: "accepted" | "refused" = "accepted";
  let sha256: string | null = null;
  stage("alias-reader");
  try {
    const value = operation.kind === "vercel-token"
      ? readProtectedVercelAccessToken(3, operation.nowSeconds)
      : readProtectedProviderActivityEvidence(3);
    sha256 = createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
  } catch (error: unknown) {
    const expected = operation.kind === "vercel-token" ? "provider_credentials_refused" : "recovery_evidence_invalid";
    assert.ok(error !== null && typeof error === "object" && "code" in error && error.code === expected, "Fixture reader failed outside its refusal contract");
    outcome = "refused";
  }
  stage("descriptor-close");
  proveClosed(3);
  return { closure: "reader", descriptor: 3, effects: 0, kind: operation.kind, outcome, sha256, version: 1 };
}

if (import.meta.main) {
  let stage: FailureStage = "arguments";
  let failure: FixtureFailure | undefined;
  try {
    const result = await runChild(value => { stage = value; }, error => {
      failure ??= privateDescriptorFixtureFailure(error, stage);
    });
    stage = "result";
    process.stdout.write(`${JSON.stringify(resultSchema.parse(result))}\n`);
  } catch (error: unknown) {
    process.stderr.write(`${JSON.stringify(failure ?? privateDescriptorFixtureFailure(error, stage))}\n`);
    process.exitCode = 1;
  }
}
