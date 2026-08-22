import { afterAll, describe, expect, test } from "bun:test";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  inspectInstallationBundle,
  inspectTree,
  performInstallationHandoff,
  resumeCommittedInstallationHandoffCleanup,
  rollbackInstallationHandoff,
  type InstallationHandoffDependencies,
  type InstallationHandoffFaultPoint,
  type InstallationHandoffPaths,
  type StateContinuityEvidence,
} from "../installation-handoff";
import {
  expectedHistoricalOprtePreviewSignature,
  expectedHistoricalOprtePreviewTree,
  historicalOprtePreviewSignaturePolicy,
  strictBundleSignaturePolicy,
} from "../historical-oprte-preview";
import {
  inspectProspectivePathAuthority,
  renameWithPathAuthority,
} from "../installation-path-authority";
import { openControlPlane } from "../src/state/database";

const roots: string[] = [];
const expectedCommit = "0123456789abcdef0123456789abcdef01234567";
const supportedPriorHraIdentities = [
  { build: "8", version: "0.1.7" },
  { build: "9", version: "0.1.8" },
  { build: "10", version: "0.1.9" },
  { build: "11", version: "0.1.10" },
] as const;
const faultPoints: readonly InstallationHandoffFaultPoint[] = [
  "after_full_backup",
  "after_candidate_smoke",
  "after_bundle_archives",
  "after_candidate_staged",
  "after_candidate_installed",
  "after_predecessor_retired",
  "after_continuity_verified",
];
const stateTreeOptions = {
  ignoredRelativePaths: new Set([
    ".control-plane.sqlite.lifetime.lock",
    "control-plane.sqlite-journal",
    "control-plane.sqlite-shm",
    "control-plane.sqlite-wal",
  ]),
} as const;

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

