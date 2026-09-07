import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { DaemonAuthorityReceipt } from "../src/daemon/daemon-lock";
import type { DaemonIdentity } from "../src/daemon/daemon-startup";
import {
  assertCompleteGitHistoryPublic,
  buildGitHistoryEnvironment,
  gitHistoryCommandArguments,
  normalizeGitHistoryPatchForPublicScan,
  normalizeReviewedSyntheticHistoryPatch,
  packageDependencyCacheDiscoveryEnvironment,
  parsePackageDependencyCache,
  parseGitHistoryCommitList,
  projectGitHistorySpawnResult,
  requireGitHistoryOutput,
  runPackageCommand,
  waitForOwnedInstalledDaemonReady,
  withPackageDependencyCacheCustody,
} from "./check-package";
import { assertPublicSensitiveText, assertPublicText } from "./public-text-policy";
import {
  assertPseudoTerminalSuccess,
  PTY_BEGIN_MARKER,
  pseudoTerminalScriptArguments,
  runInPseudoTerminal,
} from "./pty-acceptance";

const identity = (pid: number): DaemonIdentity => ({
  bootId: `boot_${"a".repeat(32)}`,
  generation: 1,
  nonce: "10000000-0000-4000-8000-000000000001",
  pid,
  protocol: "hra-control-plane-local-v2",
});

const receipt = (pid: number): DaemonAuthorityReceipt => ({
  acquiredAt: 0,
  bootId: `boot_${"a".repeat(32)}`,
  generation: 1,
  nonce: "10000000-0000-4000-8000-000000000001",
  pid,
  protocol: "hra-control-plane-local-v2",
  state: "ready",
  updatedAt: 0,
  version: 2,
});

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const hostilePtyProcessTreeSource = (overflow: boolean): string => {
  const leafSource = `
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => undefined);
setInterval(() => undefined, 1000);
`;
  const childSource = `
const { spawn } = require("node:child_process");
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => undefined);
const leaf = spawn(process.execPath, ["-e", ${JSON.stringify(leafSource)}], { stdio: "ignore" });
if (leaf.pid === undefined) process.exit(80);
process.stdout.write(String(leaf.pid) + "\\n");
setInterval(() => undefined, 1000);
`;
  return `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => undefined);
const child = spawn(process.execPath, ["-e", ${JSON.stringify(childSource)}], { stdio: ["ignore", "pipe", "ignore"] });
if (child.pid === undefined) process.exit(81);
child.stdout.once("data", (chunk) => {
  const leafPid = Number(chunk.toString("utf8").trim());
  if (!Number.isSafeInteger(leafPid) || leafPid <= 1) process.exit(82);
  writeFileSync(process.env.HRA_HOSTILE_PID_FILE, JSON.stringify([process.pid, child.pid, leafPid]));
  process.stdout.write("hostile-ready\\n");
  ${overflow ? "process.stdout.write(Buffer.alloc(2 * 1024 * 1024, 0x78));" : ""}
});
setInterval(() => undefined, 1000);
`;
};

const historyFixtureChildTimeoutMs = 5_000;
const createHistoryRenderingBudget = (now: () => number = () => performance.now()) => {
  const deadline = now() + 20_000;
  return (): number => {
    const remaining = Math.floor(deadline - now());
    if (remaining < 1) throw new Error("Git history rendering fixture exhausted its time budget.");
    return Math.min(historyFixtureChildTimeoutMs, remaining);
  };
};
const historyFixtureSpawnOptions = (root: string, timeout = historyFixtureChildTimeoutMs) => ({
  cwd: root,
  env: { ...buildGitHistoryEnvironment(root, resolve(tmpdir())), GIT_MERGE_AUTOEDIT: "no" },
  killSignal: "SIGKILL" as const,
  maxBuffer: 32 * 1024 * 1024,
  stderr: "pipe" as const,
  stdin: "ignore" as const,
  stdout: "pipe" as const,
  timeout,
});
const spawnHistoryFixtureGit = (
  root: string,
  arguments_: readonly string[],
  timeout = historyFixtureChildTimeoutMs,
) => Bun.spawnSync(
  [
    "/usr/bin/git",
    "-c",
    "commit.gpgSign=false",
    "-c",
    "core.hooksPath=/dev/null",
    ...arguments_,
  ],
  historyFixtureSpawnOptions(root, timeout),
);

const runHistoryFixtureGit = (root: string, ...arguments_: readonly string[]) =>
  spawnHistoryFixtureGit(root, arguments_);
const requireHistoryFixtureGitOutput = (result: ReturnType<typeof runHistoryFixtureGit>): string => {
  if (result.exitCode !== 0 || result.exitedDueToMaxBuffer || result.exitedDueToTimeout) {
    throw new Error("Git history fixture command failed or exceeded its bound.");
  }
  return Buffer.from(result.stdout).toString("utf8").trim();
};
const requireHistoryFixtureGit = (root: string, ...arguments_: readonly string[]): string =>
  requireHistoryFixtureGitOutput(runHistoryFixtureGit(root, ...arguments_));

const initializeHistoryFixture = async (
  root: string,
  body = "base\n",
  git = (...arguments_: readonly string[]) => requireHistoryFixtureGit(root, ...arguments_),
): Promise<string> => {
  git("init", "--initial-branch=main");
  git("config", "user.name", "HRA History Fixture");
  git("config", "user.email", "history-fixture@example.invalid");
  await writeFile(join(root, "document.txt"), body, "utf8");
  git("add", "document.txt");
  git("commit", "-m", "base");
  return git("rev-parse", "HEAD");
};

