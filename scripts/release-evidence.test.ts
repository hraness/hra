import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { closeSync, openSync, renameSync } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalDigest,
  canonicalJson,
  deployEvidenceSchema,
  HRA_CONVEX_PROJECT_ID,
  HRA_CONVEX_TEAM_ID,
  liveAcceptanceEvidenceDocumentSchema,
  readProtectedJson,
  withSelfDigest,
  writeProtectedJsonNoReplace,
  writeProtectedJsonToFd,
} from "./release-evidence";

const roots: string[] = [];

const makeRoot = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hra-release-evidence-test-")));
  await chmod(root, 0o700);
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { force: true, recursive: true });
  }));
});

const liveEvidence = () => withSelfDigest({
  completedAt: 200,
  deployEvidenceDigest: "3".repeat(64),
  evidenceDigest: "1".repeat(64),
  kind: "live-acceptance" as const,
  packageVersion: "0.1.0" as const,
  runId: "00000000-0000-4000-8000-000000000001",
  runtimeRevision: "00000000-0000-4000-8000-000000000002",
  schemaVersion: 1 as const,
  sourceCommit: "a".repeat(40),
  startedAt: 100,
  status: "passed" as const,
  targetDigest: "2".repeat(64),
});

describe("release evidence canonicalization", () => {
  test("sorts object keys recursively while preserving array order", () => {
    expect(canonicalJson({ z: [{ b: 2, a: 1 }], a: true }))
      .toBe('{"a":true,"z":[{"a":1,"b":2}]}');
    expect(canonicalDigest({ b: 2, a: 1 })).toBe(canonicalDigest({ a: 1, b: 2 }));
    expect(canonicalDigest([1, 2])).not.toBe(canonicalDigest([2, 1]));
    expect(canonicalJson({ Ω: 6, é: 5, a: 4, _: 3, A: 2, "!": 1 }))
      .toBe('{"!":1,"A":2,"_":3,"a":4,"é":5,"Ω":6}');
  });

  test("rejects incoherent chained deploy evidence even with a valid self digest", () => {
    const target = {
      deploymentId: 5_089_017,
      deploymentName: "qualified-hummingbird-537",
      deploymentUrl: "https://qualified-hummingbird-537.convex.cloud",
      projectId: HRA_CONVEX_PROJECT_ID,
      teamId: HRA_CONVEX_TEAM_ID,
    } as const;
    const invalid = withSelfDigest({
      after: {
        bound: true as const,
        deployedAtMs: 100,
        previousDeployDigest: null,
        runtimeRevision: "00000000-0000-4000-8000-000000000001",
        runtimeSourceCommit: "b".repeat(40),
        schemaIdentity: "hra-release-attestation-v1" as const,
        schemaVersion: 1 as const,
      },
      before: null,
      kind: "convex-deploy" as const,
      overlaySha256: "3".repeat(64),
      phase: "bootstrap" as const,
      previousDeployDigest: null,
      schemaVersion: 1 as const,
      sourceCommit: "a".repeat(40),
      target,
      targetDigest: canonicalDigest(target),
    });
    expect(deployEvidenceSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("protected release evidence custody", () => {
  test("publishes once, proves exact readback, and permits only exact replay", async () => {
    const root = await makeRoot();
    const path = join(root, "nested", "evidence.json");
    const evidence = liveEvidence();

    expect(writeProtectedJsonNoReplace(
      path,
      evidence,
      liveAcceptanceEvidenceDocumentSchema,
      { allowExactReplay: true },
    )).toEqual({ path, replayed: false });
    expect(readProtectedJson(path, liveAcceptanceEvidenceDocumentSchema)).toEqual(evidence);
    expect(await readFile(path, "utf8")).toBe(`${canonicalJson(evidence)}\n`);
    const metadata = await lstat(path);
    expect(metadata.mode & 0o777).toBe(0o600);
    expect(metadata.nlink).toBe(1);
    expect(writeProtectedJsonNoReplace(
      path,
      evidence,
      liveAcceptanceEvidenceDocumentSchema,
      { allowExactReplay: true },
    )).toEqual({ path, replayed: true });
    const { selfDigest: oldDigest, ...unsigned } = evidence;
    expect(oldDigest).toHaveLength(64);
    expect(() => writeProtectedJsonNoReplace(
      path,
      withSelfDigest({ ...unsigned, completedAt: 201 }),
      liveAcceptanceEvidenceDocumentSchema,
      { allowExactReplay: true },
    )).toThrow();
  });

  test("refuses symlink, permissive directory, permissive file, and multiply-linked file", async () => {
    const root = await makeRoot();
    const protectedDirectory = join(root, "protected");
    await mkdir(protectedDirectory, { mode: 0o700 });
    const actual = join(protectedDirectory, "actual.json");
    await writeFile(actual, `${canonicalJson(liveEvidence())}\n`, { mode: 0o600 });
    expect(() => readProtectedJson(
      join(protectedDirectory, "missing.json"),
      liveAcceptanceEvidenceDocumentSchema,
    )).toThrow("evidence_not_found");

    const linked = join(protectedDirectory, "linked.json");
    await link(actual, linked);
    expect(() => readProtectedJson(actual, liveAcceptanceEvidenceDocumentSchema))
      .toThrow("evidence_file_invalid");
    await rm(linked);

    await chmod(actual, 0o644);
    expect(() => readProtectedJson(actual, liveAcceptanceEvidenceDocumentSchema))
      .toThrow("evidence_file_invalid");
    await chmod(actual, 0o600);

    const symbolic = join(protectedDirectory, "symbolic.json");
    await symlink(actual, symbolic);
    expect(() => readProtectedJson(symbolic, liveAcceptanceEvidenceDocumentSchema))
      .toThrow("evidence_file_invalid");

    await chmod(protectedDirectory, 0o755);
    expect(() => readProtectedJson(actual, liveAcceptanceEvidenceDocumentSchema))
      .toThrow("evidence_directory_invalid");
  });

  test("refuses a mode-private evidence directory with a dangerous Darwin ACL", async () => {
    if (process.platform !== "darwin") return;
    const root = await makeRoot();
    const protectedDirectory = join(root, "acl-protected");
    await mkdir(protectedDirectory, { mode: 0o700 });
    const evidencePath = join(protectedDirectory, "evidence.json");
    await writeFile(evidencePath, `${canonicalJson(liveEvidence())}\n`, { mode: 0o600 });
    const acl = spawnSync("/bin/chmod", [
      "+a",
      "everyone allow list,search,add_file,add_subdirectory,delete_child,file_inherit,directory_inherit",
      protectedDirectory,
    ], { encoding: "utf8" });
    expect(acl.status).toBe(0);
    expect(() => readProtectedJson(evidencePath, liveAcceptanceEvidenceDocumentSchema))
      .toThrow("evidence_directory_invalid");
  });

  test("writes a preopened empty protected descriptor and refuses a nonempty replay", async () => {
    const root = await makeRoot();
    const path = join(root, "descriptor.json");
    const descriptor = openSync(path, "wx+", 0o600);
    try {
      writeProtectedJsonToFd(descriptor, liveEvidence(), liveAcceptanceEvidenceDocumentSchema);
      expect(() => writeProtectedJsonToFd(
        descriptor,
        liveEvidence(),
        liveAcceptanceEvidenceDocumentSchema,
      )).toThrow("evidence_descriptor_not_empty");
    } finally {
      closeSync(descriptor);
    }
    expect(readProtectedJson(path, liveAcceptanceEvidenceDocumentSchema)).toEqual(liveEvidence());
  });

  test("recovers an exact interrupted no-replace publication and refuses parent replacement", async () => {
    const root = await makeRoot();
    const interrupted = join(root, "interrupted.json");
    const temporary = join(root, ".interrupted.json.0123456789abcdef0123456789abcdef.tmp");
    await writeFile(temporary, `${canonicalJson(liveEvidence())}\n`, { mode: 0o600 });
    await link(temporary, interrupted);
    expect((await lstat(interrupted)).nlink).toBe(2);
    expect(writeProtectedJsonNoReplace(
      interrupted,
      liveEvidence(),
      liveAcceptanceEvidenceDocumentSchema,
      { allowExactReplay: true },
    )).toEqual({ path: interrupted, replayed: true });
    expect((await lstat(interrupted)).nlink).toBe(1);
    expect(await Bun.file(temporary).exists()).toBeFalse();

    const interruptedRead = join(root, "interrupted-read.json");
    const readTemporary = join(
      root,
      ".interrupted-read.json.0123456789abcdef0123456789abcdef.tmp",
    );
    await writeFile(readTemporary, `${canonicalJson(liveEvidence())}\n`, { mode: 0o600 });
    await link(readTemporary, interruptedRead);
    expect(() => readProtectedJson(
      interruptedRead,
      liveAcceptanceEvidenceDocumentSchema,
    )).toThrow("evidence_file_invalid");
    expect(readProtectedJson(
      interruptedRead,
      liveAcceptanceEvidenceDocumentSchema,
      { recoverInterruptedPublication: true },
    )).toEqual(liveEvidence());
    expect((await lstat(interruptedRead)).nlink).toBe(1);
    expect(await Bun.file(readTemporary).exists()).toBeFalse();

    const protectedDirectory = join(root, "replaceable");
    await mkdir(protectedDirectory, { mode: 0o700 });
    const replacement = join(root, "replacement");
    await mkdir(replacement, { mode: 0o700 });
    const replacementRead = join(protectedDirectory, "read.json");
    await writeFile(replacementRead, `${canonicalJson(liveEvidence())}\n`, { mode: 0o600 });
    expect(() => readProtectedJson(
      replacementRead,
      liveAcceptanceEvidenceDocumentSchema,
      {
        boundary: () => {
          const held = `${protectedDirectory}.held`;
          renameSync(protectedDirectory, held);
          renameSync(replacement, protectedDirectory);
        },
      },
    )).toThrow("evidence_directory_changed");

    const writeDirectory = join(root, "write-replaceable");
    const writeReplacement = join(root, "write-replacement");
    await mkdir(writeDirectory, { mode: 0o700 });
    await mkdir(writeReplacement, { mode: 0o700 });
    const replacementWrite = join(writeDirectory, "write.json");
    expect(() => writeProtectedJsonNoReplace(
      replacementWrite,
      liveEvidence(),
      liveAcceptanceEvidenceDocumentSchema,
      {
        boundary: () => {
          renameSync(writeDirectory, `${writeDirectory}.held`);
          renameSync(writeReplacement, writeDirectory);
        },
      },
    )).toThrow("evidence_directory_changed");
    expect(await Bun.file(replacementWrite).exists()).toBeFalse();
  });
});