describe("OPRTE to HRA installation handoff", () => {
  test("rolls every deterministic fault checkpoint back to both original apps and exact state", async () => {
    for (const faultPoint of faultPoints) {
      const fixture = await createFixture();
      const stateBefore = await inspectTree(fixture.paths.stateRoot, stateTreeOptions);
      const predecessorBefore = await inspectTree(fixture.paths.predecessorApp);
      const hraBefore = await inspectTree(fixture.paths.canonicalApp);
      let failure: unknown;
      try {
        await performInstallationHandoff({
          backupDirectory: fixture.backupDirectory,
          candidateApp: fixture.paths.candidateApp,
          confirmation: "RETIRE-OPRTE-IN-FAVOR-OF-HRA",
          paths: fixture.paths,
          onCheckpoint(point) {
            if (point === faultPoint) throw new Error(`fault:${point}`);
          },
        }, fixture.dependencies);
      } catch (error: unknown) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(`fault:${faultPoint}`);
      expect(await inspectTree(fixture.paths.stateRoot, stateTreeOptions)).toEqual(stateBefore);
      expect(await inspectTree(fixture.paths.predecessorApp)).toEqual(predecessorBefore);
      expect(await inspectTree(fixture.paths.canonicalApp)).toEqual(hraBefore);
      const receipt = JSON.parse(
        await readFile(join(fixture.backupDirectory, "handoff-receipt.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(receipt["phase"]).toBe("rolled_back");
    }
  }, 120_000);

  test("commits one HRA authority and can explicitly restore the predecessor", async () => {
    const fixture = await createFixture();
    const stateBefore = await inspectTree(fixture.paths.stateRoot, stateTreeOptions);
    const predecessorBefore = await inspectTree(fixture.paths.predecessorApp);
    const priorHraBefore = await inspectTree(fixture.paths.canonicalApp);
    const candidateBefore = await inspectTree(fixture.paths.candidateApp);

    const result = await performInstallationHandoff({
      backupDirectory: fixture.backupDirectory,
      candidateApp: fixture.paths.candidateApp,
      confirmation: "RETIRE-OPRTE-IN-FAVOR-OF-HRA",
      paths: fixture.paths,
    }, fixture.dependencies);

    expect(result.status).toBe("committed");
    expect(lstat(fixture.paths.predecessorApp)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await inspectTree(fixture.paths.canonicalApp)).toEqual(candidateBefore);
    expect(await inspectTree(fixture.paths.stateRoot, stateTreeOptions)).toEqual(stateBefore);
    const receipt = JSON.parse(
      await readFile(join(fixture.backupDirectory, "handoff-receipt.json"), "utf8"),
    ) as { state: StateContinuityEvidence };
    expect(receipt.state).toMatchObject({
      accountHomes: 1,
      chatWorktreeLanes: 1,
      dispatchWorktreeLanes: 1,
      harnessWorktreeLanes: 1,
      localTaskWorktreeLanes: 1,
      sessionEntries: 1,
    });
    expect(receipt.state.database.rows).toHaveProperty("account_profiles");
    expect(receipt.state.database.rows).toHaveProperty("chat_panes");
    expect(receipt.state.database.rows).toHaveProperty("harness_actor_session_bindings");
    expect(await inspectTree(join(fixture.backupDirectory, "predecessor.bundle")))
      .toEqual(predecessorBefore);

    const rollback = await rollbackInstallationHandoff({
      backupDirectory: fixture.backupDirectory,
      confirmation: "ROLL-BACK-HRA-TO-OPRTE",
      paths: {
        ...fixture.paths,
        candidateApp: join(fixture.backupDirectory, "unused-candidate.app"),
      },
    }, fixture.dependencies);

    expect(rollback.status).toBe("rolled_back");
    expect(await inspectTree(fixture.paths.predecessorApp)).toEqual(predecessorBefore);
    expect(await inspectTree(fixture.paths.canonicalApp)).toEqual(priorHraBefore);
    expect(await inspectTree(fixture.paths.stateRoot, stateTreeOptions)).toEqual(stateBefore);
  }, 60_000);

  test("accepts and restores every supported prior HRA release identity", async () => {
    for (const priorHra of supportedPriorHraIdentities) {
      const fixture = await createFixture({ priorHra });
      const priorHraBefore = await inspectTree(fixture.paths.canonicalApp);
      await performInstallationHandoff({
        backupDirectory: fixture.backupDirectory,
        candidateApp: fixture.paths.candidateApp,
        confirmation: "RETIRE-OPRTE-IN-FAVOR-OF-HRA",
        paths: fixture.paths,
      }, fixture.dependencies);
      const receipt = JSON.parse(
        await readFile(join(fixture.backupDirectory, "handoff-receipt.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(receipt).toMatchObject({
        hadPriorHra: true,
        priorHra: { identity: priorHra },
      });
      await rollbackInstallationHandoff({
        backupDirectory: fixture.backupDirectory,
        confirmation: "ROLL-BACK-HRA-TO-OPRTE",
        paths: fixture.paths,
      }, fixture.dependencies);
      expect(await inspectTree(fixture.paths.canonicalApp)).toEqual(priorHraBefore);
    }
  }, 60_000);

  test("routes every predecessor archive, stage, restore, and deletion through the historical policy", async () => {
    const fixture = await createFixture();
    const inspections: Array<Readonly<{
      executable: string;
      path: string;
      policy: string;
    }>> = [];
    const dependencies: InstallationHandoffDependencies = {
      ...fixture.dependencies,
      async inspectBundle(path, policy) {
        const inspected = await fixture.dependencies.inspectBundle(path, policy);
        inspections.push({
          executable: inspected.identity.executable,
          path,
          policy,
        });
        return inspected;
      },
    };
    const result = await performInstallationHandoff({
      backupDirectory: fixture.backupDirectory,
      candidateApp: fixture.paths.candidateApp,
      confirmation: "RETIRE-OPRTE-IN-FAVOR-OF-HRA",
      paths: fixture.paths,
    }, dependencies);
    await rollbackInstallationHandoff({
      backupDirectory: fixture.backupDirectory,
      confirmation: "ROLL-BACK-HRA-TO-OPRTE",
      paths: fixture.paths,
    }, dependencies);

    const faultFixture = await createFixture();
    const faultInspections: typeof inspections = [];
    const faultDependencies: InstallationHandoffDependencies = {
      ...faultFixture.dependencies,
      async inspectBundle(path, policy) {
        const inspected = await faultFixture.dependencies.inspectBundle(path, policy);
        faultInspections.push({
          executable: inspected.identity.executable,
          path,
          policy,
        });
        return inspected;
      },
    };
    expect(performInstallationHandoff({
      backupDirectory: faultFixture.backupDirectory,
      candidateApp: faultFixture.paths.candidateApp,
      confirmation: "RETIRE-OPRTE-IN-FAVOR-OF-HRA",
      paths: faultFixture.paths,
      onCheckpoint(point) {
        if (point === "after_predecessor_retired") {
          throw new Error("exercise rollback-stage deletion");
        }
      },
    }, faultDependencies)).rejects.toThrow("exercise rollback-stage deletion");
    const faultReceipt = JSON.parse(
      await readFile(
        join(faultFixture.backupDirectory, "handoff-receipt.json"),
        "utf8",
      ),
    ) as { operationId: string };

    const allInspections = [...inspections, ...faultInspections];
    expect(allInspections.some(value => value.executable === "oprte")).toBeTrue();
    expect(allInspections.some(value => value.executable === "hra")).toBeTrue();
    for (const inspection of allInspections) {
      expect(inspection.policy).toBe(
        inspection.executable === "oprte"
          ? historicalOprtePreviewSignaturePolicy
          : strictBundleSignaturePolicy,
      );
    }

    const historicalCount = (
      ledger: typeof inspections,
      expectedPath: string,
    ): number => ledger.filter(inspection =>
      inspection.path === expectedPath
      && inspection.policy === historicalOprtePreviewSignaturePolicy
    ).length;
    const predecessorArchive = join(
      fixture.backupDirectory,
      "predecessor.bundle",
    );
    const predecessorRetirementStage = join(
      fixture.paths.applicationsDirectory,
      `.${result.operationId}.predecessor.bundle`,
    );
    const predecessorRestoreStage = join(
      fixture.paths.applicationsDirectory,
      `.${result.operationId}.OPRTE.app.restore.bundle`,
    );
    expect(historicalCount(inspections, fixture.paths.predecessorApp)).toBeGreaterThanOrEqual(3);
    expect(historicalCount(inspections, predecessorArchive)).toBeGreaterThanOrEqual(2);
    expect(historicalCount(inspections, predecessorRetirementStage)).toBeGreaterThanOrEqual(2);
    expect(historicalCount(inspections, predecessorRestoreStage)).toBeGreaterThanOrEqual(1);

    const faultRetirementStage = join(
      faultFixture.paths.applicationsDirectory,
      `.${faultReceipt.operationId}.predecessor.bundle`,
    );
    const faultRestoreStage = join(
      faultFixture.paths.applicationsDirectory,
      `.${faultReceipt.operationId}.OPRTE.app.restore.bundle`,
    );
    expect(historicalCount(
      faultInspections,
      faultRetirementStage,
    )).toBeGreaterThanOrEqual(3);
    expect(historicalCount(
      faultInspections,
      faultRestoreStage,
    )).toBeGreaterThanOrEqual(1);
  }, 60_000);

  test("rejects tagged-only v0.1.11 and current v0.1.12 as unreceipted prior HRA authority", async () => {
    for (const identity of [
      { build: "12", version: "0.1.11" },
      { build: "13", version: "0.1.12" },
    ] as const) {
      const fixture = await createFixture({ priorHra: false });
      await createBundle(fixture.paths.canonicalApp, {
        ...identity,
        executable: "hra",
        marker: "unreceipted-candidate",
      });
      expect(performInstallationHandoff({
        backupDirectory: fixture.backupDirectory,
        candidateApp: fixture.paths.candidateApp,
        confirmation: "RETIRE-OPRTE-IN-FAVOR-OF-HRA",
        paths: fixture.paths,
      }, fixture.dependencies)).rejects.toMatchObject({ code: "candidate_invalid" });
    }
  });

  test("fails closed when a Keychain item changes during the cutover", async () => {
    const fixture = await createFixture();
    let reads = 0;
    const dependencies: InstallationHandoffDependencies = {
      ...fixture.dependencies,
      keychainRead() {
        reads += 1;
        return Promise.resolve(reads <= 5 ? "before-secret" : "after-secret");
      },
    };
    expect(performInstallationHandoff({
      backupDirectory: fixture.backupDirectory,
      candidateApp: fixture.paths.candidateApp,
      confirmation: "RETIRE-OPRTE-IN-FAVOR-OF-HRA",
      paths: fixture.paths,
    }, dependencies)).rejects.toMatchObject({ code: "continuity_failed" });
    await lstat(fixture.paths.predecessorApp);
    await lstat(fixture.paths.canonicalApp);
  });

  test("rejects symlinked control-plane and SQLite sidecar authority before backup", async () => {
    for (const suffix of ["", "-journal", "-shm", "-wal"] as const) {
      const fixture = await createFixture();
      const sqlitePath = `${fixture.paths.controlPlanePath}${suffix}`;
      const externalPath = join(
        dirname(fixture.paths.stateRoot),
        `external-control-plane${suffix || ".sqlite"}`,
      );
      if (suffix === "") {
        await rename(sqlitePath, externalPath);
      } else {
        await rm(sqlitePath, { force: true });
        await writeFile(externalPath, "external sidecar\n", { mode: 0o600 });
      }
      await symlink(externalPath, sqlitePath);

      expect(performInstallationHandoff({
        backupDirectory: fixture.backupDirectory,
        candidateApp: fixture.paths.candidateApp,
        confirmation: "RETIRE-OPRTE-IN-FAVOR-OF-HRA",
        paths: fixture.paths,
      }, fixture.dependencies)).rejects.toMatchObject({ code: "filesystem_unsafe" });
      expect(await Bun.file(externalPath).exists()).toBe(true);
      expect(await Bun.file(join(fixture.backupDirectory, "state")).exists()).toBe(false);
    }
  }, 60_000);

  test("resumes committed cleanup idempotently after either interruption", async () => {
    const fixture = await createFixture();
    const candidateBefore = await inspectTree(fixture.paths.candidateApp);
    let failure: unknown;
    try {
      await performInstallationHandoff({
        backupDirectory: fixture.backupDirectory,
        candidateApp: fixture.paths.candidateApp,
        confirmation: "RETIRE-OPRTE-IN-FAVOR-OF-HRA",
        paths: fixture.paths,
        onCheckpoint(point) {
          if (point === "after_authority_committed") throw new Error("cleanup fault");
        },
      }, fixture.dependencies);
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(await inspectTree(fixture.paths.canonicalApp)).toEqual(candidateBefore);
    expect(lstat(fixture.paths.predecessorApp)).rejects.toMatchObject({ code: "ENOENT" });
    const receipt = JSON.parse(
      await readFile(join(fixture.backupDirectory, "handoff-receipt.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(receipt["phase"]).toBe("committed");
    const operationId = String(receipt["operationId"]);
    const predecessorStage = join(
      fixture.paths.applicationsDirectory,
      `.${operationId}.predecessor.bundle`,
    );
    const priorHraStage = join(
      fixture.paths.applicationsDirectory,
      `.${operationId}.candidate.bundle`,
    );
    await lstat(predecessorStage);
    await lstat(priorHraStage);

    expect(resumeCommittedInstallationHandoffCleanup({
      backupDirectory: fixture.backupDirectory,
      confirmation: "CLEAN-COMMITTED-HRA-HANDOFF-STAGING",
      paths: fixture.paths,
      onCheckpoint(point) {
        if (point === "after_committed_predecessor_cleanup") {
          throw new Error("resume interruption");
        }
      },
    }, fixture.dependencies)).rejects.toThrow("resume interruption");
    expect(lstat(predecessorStage)).rejects.toMatchObject({ code: "ENOENT" });
    await lstat(priorHraStage);

    const cleanup = await resumeCommittedInstallationHandoffCleanup({
      backupDirectory: fixture.backupDirectory,
      confirmation: "CLEAN-COMMITTED-HRA-HANDOFF-STAGING",
      paths: fixture.paths,
    }, fixture.dependencies);
    expect(cleanup).toEqual({ operationId, status: "clean" });
    expect(lstat(predecessorStage)).rejects.toMatchObject({ code: "ENOENT" });
    expect(lstat(priorHraStage)).rejects.toMatchObject({ code: "ENOENT" });

    expect(await resumeCommittedInstallationHandoffCleanup({
      backupDirectory: fixture.backupDirectory,
      confirmation: "CLEAN-COMMITTED-HRA-HANDOFF-STAGING",
      paths: fixture.paths,
    }, fixture.dependencies)).toEqual({ operationId, status: "clean" });
    expect(await inspectTree(fixture.paths.canonicalApp)).toEqual(candidateBefore);
  });

  test("publishes the predecessor before touching canonical HRA during rollback", async () => {
    const fixture = await createFixture();
    const candidateBefore = await inspectTree(fixture.paths.candidateApp);
    const predecessorBefore = await inspectTree(fixture.paths.predecessorApp);
    const priorHraBefore = await inspectTree(fixture.paths.canonicalApp);
    await performInstallationHandoff({
      backupDirectory: fixture.backupDirectory,
      candidateApp: fixture.paths.candidateApp,
      confirmation: "RETIRE-OPRTE-IN-FAVOR-OF-HRA",
      paths: fixture.paths,
    }, fixture.dependencies);

    let failure: unknown;
    try {
      await rollbackInstallationHandoff({
        backupDirectory: fixture.backupDirectory,
        confirmation: "ROLL-BACK-HRA-TO-OPRTE",
        paths: fixture.paths,
        onCheckpoint(point) {
          if (point === "after_rollback_predecessor_published") {
            throw new Error("rollback interruption");
          }
        },
      }, fixture.dependencies);
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(await inspectTree(fixture.paths.predecessorApp)).toEqual(predecessorBefore);
    expect(await inspectTree(fixture.paths.canonicalApp)).toEqual(candidateBefore);

    await rollbackInstallationHandoff({
      backupDirectory: fixture.backupDirectory,
      confirmation: "ROLL-BACK-HRA-TO-OPRTE",
      paths: fixture.paths,
    }, fixture.dependencies);
    expect(await inspectTree(fixture.paths.predecessorApp)).toEqual(predecessorBefore);
    expect(await inspectTree(fixture.paths.canonicalApp)).toEqual(priorHraBefore);
  }, 60_000);

  test("ordinary rollback refuses after post-cutover state changes", async () => {
    const fixture = await createFixture();
    const candidateBefore = await inspectTree(fixture.paths.candidateApp);
    await performInstallationHandoff({
      backupDirectory: fixture.backupDirectory,
      candidateApp: fixture.paths.candidateApp,
      confirmation: "RETIRE-OPRTE-IN-FAVOR-OF-HRA",
      paths: fixture.paths,
    }, fixture.dependencies);
    await writeFile(join(fixture.paths.stateRoot, "post-cutover-change.txt"), "new state\n");
    let failure: unknown;
    try {
      await rollbackInstallationHandoff({
        backupDirectory: fixture.backupDirectory,
        confirmation: "ROLL-BACK-HRA-TO-OPRTE",
        paths: fixture.paths,
      }, fixture.dependencies);
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "continuity_failed" });
    expect(await inspectTree(fixture.paths.canonicalApp)).toEqual(candidateBefore);
    expect(lstat(fixture.paths.predecessorApp)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("restores a predecessor-only installation without inventing prior HRA", async () => {
    const fixture = await createFixture({ priorHra: false });
    const predecessorBefore = await inspectTree(fixture.paths.predecessorApp);
    await performInstallationHandoff({
      backupDirectory: fixture.backupDirectory,
      candidateApp: fixture.paths.candidateApp,
      confirmation: "RETIRE-OPRTE-IN-FAVOR-OF-HRA",
      paths: fixture.paths,
    }, fixture.dependencies);
    await rollbackInstallationHandoff({
      backupDirectory: fixture.backupDirectory,
      confirmation: "ROLL-BACK-HRA-TO-OPRTE",
      paths: fixture.paths,
    }, fixture.dependencies);
    expect(await inspectTree(fixture.paths.predecessorApp)).toEqual(predecessorBefore);
    expect(lstat(fixture.paths.canonicalApp)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("the frozen tree proof detects resource, executable, nested-code, symlink, and mode tampering", async () => {
    const mutations = [
      ["resource", async (root: string) => {
        await writeFile(join(root, "Contents", "Resources", "resource.txt"), "changed\n");
      }],
      ["executable", async (root: string) => {
        await writeFile(join(root, "Contents", "MacOS", "oprte"), "changed\n", {
          mode: 0o755,
        });
      }],
      ["nested helper", async (root: string) => {
        await writeFile(
          join(root, "Contents", "Resources", "runtime", "helper"),
          "changed\n",
          { mode: 0o755 },
        );
      }],
      ["symlink", async (root: string) => {
        const path = join(root, "Contents", "Frameworks", "Current");
        await rm(path);
        await symlink("Versions/C", path);
      }],
      ["mode", async (root: string) => {
        await chmod(join(root, "Contents", "Resources", "runtime", "helper"), 0o700);
      }],
    ] as const;

    for (const [label, mutate] of mutations) {
      const root = await createTreeTamperFixture();
      const before = await inspectTree(root);
      await mutate(root);
      expect((await inspectTree(root)).digest, label).not.toBe(before.digest);
    }
  });

});

async function createTreeTamperFixture(): Promise<string> {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "hra-installation-tree-tamper-test-")),
  );
  roots.push(parent);
  const root = join(parent, "OPRTE.app");
  await mkdir(join(root, "Contents", "MacOS"), { recursive: true });
  await mkdir(join(root, "Contents", "Resources", "runtime"), { recursive: true });
  await mkdir(join(root, "Contents", "Frameworks", "Versions", "B"), {
    recursive: true,
  });
  await writeFile(join(root, "Contents", "MacOS", "oprte"), "executable\n", {
    mode: 0o755,
  });
  await writeFile(join(root, "Contents", "Resources", "resource.txt"), "resource\n");
  await writeFile(
    join(root, "Contents", "Resources", "runtime", "helper"),
    "helper\n",
    { mode: 0o755 },
  );
  await symlink("Versions/B", join(root, "Contents", "Frameworks", "Current"));
  return root;
}

async function createFixture(
  options: Readonly<{
    priorHra?: false | (typeof supportedPriorHraIdentities)[number];
  }> = {},
): Promise<Readonly<{
  backupDirectory: string;
  dependencies: InstallationHandoffDependencies;
  paths: InstallationHandoffPaths;
}>> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "hra-installation-handoff-test-")),
  );
  roots.push(root);
  const applicationsDirectory = join(root, "Applications");
  const stateRoot = join(root, "home", "Library", "Application Support", "OPRTE");
  const candidateApp = join(root, "candidate", "HRA.app");
  await mkdir(applicationsDirectory, { recursive: true, mode: 0o700 });
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await chmod(stateRoot, 0o700);
  await createBundle(join(applicationsDirectory, "OPRTE.app"), {
    build: "5",
    executable: "oprte",
    marker: "predecessor",
    version: "0.1.4",
  });
  const priorHra = options.priorHra === undefined
    ? supportedPriorHraIdentities[3]
    : options.priorHra;
  if (priorHra !== false) {
    await createBundle(join(applicationsDirectory, "HRA.app"), {
      build: priorHra.build,
      executable: "hra",
      marker: "prior-hra",
      version: priorHra.version,
    });
  }
  await createBundle(candidateApp, {
    build: "13",
    executable: "hra",
    marker: "candidate",
    version: "0.1.12",
  });
  const controlPlanePath = join(stateRoot, "control-plane.sqlite");
  const database = openControlPlane(controlPlanePath, {
    releaseIdentity: priorHra === false
      ? { version: "0.1.10", build: 11 }
      : { version: priorHra.version, build: Number(priorHra.build) },
    now: () => 1_786_934_400_000,
  });
  database.close();
  await mkdir(join(stateRoot, "codex", "accounts", "profile_a", "home", "sessions"), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(
    join(stateRoot, "codex", "accounts", "profile_a", "home", "sessions", "session.jsonl"),
    "fixture-session\n",
    { mode: 0o600 },
  );
  for (const path of [
    join(stateRoot, "dispatch", "worktrees", "lane_dispatch"),
    join(stateRoot, "local-task-worktrees", "lane_local"),
    join(stateRoot, "harness", "v1", "worktrees", "lane_harness"),
    join(stateRoot, "chat-worktrees", "lane_chat"),
  ]) await mkdir(path, { recursive: true, mode: 0o700 });

  const paths: InstallationHandoffPaths = {
    applicationsDirectory,
    candidateApp,
    canonicalApp: join(applicationsDirectory, "HRA.app"),
    predecessorApp: join(applicationsDirectory, "OPRTE.app"),
    stateRoot,
    controlPlanePath,
    nativeInstanceLockPath: join(dirname(stateRoot), ".Hraness Kitchen.native-instance.lock"),
    updateHazardPath: join(dirname(stateRoot), ".Hraness Kitchen.update-hazard-v1.json"),
    updateHazardTemporaryPath: join(dirname(stateRoot), ".Hraness Kitchen.update-hazard-v1.json.tmp"),
    sparkleCacheRoots: [],
  };
  const dependencies: InstallationHandoffDependencies = {
    acquireControlPlaneLock() {
      return {
        path: join(stateRoot, ".control-plane.sqlite.lifetime.lock"),
        bindControlPlane: () => ({
          controlPlanePath,
          stateRoot: { device: "1", inode: "1" },
          controlPlane: { device: "1", inode: "2" },
        }),
        release() {},
      };
    },
    acquireNativeLock: () => ({ release() {} }),
    async copyTree(source, destination) {
      await mkdir(dirname(destination), { recursive: true });
      await cp(source, destination, {
        recursive: true,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      });
    },
    async inspectBundle(path, signaturePolicy) {
      const inspected = await inspectInstallationBundle(
        path,
        strictBundleSignaturePolicy,
      );
      if (inspected.identity.executable === "oprte") {
        if (signaturePolicy !== historicalOprtePreviewSignaturePolicy) {
          throw new Error("Fixture predecessor requires historical policy.");
        }
        return {
          ...inspected,
          signature: expectedHistoricalOprtePreviewSignature,
          tree: expectedHistoricalOprtePreviewTree,
        };
      }
      if (signaturePolicy !== strictBundleSignaturePolicy) {
        throw new Error("Fixture HRA requires strict policy.");
      }
      return inspected;
    },
    keychainRead: () => Promise.resolve(null),
    now: () => 1_786_934_400_000,
    openFilesAreQuiescent: () => Promise.resolve(true),
    async publishBundle(source, destination, exchange) {
      await renameWithPathAuthority(
        await inspectProspectivePathAuthority(source, "test source"),
        await inspectProspectivePathAuthority(destination, "test destination"),
        { exchange },
      );
    },
    quitApplications: () => Promise.resolve(),
    randomBytes: (length) => new Uint8Array(length).fill(7),
    smokeCandidate: () => Promise.resolve(),
    updaterIsQuiescent: () => Promise.resolve(true),
    verifyCandidate: () => Promise.resolve({ commit: expectedCommit }),
  };
  return {
    backupDirectory: join(root, "backup"),
    dependencies,
    paths,
  };
}

async function createBundle(
  path: string,
  identity: Readonly<{
    build: string;
    executable: string;
    marker: string;
    version: string;
  }>,
): Promise<void> {
  const contents = join(path, "Contents");
  const macos = join(contents, "MacOS");
  const resources = join(contents, "Resources");
  await mkdir(macos, { recursive: true, mode: 0o755 });
  await mkdir(resources, { recursive: true, mode: 0o755 });
  await writeFile(join(macos, identity.executable), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(join(resources, "marker.txt"), `${identity.marker}\n`);
  await writeFile(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>${identity.executable === "hra" ? "HRA" : "OPRTE"}</string>
<key>CFBundleExecutable</key><string>${identity.executable}</string>
<key>CFBundleIdentifier</key><string>kitchen.hraness</string>
<key>CFBundleName</key><string>${identity.executable === "hra" ? "HRA" : "OPRTE"}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${identity.version}</string>
<key>CFBundleVersion</key><string>${identity.build}</string>
</dict></plist>
`);
  const child = Bun.spawn([
    "/usr/bin/codesign",
    "--force",
    "--deep",
    "--sign",
    "-",
    path,
  ], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`Fixture code signing failed: ${stderr}`);
}