const runCanonicalHistoryPatch = (
  root: string,
  commit: string,
  kind: "public_patch" | "sensitive_patch",
  timeout = historyFixtureChildTimeoutMs,
) => Bun.spawnSync(
  ["/usr/bin/git", "--no-pager", ...gitHistoryCommandArguments({ commit, kind })],
  historyFixtureSpawnOptions(root, timeout),
);

describe("installed package daemon ownership", () => {
  test("times out delayed receipt publication without losing the exact owned pid", async () => {
    const pid = 42_424;
    let now = 0;
    let statusCalls = 0;
    const error = await waitForOwnedInstalledDaemonReady({
      daemon: { exitObservation: () => null, pid },
      deadlineMs: 100,
      now: () => now,
      pollMs: 20,
      queryStatus: async () => {
        statusCalls += 1;
        return identity(pid);
      },
      readReceipt: async () => now >= 120 ? receipt(pid) : null,
      sleep: async (milliseconds) => { now += milliseconds; },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain(`pid ${String(pid)}`);
    expect(String(error)).toContain("did not become ready before the deadline");
    expect(statusCalls).toBe(0);
  });

  test("refuses a live receipt published by a process the harness does not own", async () => {
    const ownedPid = 42_425;
    await expect(waitForOwnedInstalledDaemonReady({
      daemon: { exitObservation: () => null, pid: ownedPid },
      queryStatus: async () => identity(ownedPid + 1),
      readReceipt: async () => receipt(ownedPid + 1),
    })).rejects.toThrow(`unexpected pid ${String(ownedPid + 1)} instead of owned pid ${String(ownedPid)}`);
  });
});

describe("installed package generic command ownership", () => {
  test("admits only one canonical absolute Bun dependency cache path", () => {
    const cache = resolve(join(tmpdir(), "hra-bun-cache"));
    expect(parsePackageDependencyCache(cache)).toBe(cache);
    expect(parsePackageDependencyCache(`${cache}\n`)).toBe(cache);
    for (const value of [
      "relative/cache\n",
      `${cache}\n${cache}\n`,
      `${cache}\n\n`,
      `${cache}\r\n`,
      `${cache}\0\n`,
      `${cache}/../cache\n`,
      `${"/".repeat(4_097)}\n`,
    ]) expect(() => parsePackageDependencyCache(value)).toThrow("non-canonical dependency cache path");
  });

  test("shares only the validated dependency cache across private consumer roots", async () => {
    const source = await readFile(join(import.meta.dir, "check-package.ts"), "utf8");
    expect(source.indexOf("await resolvePackageDependencyCache(repositoryRoot)")).toBeLessThan(
      source.indexOf('mkdtemp(join(tmpdir(), "hra-package-")'),
    );
    expect(source).toContain("BUN_INSTALL_CACHE_DIR: dependencyCacheRoot");
    expect(source).not.toContain("BUN_INSTALL_CACHE_DIR: globalInstallRoot");
    expect(source).toContain("delete discoveryEnvironment.BUN_INSTALL_CACHE_DIR;");
    expect(source.match(/await withPackageDependencyCacheCustody\(dependencyCacheRoot/gu)).toHaveLength(2);
    for (const isolated of [
      "BUN_INSTALL: globalInstallRoot",
      'BUN_INSTALL_BIN: join(globalInstallRoot, "bin")',
      'BUN_INSTALL_GLOBAL_DIR: join(globalInstallRoot, "install", "global")',
      "HOME: consumerHome",
      "TMPDIR: consumerTemporaryDirectory",
    ]) expect(source).toContain(isolated);
  });

  test("ignores a direct ambient cache override while retaining the configured Bun installation root", () => {
    const environment = packageDependencyCacheDiscoveryEnvironment({
      BUN_INSTALL: "/canonical-bun-root",
      BUN_INSTALL_CACHE_DIR: "/untrusted-direct-cache-override",
      HRA_UNRELATED_FIXTURE: "preserved",
    });
    expect(environment).toEqual({
      BUN_INSTALL: "/canonical-bun-root",
      HRA_UNRELATED_FIXTURE: "preserved",
    });
  });

  test("holds the dependency cache descriptor and rejects path replacement", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "hra-package-cache-custody-")));
    const cache = join(root, "cache");
    const displaced = join(root, "displaced");
    const replacement = join(root, "replacement");
    try {
      await mkdir(cache, { mode: 0o700 });
      await mkdir(replacement, { mode: 0o700 });
      await expect(withPackageDependencyCacheCustody(cache, async () => {
        await rename(cache, displaced);
        await rename(replacement, cache);
      })).rejects.toThrow("identity changed while in use");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("fails closed when a cache consumer rejects with undefined", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "hra-package-cache-undefined-error-")));
    const cache = join(root, "cache");
    try {
      await mkdir(cache, { mode: 0o700 });
      await expect(withPackageDependencyCacheCustody(cache, async () => await Promise.reject(undefined))).rejects.toThrow(
        "Bun dependency cache operation failed with a non-error value.",
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("holds the dependency cache parent chain and rejects parent replacement", async () => {
    const temporaryParent = await realpath(await mkdtemp(join(tmpdir(), "hra-package-cache-parent-custody-")));
    const root = join(temporaryParent, "root");
    const cache = join(root, "cache");
    const displaced = join(temporaryParent, "displaced");
    const replacement = join(temporaryParent, "replacement");
    try {
      await mkdir(cache, { mode: 0o700, recursive: true });
      await mkdir(join(replacement, "cache"), { mode: 0o700, recursive: true });
      await expect(withPackageDependencyCacheCustody(cache, async () => {
        await rename(root, displaced);
        await rename(replacement, root);
      })).rejects.toThrow("path identity changed while in use");
    } finally {
      await rm(temporaryParent, { force: true, recursive: true });
    }
  });

  test("rejects a group-writable dependency cache parent", async () => {
    const temporaryParent = await realpath(await mkdtemp(join(tmpdir(), "hra-package-cache-parent-mode-")));
    const parent = join(temporaryParent, "parent");
    const cache = join(parent, "cache");
    try {
      await mkdir(cache, { mode: 0o700, recursive: true });
      await chmod(parent, 0o770);
      await expect(withPackageDependencyCacheCustody(cache, async () => undefined)).rejects.toThrow(
        "path custody is invalid",
      );
    } finally {
      await rm(temporaryParent, { force: true, recursive: true });
    }
  });

  test("rejects a dangerous Darwin ACL on the dependency cache", async () => {
    if (process.platform !== "darwin") return;
    const root = await realpath(await mkdtemp(join(tmpdir(), "hra-package-cache-acl-")));
    const cache = join(root, "cache");
    const runChmod = async (...arguments_: string[]): Promise<void> => {
      const child = Bun.spawn(["/bin/chmod", ...arguments_], {
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
      });
      const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      if (exitCode !== 0) throw new Error(`ACL fixture chmod failed: ${stderr}`);
    };
    try {
      await mkdir(cache, { mode: 0o700 });
      await runChmod("+a", "everyone allow delete", cache);
      await expect(withPackageDependencyCacheCustody(cache, async () => undefined)).rejects.toThrow(
        "dangerous non-owner Darwin ALLOW ACL",
      );
    } finally {
      await runChmod("-N", cache).catch(() => undefined);
      await rm(root, { force: true, recursive: true });
    }
  });

  test("scans complete Git history one bounded commit patch at a time", async () => {
    const source = await readFile(join(import.meta.dir, "check-package.ts"), "utf8");
    expect(source).toContain('["--no-replace-objects", "rev-list", "--max-count=100001", "--all"]');
    expect(source).toContain('["--no-replace-objects", "rev-parse", "--is-shallow-repository"]');
    expect(source).toContain('"--diff-merges=first-parent"');
    expect(source).toContain('"--text"');
    for (const renderingArgument of [
      "core.attributesFile=/dev/null",
      "core.quotePath=true",
      "diff.mnemonicPrefix=false",
      "diff.noprefix=false",
      "diff.orderFile=/dev/null",
      "diff.relative=false",
      "diff.suppressBlankEmpty=false",
      "--full-index",
      "--no-color",
      "--no-renames",
      "--unified=3",
      "--inter-hunk-context=0",
      "--diff-algorithm=myers",
      "--no-indent-heuristic",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--output-indicator-new=+",
      "--output-indicator-old=-",
      "--output-indicator-context= ",
      "--submodule=short",
    ]) expect(source).toContain(JSON.stringify(renderingArgument));
    expect(source).toContain("Bun.spawnSync");
    expect(source).toContain('killSignal: "SIGKILL"');
    expect(source).toContain("gitHistoryScanOutputMaximumBytes");
    expect(source).toContain("gitHistoryScanTimeoutMs");
    expect(source).not.toContain('["log", "--all", "--format=", "--patch"');
    expect(source).not.toMatch(/await run\(\s*"\/usr\/bin\/git"/u);

    const first = "a".repeat(40);
    const second = "b".repeat(40);
    expect(parseGitHistoryCommitList(`${first}\n${second}\n`)).toEqual([first, second]);
    for (const invalid of [
      "",
      `${first}\n${first}\n`,
      `${first.toUpperCase()}\n`,
      `${"c".repeat(39)}\n`,
      `${first}\n\n${second}\n`,
    ]) {
      expect(() => parseGitHistoryCommitList(invalid)).toThrow("Git history enumeration");
    }
    const overBound = `${Array.from(
      { length: 100_001 },
      (_, index) => index.toString(16).padStart(40, "0"),
    ).join("\n")}\n`;
    expect(() => parseGitHistoryCommitList(overBound)).toThrow("over its commit bound");
  });

  test.each([
    {
      fixture: "sanitized_message",
      originalCommit: "f39747b917b064ff593c58dea2a05e4481319b26",
      repairCommit: "313ed3e3e1ddbe5b6464fc098926717f177418a8",
      syntheticPath: ["", "Users", "private", "project", ""].join("/"),
    },
    {
      fixture: "memory_summary",
      originalCommit: "72fcb44fb81a79c93ade6da3a127dbb3ae1dd6f9",
      repairCommit: "5039f0bfe37706f97bd93e68f8db2dff4aa16013",
      syntheticPath: ["", "Users", "operator", "private"].join("/"),
    },
  ] as const)("normalizes only exact historical $fixture evidence", ({
    fixture,
    originalCommit,
    repairCommit,
    syntheticPath,
  }) => {
    const repositoryRoot = resolve(import.meta.dir, "..");
    const historyPatch = (commit: string, kind: "public_patch" | "sensitive_patch"): string => {
      const result = runCanonicalHistoryPatch(repositoryRoot, commit, kind);
      expect(result.exitCode).toBe(0);
      expect(result.exitedDueToMaxBuffer ?? false).toBe(false);
      expect(result.exitedDueToTimeout ?? false).toBe(false);
      expect(result.stderr.byteLength).toBe(0);
      return result.stdout.toString("utf8");
    };

    for (const commit of [originalCommit, repairCommit]) {
      for (const kind of ["sensitive_patch", "public_patch"] as const) {
        const patch = historyPatch(commit, kind);
        expect(patch.match(new RegExp(syntheticPath, "gu"))).toHaveLength(1);
        const normalized = normalizeGitHistoryPatchForPublicScan(commit, kind, patch);
        expect(normalized).not.toContain(syntheticPath);
        expect(normalized).toContain("[reviewed-synthetic-absolute-path]");
        const assertReviewedPatch = kind === "public_patch"
          ? assertPublicText
          : assertPublicSensitiveText;
        expect(() => assertReviewedPatch(normalized, "reviewed history fixture")).not.toThrow();
        expect(() => normalizeGitHistoryPatchForPublicScan(commit, kind, `${patch}mutation\n`))
          .toThrow("synthetic-path evidence changed");
        const otherCommit = commit === originalCommit ? repairCommit : originalCommit;
        expect(() => normalizeGitHistoryPatchForPublicScan(otherCommit, kind, patch))
          .toThrow("synthetic-path evidence changed");
        if (fixture === "memory_summary" && commit === originalCommit) {
          const otherKind = kind === "public_patch" ? "sensitive_patch" : "public_patch";
          const otherPatch = historyPatch(commit, otherKind);
          expect(otherPatch).not.toBe(patch);
          expect(() => normalizeGitHistoryPatchForPublicScan(commit, kind, otherPatch))
            .toThrow("synthetic-path evidence changed");
        }
      }
    }

    const unreviewedCommit = "a".repeat(40);
    const unreviewedPatch = `before ${syntheticPath} after`;
    expect(normalizeGitHistoryPatchForPublicScan(
      unreviewedCommit,
      "sensitive_patch",
      unreviewedPatch,
    )).toBe(unreviewedPatch);
    expect(() => assertPublicSensitiveText(unreviewedPatch, "unreviewed history fixture"))
      .toThrow("ABSOLUTE_USER_PATH");

    const duplicatePatch = `${syntheticPath}\n${syntheticPath}\n`;
    const duplicateDigest = createHash("sha256").update(duplicatePatch, "utf8").digest("hex");
    expect(() => normalizeReviewedSyntheticHistoryPatch(duplicatePatch, duplicateDigest, [fixture]))
      .toThrow("synthetic-path evidence changed");
    for (const missingPatch of [
      "safe history patch\n",
      [["", "Users", "private", "other", ""].join("/"), "changed path\n"].join(""),
    ]) {
      const missingDigest = createHash("sha256").update(missingPatch, "utf8").digest("hex");
      expect(() => normalizeReviewedSyntheticHistoryPatch(missingPatch, missingDigest, [fixture]))
        .toThrow("synthetic-path evidence changed");
    }
    expect(() => assertPublicSensitiveText(syntheticPath, "current tree fixture"))
      .toThrow("ABSOLUTE_USER_PATH");

    const secret = ["sk", "proj", "Z".repeat(24)].join("-");
    const retainedSensitivePatch = `${syntheticPath}\n${secret}\n`;
    const retainedDigest = createHash("sha256")
      .update(retainedSensitivePatch, "utf8")
      .digest("hex");
    const normalizedSensitivePatch = normalizeReviewedSyntheticHistoryPatch(
      retainedSensitivePatch,
      retainedDigest,
      [fixture],
    );
    const otherFixture = fixture === "memory_summary" ? "sanitized_message" : "memory_summary";
    expect(() => normalizeReviewedSyntheticHistoryPatch(
      retainedSensitivePatch,
      retainedDigest,
      [otherFixture],
    )).toThrow("synthetic-path evidence changed");
    expect(() => assertPublicSensitiveText(normalizedSensitivePatch, "retained history fixture"))
      .toThrow("SECRET_SHAPE");

    const privateScope = ["@", "unreviewed-scope", "/", "package"].join("");
    const retainedPublicPatch = `${syntheticPath}\n${privateScope}\n`;
    const retainedPublicDigest = createHash("sha256")
      .update(retainedPublicPatch, "utf8")
      .digest("hex");
    const normalizedPublicPatch = normalizeReviewedSyntheticHistoryPatch(
      retainedPublicPatch,
      retainedPublicDigest,
      [fixture],
    );
    expect(() => assertPublicText(normalizedPublicPatch, "retained public history fixture"))
      .toThrow("PRIVATE_SCOPE");
  });

  test("normalizes both exact synthetic fixtures in their reviewed first-parent merge patch", () => {
    const root = resolve(import.meta.dir, "..");
    const commit = "b48fdb71ca201d951b9b1343a909b5f18277bc36";
    const messagePath = ["", "Users", "private", "project", ""].join("/");
    const summaryPath = ["", "Users", "operator", "private"].join("/");
    for (const kind of ["sensitive_patch", "public_patch"] as const) {
      const result = runCanonicalHistoryPatch(root, commit, kind);
      expect(result.exitCode).toBe(0);
      expect(result.exitedDueToMaxBuffer ?? false).toBe(false);
      expect(result.exitedDueToTimeout ?? false).toBe(false);
      expect(result.stderr.byteLength).toBe(0);
      const patch = result.stdout.toString("utf8");
      expect(patch.split(messagePath)).toHaveLength(2);
      expect(patch.split(summaryPath)).toHaveLength(2);
      const normalized = normalizeGitHistoryPatchForPublicScan(commit, kind, patch);
      expect(normalized).toBe(patch
        .replace(messagePath, "[reviewed-synthetic-absolute-path]")
        .replace(summaryPath, "[reviewed-synthetic-absolute-path]"));
      const assertReviewedPatch = kind === "public_patch" ? assertPublicText : assertPublicSensitiveText;
      expect(() => assertReviewedPatch(normalized, "reviewed merge fixture")).not.toThrow();
      expect(() => normalizeGitHistoryPatchForPublicScan(commit, kind, `${patch}changed\n`))
        .toThrow("synthetic-path evidence changed");
    }

    const patch = `${messagePath}\n${summaryPath}\n`;
    const digest = createHash("sha256").update(patch, "utf8").digest("hex");
    expect(() => normalizeReviewedSyntheticHistoryPatch(patch, digest, []))
      .toThrow("fixture selection is invalid");
    expect(() => normalizeReviewedSyntheticHistoryPatch(patch, digest, ["memory_summary", "memory_summary"]))
      .toThrow("fixture selection is invalid");
    expect(() => normalizeReviewedSyntheticHistoryPatch(patch, digest, [
      "sanitized_message", "memory_summary", "sanitized_message",
    ])).toThrow("fixture selection is invalid");
    const extraOccurrence = `${patch}${summaryPath}\n`;
    const extraDigest = createHash("sha256").update(extraOccurrence, "utf8").digest("hex");
    expect(() => normalizeReviewedSyntheticHistoryPatch(extraOccurrence, extraDigest, [
      "sanitized_message", "memory_summary",
    ])).toThrow("synthetic-path evidence changed");
  });

  test("bounds history fixture children independently of ambient configuration and the outer deadline", () => {
    const root = resolve(tmpdir());
    const options = historyFixtureSpawnOptions(root);
    expect(options.env).toEqual({ ...buildGitHistoryEnvironment(root, root), GIT_MERGE_AUTOEDIT: "no" });
    expect(options).toMatchObject({
      killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024,
      stderr: "pipe", stdin: "ignore", stdout: "pipe", timeout: 5_000,
    });
    let now = 0;
    const remaining = createHistoryRenderingBudget(() => now);
    expect(remaining()).toBe(5_000);
    now = 19_000;
    expect(remaining()).toBe(1_000);
    now = 19_999;
    expect(remaining()).toBe(1);
    now = 20_000;
    expect(remaining).toThrow("exhausted its time budget");
  });

  test("makes reviewed patch rendering independent of hostile repository configuration", async () => {
    const remaining = createHistoryRenderingBudget();
    // Fixed phase labels identify a stall even if the outer test timeout fires.
    // Never print fixture paths, command arguments, configuration, or Git output.
    const phase = (value: "setup" | "render_baseline" | "config" | "render_hostile" | "cleanup") => {
      console.error(`[hra-history-rendering-fixture] ${value}`);
    };
    phase("setup");
    const root = resolve(await mkdtemp(join(tmpdir(), "hra-history-rendering-")));
    const git = (...arguments_: readonly string[]) =>
      requireHistoryFixtureGitOutput(spawnHistoryFixtureGit(root, arguments_, remaining()));
    try {
      await initializeHistoryFixture(root, "first\n\nsecond\nthird\n", git);
      const contextPath = join(root, "context.txt");
      await writeFile(
        contextPath,
        "alpha\nnear-alpha\n\nblank-context\nkeep-five\nkeep-six\nkeep-seven\nkeep-eight\nnear-omega\nomega\n",
        "utf8",
      );
      git("add", "context.txt");
      git("commit", "-m", "context base");
      const source = join(root, "document.txt");
      const destination = join(root, "\u03c0-document.txt");
      await rename(source, destination);
      await writeFile(destination, "first changed\n\nsecond\nthird changed\n", "utf8");
      await writeFile(
        contextPath,
        "alpha changed\nnear-alpha\n\nblank-context\nkeep-five\nkeep-six\nkeep-seven\nkeep-eight\nnear-omega\nomega changed\n",
        "utf8",
      );
      git("add", "--all");
      git("commit", "-m", "rendering target");
      const commit = git("rev-parse", "HEAD");
      phase("render_baseline");
      const baseline = runCanonicalHistoryPatch(root, commit, "sensitive_patch", remaining());
      expect(baseline.exitCode).toBe(0);
      expect(baseline.stderr.byteLength).toBe(0);

      phase("config");
      for (const [key, value] of [
        ["color.ui", "always"],
        ["core.abbrev", "5"],
        ["core.attributesFile", "/unavailable/hostile-attributes"],
        ["core.quotePath", "false"],
        ["diff.algorithm", "histogram"],
        ["diff.context", "0"],
        ["diff.indentHeuristic", "true"],
        ["diff.interHunkContext", "99"],
        ["diff.mnemonicPrefix", "true"],
        ["diff.noprefix", "true"],
        ["diff.orderFile", "/unavailable/hostile-order"],
        ["diff.renames", "true"],
        ["diff.relative", "true"],
        ["diff.submodule", "log"],
        ["diff.suppressBlankEmpty", "true"],
      ] as const) git("config", key, value);

      phase("render_hostile");
      const hostile = runCanonicalHistoryPatch(root, commit, "sensitive_patch", remaining());
      expect(hostile.exitCode).toBe(0);
      expect(hostile.exitedDueToMaxBuffer ?? false).toBe(false);
      expect(hostile.exitedDueToTimeout ?? false).toBe(false);
      expect(hostile.stderr.byteLength).toBe(0);
      expect(hostile.stdout).toEqual(baseline.stdout);
    } finally {
      phase("cleanup");
      await rm(root, { force: true, recursive: true }).catch(() => {
        throw new Error("Git history rendering fixture cleanup failed.");
      });
    }
  }, 30_000);

  test("keeps failed history command payloads out of diagnostics", () => {
    const sentinel = ["sk", "proj", "A".repeat(24)].join("-");
    const error = (() => {
      try {
        requireGitHistoryOutput("Git history fixture", {
          exitCode: 1,
          stderr: sentinel,
          stdout: sentinel,
        });
      } catch (caught: unknown) {
        return caught;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toBe("Error: Git history fixture failed or emitted diagnostics with exit 1.");
    expect(String(error)).not.toContain(sentinel);
  });

  test("keeps synchronous history reads ambient-free, bounded, and nondisclosing", () => {
    const environment = buildGitHistoryEnvironment("/private/hra-source", "/private/hra-temp");
    expect(environment).toEqual({
      GIT_ATTR_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_NO_LAZY_FETCH: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
      HOME: "/private/hra-source",
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
      TMPDIR: "/private/hra-temp",
      XDG_CONFIG_HOME: "/dev/null",
    });
    expect(() => buildGitHistoryEnvironment("relative", "/private/hra-temp"))
      .toThrow("absolute and normalized");

    const safe = projectGitHistorySpawnResult({
      exitCode: 0,
      exitedDueToMaxBuffer: false,
      exitedDueToTimeout: false,
      stderr: Buffer.alloc(0),
      stdout: Buffer.from("safe\n"),
    });
    expect(safe).toEqual({ exitCode: 0, stderr: "", stdout: "safe\n" });

    const sentinel = Buffer.from([0x73, 0x6b, 0x2d, 0x73, 0x65, 0x63, 0x72, 0x65, 0x74]);
    for (const result of [
      projectGitHistorySpawnResult({
        exitCode: 1,
        exitedDueToMaxBuffer: false,
        exitedDueToTimeout: false,
        stderr: sentinel,
        stdout: sentinel,
      }),
      projectGitHistorySpawnResult({
        exitCode: 0,
        exitedDueToMaxBuffer: false,
        exitedDueToTimeout: true,
        stderr: Buffer.alloc(0),
        stdout: sentinel,
      }),
      projectGitHistorySpawnResult({
        exitCode: 0,
        exitedDueToMaxBuffer: true,
        exitedDueToTimeout: false,
        stderr: Buffer.alloc(0),
        stdout: Buffer.alloc(32 * 1024 * 1024 + 1),
      }),
      projectGitHistorySpawnResult({
        exitCode: 0,
        exitedDueToMaxBuffer: false,
        exitedDueToTimeout: false,
        stderr: Buffer.alloc(0),
        stdout: Buffer.alloc(12 * 1024 * 1024, 0xff),
      }),
    ]) {
      expect(result).toEqual({ exitCode: 1, stderr: "", stdout: "" });
      expect(`${result.stderr}${result.stdout}`).not.toContain("secret");
    }
  });

  test("scans resolution-only merge content against the first parent", async () => {
    const root = await mkdtemp(join(tmpdir(), "hra-history-merge-"));
    try {
      await initializeHistoryFixture(root);
      const document = join(root, "document.txt");
      requireHistoryFixtureGit(root, "checkout", "-b", "feature");
      await writeFile(document, "feature\n", "utf8");
      requireHistoryFixtureGit(root, "commit", "-am", "feature");
      requireHistoryFixtureGit(root, "checkout", "main");
      await writeFile(document, "main\n", "utf8");
      requireHistoryFixtureGit(root, "commit", "-am", "main");
      expect(runHistoryFixtureGit(root, "merge", "--no-ff", "--no-edit", "feature").exitCode).not.toBe(0);
      const sentinel = ["sk", "proj", "B".repeat(24)].join("-");
      await writeFile(document, `resolved\n${sentinel}\n`, "utf8");
      requireHistoryFixtureGit(root, "add", "document.txt");
      requireHistoryFixtureGit(root, "commit", "-m", "resolution");

      await expect(assertCompleteGitHistoryPublic(root)).rejects.toThrow("SECRET_SHAPE");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  test("scans roots, deleted content, side refs, and unreplaced objects", async () => {
    const sentinel = ["sk", "proj", "C".repeat(24)].join("-");
    for (const scenario of ["deleted-root", "side-ref", "replacement"] as const) {
      const root = await mkdtemp(join(tmpdir(), `hra-history-${scenario}-`));
      try {
        const rootCommit = await initializeHistoryFixture(
          root,
          scenario === "deleted-root" ? `${sentinel}\n` : "safe\n",
        );
        const document = join(root, "document.txt");
        if (scenario === "deleted-root") {
          await writeFile(document, "safe\n", "utf8");
          requireHistoryFixtureGit(root, "commit", "-am", "delete historical sentinel");
        } else if (scenario === "side-ref") {
          requireHistoryFixtureGit(root, "checkout", "-b", "side");
          await writeFile(document, `${sentinel}\n`, "utf8");
          requireHistoryFixtureGit(root, "commit", "-am", "side sentinel");
          requireHistoryFixtureGit(root, "checkout", "main");
        } else {
          await writeFile(document, `${sentinel}\n`, "utf8");
          requireHistoryFixtureGit(root, "commit", "-am", "replace-hidden sentinel");
          const secretCommit = requireHistoryFixtureGit(root, "rev-parse", "HEAD");
          requireHistoryFixtureGit(root, "replace", secretCommit, rootCommit);
        }
        await expect(assertCompleteGitHistoryPublic(root)).rejects.toThrow("SECRET_SHAPE");
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    }
  }, 30_000);

  test("forces binary-classified historical blobs through text policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "hra-history-binary-text-"));
    try {
      await initializeHistoryFixture(root);
      const sentinel = Buffer.from([
        0x73,
        0x6b,
        0x2d,
        0x70,
        0x72,
        0x6f,
        0x6a,
        0x2d,
        ...Buffer.alloc(24, 0x45),
      ]);
      await writeFile(
        join(root, "document.txt"),
        Buffer.concat([Buffer.from([0x00]), sentinel, Buffer.from("\n")]),
      );
      requireHistoryFixtureGit(root, "commit", "-am", "binary-classified sentinel");
      await expect(assertCompleteGitHistoryPublic(root)).rejects.toThrow("SECRET_SHAPE");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  test("keeps lockfile scope exemption narrow and refuses shallow history", async () => {
    const root = await mkdtemp(join(tmpdir(), "hra-history-lock-policy-"));
    try {
      const head = await initializeHistoryFixture(root);
      const lockfile = join(root, "bun.lock");
      await writeFile(lockfile, `${["@", "private", "-", "scope", "/", "package"].join("")}\n`, "utf8");
      requireHistoryFixtureGit(root, "add", "bun.lock");
      requireHistoryFixtureGit(root, "commit", "-m", "lock scope");
      await expect(assertCompleteGitHistoryPublic(root)).resolves.toBeUndefined();

      const sentinel = ["sk", "proj", "D".repeat(24)].join("-");
      await writeFile(lockfile, `${sentinel}\n`, "utf8");
      requireHistoryFixtureGit(root, "commit", "-am", "lock secret");
      await expect(assertCompleteGitHistoryPublic(root)).rejects.toThrow("SECRET_SHAPE");

      await writeFile(join(root, ".git", "shallow"), `${head}\n`, "utf8");
      await expect(assertCompleteGitHistoryPublic(root)).rejects.toThrow("non-shallow repository");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  test("routes every effectful and consumer command through the detached-group runner", async () => {
    const source = await readFile(join(import.meta.dir, "check-package.ts"), "utf8");
    expect(source).toContain("const run = runPackageCommand;");
    for (const command of [
      'await run("npm", ["pack", "--ignore-scripts", "--pack-destination"',
      '["-xzpf", archive, "-C", inspectionDirectory]',
      '["add", "--backend=copyfile", "--ignore-scripts", archive]',
      '["-e", "await import(\'@hraness/hra\')"]',
      'run(executable, ["--help"]',
      'run(executable, ["--version"]',
      'run(executable, ["doctor", "--offline", "--json"]',
      '[join(repositoryRoot, "src", "install-preflight.ts"), archive]',
      'phase: "package-transactional-global-install"',
    ]) expect(source).toContain(command);
  });

  test("verifies the installed command directly without touching Bun global metadata", async () => {
    const source = await readFile(join(import.meta.dir, "check-package.ts"), "utf8");
    expect(source).toContain("activeGlobalCommand.isSymbolicLink()");
    expect(source).toContain("activeGlobalCommand.nlink !== 1");
    expect(source).toContain("activeGlobalCommand.uid !== uid");
    expect(source).not.toContain('["pm", "bin", "--global"]');
  });

  for (const scenario of [
    { name: "deadline", overflow: false, timeoutMs: 2_000 },
    { name: "combined output overflow", overflow: true, timeoutMs: 10_000 },
  ] as const) {
    test(`kills every hostile descendant and returns bounded output after ${scenario.name}`, async () => {
      if (process.platform !== "darwin" && process.platform !== "linux") return;
      const root = await mkdtemp(join(tmpdir(), "hra-package-runner-hostile-"));
      const pidFile = join(root, "owned-pids.json");
      let ownedPids: number[] = [];
      try {
        const startedAt = Date.now();
        const result = await runPackageCommand(
          process.execPath,
          ["-e", hostilePtyProcessTreeSource(scenario.overflow)],
          {
            cwd: root,
            env: { ...process.env, HRA_HOSTILE_PID_FILE: pidFile },
            outputMaximumBytes: 64,
            timeoutMs: scenario.timeoutMs,
          },
        );
        expect(Date.now() - startedAt).toBeLessThan(scenario.overflow ? 2_000 : 4_000);
        expect(result.exitCode).toBe(scenario.overflow ? 1 : 124);
        expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(64);
        ownedPids = JSON.parse(await readFile(pidFile, "utf8")) as number[];
        expect(ownedPids).toHaveLength(3);
        expect(new Set(ownedPids).size).toBe(3);
        for (const pid of ownedPids) {
          expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
          expect(processIsAlive(pid)).toBe(false);
        }
        ownedPids = [];
      } finally {
        for (const pid of ownedPids) {
          if (Number.isSafeInteger(pid) && pid > 1 && processIsAlive(pid)) {
            try { process.kill(pid, "SIGKILL"); } catch { /* The exact fixture process may just have exited. */ }
          }
        }
        await rm(root, { force: true, recursive: true });
      }
    }, 15_000);
  }
});

describe("installed package pseudo-terminal acceptance", () => {
  test("uses each supported operating system's real script interface without interpolating macOS arguments", () => {
    expect(pseudoTerminalScriptArguments("darwin", "/tmp/wrapper path", [
      "/tmp/hra path",
      "--help",
    ])).toEqual([
      "-q",
      "-e",
      "/dev/null",
      "/bin/sh",
      "/tmp/wrapper path",
      "/tmp/hra path",
      "--help",
    ]);
    expect(pseudoTerminalScriptArguments("linux", "/tmp/wrapper path", [
      "/tmp/hra path",
      "apostrophe'value",
    ])).toEqual([
      "-q",
      "-e",
      "-c",
      "'/bin/sh' '/tmp/wrapper path' '/tmp/hra path' 'apostrophe'\\''value'",
      "/dev/null",
    ]);
    expect(() => pseudoTerminalScriptArguments("win32", "wrapper", ["hra"]))
      .toThrow("unsupported on win32");
  });

  test("drives the actual shell terminal through account and session selection and exact slash payloads", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return;
    const root = await mkdtemp(join(tmpdir(), "hra-pty-test-"));
    const home = join(root, "home");
    const temporaryDirectory = join(root, "tmp");
    await mkdir(home, { mode: 0o700 });
    await mkdir(temporaryDirectory, { mode: 0o700 });
    try {
      const result = await runInPseudoTerminal({
        command: [process.execPath, resolve(import.meta.dir, "pty-shell-acceptance-fixture.ts")],
        cwd: root,
        environment: {
          ...process.env,
          CODEX_ELECTRON_USER_DATA_PATH: undefined,
          CODEX_HOME: undefined,
          HOME: home,
          HRA_CONVEX_URL: "",
          TMPDIR: temporaryDirectory,
          XDG_CACHE_HOME: join(home, ".cache"),
          XDG_CONFIG_HOME: join(home, ".config"),
          XDG_DATA_HOME: join(home, ".local", "share"),
          XDG_STATE_HOME: join(home, ".local", "state"),
        },
        steps: [
          { expect: PTY_BEGIN_MARKER },
          { expect: "HRA shell. /help lists commands; /exit leaves the daemon running." },
          { expect: "hra> ", write: "/account fixture\n" },
          { expect: `Selected account acct_${"1".repeat(32)}.` },
          { expect: "hra[", write: "/session fixture\n" },
          { expect: `Selected session sess_${"2".repeat(32)}.` },
          { expect: "Live updates unavailable:" },
          { expect: "hra[", write: "//slash-one\n" },
          { expect: "hra[", write: "/send /slash-two\n" },
          { expect: "hra[", write: "/watch\n" },
          { expect: "WATCH_STARTED", write: "\u0003" },
          { expect: "hra[", write: "//after-watch\n" },
          { expect: "hra[", write: "/exit\n" },
          { expect: "Deterministic PTY shell preserved // and /send payloads across watch cancellation." },
        ],
        temporaryDirectory,
        timeoutMs: 15_000,
      });
      assertPseudoTerminalSuccess(result);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 20_000);

  for (const scenario of [
    { expected: "exceeded its deadline", name: "deadline", overflow: false, timeoutMs: 500 },
    { expected: "exceeded its output bound", name: "output overflow", overflow: true, timeoutMs: 10_000 },
  ] as const) {
    test(`kills the exact hostile PTY process tree after ${scenario.name} and returns within a hard bound`, async () => {
      if (process.platform !== "darwin" && process.platform !== "linux") return;
      const root = await mkdtemp(join(tmpdir(), "hra-pty-hostile-"));
      const temporaryDirectory = join(root, "tmp");
      const pidFile = join(root, "owned-pids.json");
      await mkdir(temporaryDirectory, { mode: 0o700 });
      let ownedPids: number[] = [];
      try {
        const startedAt = Date.now();
        const error = await runInPseudoTerminal({
          command: [process.execPath, "-e", hostilePtyProcessTreeSource(scenario.overflow)],
          cwd: root,
          environment: {
            ...process.env,
            HRA_HOSTILE_PID_FILE: pidFile,
          },
          steps: [
            { expect: PTY_BEGIN_MARKER },
            { expect: "hostile-ready" },
          ],
          temporaryDirectory,
          timeoutMs: scenario.timeoutMs,
        }).catch((caught: unknown) => caught);
        const elapsedMs = Date.now() - startedAt;
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).toContain(scenario.expected);
        expect(elapsedMs).toBeLessThan(scenario.overflow ? 4_000 : 3_000);
        ownedPids = JSON.parse(await readFile(pidFile, "utf8")) as number[];
        expect(ownedPids).toHaveLength(3);
        expect(new Set(ownedPids).size).toBe(3);
        for (const pid of ownedPids) {
          expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
          expect(processIsAlive(pid)).toBe(false);
        }
        ownedPids = [];
      } finally {
        for (const pid of ownedPids) {
          if (Number.isSafeInteger(pid) && pid > 1 && processIsAlive(pid)) {
            try { process.kill(pid, "SIGKILL"); } catch { /* The exact fixture process may just have exited. */ }
          }
        }
        await rm(root, { force: true, recursive: true });
      }
    }, 15_000);
  }
});
