import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  chooseDefaultRemote,
  classifySafety,
  normalizeTarget,
  parseArgs,
  parseWorktreePorcelain,
  type SafetyDecision,
} from "./worktree-cleanup";

describe("parseWorktreePorcelain", () => {
  test("parses branch and detached worktrees", () => {
    expect(
      parseWorktreePorcelain(
        [
          "worktree /repo",
          "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "branch refs/heads/main",
          "",
          "worktree /private/tmp/task",
          "HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "detached",
          "",
        ].join("\n"),
      ),
    ).toEqual([
      {
        path: "/repo",
        head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        branch: "main",
      },
      {
        path: "/private/tmp/task",
        head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        branch: null,
      },
    ]);
  });
});

describe("classifySafety", () => {
  const eligible = {
    registered: true,
    primary: false,
    current: false,
    exists: true,
    clean: true,
    merged: true,
    statusReadable: true,
  } as const;

  test("accepts only clean merged secondary worktrees", () => {
    expect(classifySafety(eligible)).toEqual({ eligible: true, reason: "eligible" });
  });

  test.each([
    [{ ...eligible, registered: false }, "unregistered"],
    [{ ...eligible, primary: true }, "primary"],
    [{ ...eligible, current: true }, "current"],
    [{ ...eligible, exists: false }, "missing"],
    [{ ...eligible, statusReadable: false }, "status-error"],
    [{ ...eligible, clean: false }, "dirty"],
    [{ ...eligible, merged: false }, "unmerged"],
  ] as const)("refuses unsafe evidence", (evidence, reason) => {
    expect(classifySafety(evidence)).toEqual({ eligible: false, reason });
  });
});

describe("parseArgs", () => {
  test("defaults to a fetched audit", () => {
    expect(parseArgs([])).toEqual({ fetch: true, json: false, remove: [], sizes: true, target: null });
  });

  test("requires explicit absolute removal paths", () => {
    expect(
      parseArgs(["--remove", "/private/tmp/a", "--remove", "/private/tmp/a", "--remove", "/tmp/b"]),
    ).toEqual({
      fetch: true,
      json: false,
      remove: ["/private/tmp/a", "/tmp/b"],
      sizes: true,
      target: null,
    });
    expect(() => parseArgs(["--remove", "relative"])).toThrow("absolute path");
  });

  test("forbids stale or machine-readable apply modes", () => {
    expect(() => parseArgs(["--no-fetch", "--remove", "/tmp/a"])).toThrow("audit-only");
    expect(() => parseArgs(["--json", "--remove", "/tmp/a"])).toThrow("--json");
  });

  test("accepts an explicit remote target", () => {
    expect(parseArgs(["--target", "upstream/trunk", "--json"])).toEqual({
      fetch: true,
      json: true,
      remove: [],
      sizes: true,
      target: "upstream/trunk",
    });
    expect(() => parseArgs(["--target"])).toThrow("requires");
  });

  test("can skip recursive size scans during fleet audits", () => {
    expect(parseArgs(["--no-size", "--no-fetch", "--json"])).toEqual({
      fetch: false,
      json: true,
      remove: [],
      sizes: false,
      target: null,
    });
  });
});

describe("target selection", () => {
  test("prefers origin and otherwise requires one unambiguous remote", () => {
    expect(chooseDefaultRemote(["upstream", "origin"])).toBe("origin");
    expect(chooseDefaultRemote(["upstream"])).toBe("upstream");
    expect(() => chooseDefaultRemote([])).toThrow("No Git remote");
    expect(() => chooseDefaultRemote(["upstream", "fork"])).toThrow("Several Git remotes");
  });

  test("normalizes remote refs and handles remote names containing slashes", () => {
    expect(normalizeTarget("refs/remotes/upstream/main", ["upstream"])).toEqual({
      branch: "main",
      ref: "refs/remotes/upstream/main",
      remote: "upstream",
    });
    expect(normalizeTarget("team/fork/trunk", ["team", "team/fork"])).toEqual({
      branch: "trunk",
      ref: "refs/remotes/team/fork/trunk",
      remote: "team/fork",
    });
    expect(() => normalizeTarget("main", ["origin"])).toThrow("remote-tracking");
  });

  test("uses the exact fetched remote ref and refuses ignored user state", () => {
    const root = mkdtempSync(join(tmpdir(), "hra-worktree-target-"));
    const remote = join(root, "remote.git");
    const primary = join(root, "primary");
    const unmerged = join(root, "unmerged");
    const ignored = join(root, "ignored");
    const skipWorktree = join(root, "skip-worktree");
    const assumeUnchanged = join(root, "assume-unchanged");
    const submoduleState = join(root, "submodule-state");
    const run = (arguments_: readonly string[], cwd = root): string => {
      const result = Bun.spawnSync({ cmd: [...arguments_], cwd, stderr: "pipe", stdout: "pipe" });
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.toString() || `${arguments_.join(" ")} failed`);
      }
      return result.stdout.toString().trim();
    };
    try {
      run(["git", "init", "--bare", "--initial-branch=main", remote]);
      run(["git", "clone", remote, primary]);
      run(["git", "config", "user.email", "test@example.com"], primary);
      run(["git", "config", "user.name", "Test"], primary);
      writeFileSync(join(primary, ".gitignore"), ".env\n");
      writeFileSync(join(primary, "tracked.txt"), "base\n");
      run(["git", "add", "."], primary);
      run(["git", "commit", "-m", "base"], primary);
      const base = run(["git", "rev-parse", "HEAD"], primary);
      run(["git", "update-index", "--add", "--cacheinfo", "160000", base, "deps/sub"], primary);
      run(["git", "commit", "-m", "add gitlink"], primary);
      run(["git", "push", "-u", "origin", "main"], primary);
      run(["git", "worktree", "add", "-b", "feature", unmerged, "main"], primary);
      writeFileSync(join(unmerged, "feature.txt"), "feature\n");
      run(["git", "add", "feature.txt"], unmerged);
      run(["git", "commit", "-m", "feature"], unmerged);
      const feature = run(["git", "rev-parse", "HEAD"], unmerged);
      run(["git", "branch", "origin/main", feature], primary);
      run(["git", "worktree", "add", "-b", "ignored-state", ignored, "main"], primary);
      const sentinel = join(ignored, ".env");
      writeFileSync(sentinel, "LOCAL_ONLY=preserve-me\n");
      run(["git", "worktree", "add", "-b", "skip-state", skipWorktree, "main"], primary);
      run(["git", "update-index", "--skip-worktree", "tracked.txt"], skipWorktree);
      const skipSentinel = join(skipWorktree, "tracked.txt");
      writeFileSync(skipSentinel, "skip-worktree user state\n");
      run(["git", "worktree", "add", "-b", "assume-state", assumeUnchanged, "main"], primary);
      run(["git", "update-index", "--assume-unchanged", "tracked.txt"], assumeUnchanged);
      const assumeSentinel = join(assumeUnchanged, "tracked.txt");
      writeFileSync(assumeSentinel, "assume-unchanged user state\n");
      run(["git", "worktree", "add", "-b", "submodule-state", submoduleState, "main"], primary);
      run(["git", "config", "submodule.deps/sub.ignore", "all"], submoduleState);
      const submoduleSentinel = join(submoduleState, "deps", "sub", "private-user-state");
      mkdirSync(join(submoduleState, "deps", "sub"), { recursive: true });
      writeFileSync(submoduleSentinel, "uninitialized submodule user state\n");

      const script = join(import.meta.dir, "worktree-cleanup.ts");
      const audit = Bun.spawnSync({
        cmd: [process.execPath, script, "--no-size", "--json"],
        cwd: primary,
        stderr: "pipe",
        stdout: "pipe",
      });
      expect(audit.exitCode).toBe(0);
      const payload = JSON.parse(audit.stdout.toString()) as {
        target: string;
        worktrees: Array<{ decision: SafetyDecision; path: string }>;
      };
      expect(payload.target).toBe("refs/remotes/origin/main");
      expect(payload.worktrees.find((row) => realpathSync(row.path) === realpathSync(unmerged))?.decision.reason)
        .toBe("unmerged");
      expect(payload.worktrees.find((row) => realpathSync(row.path) === realpathSync(ignored))?.decision.reason)
        .toBe("dirty");
      expect(payload.worktrees.find((row) => realpathSync(row.path) === realpathSync(skipWorktree))?.decision.reason)
        .toBe("dirty");
      expect(payload.worktrees.find((row) => realpathSync(row.path) === realpathSync(assumeUnchanged))?.decision.reason)
        .toBe("dirty");
      expect(payload.worktrees.find((row) => realpathSync(row.path) === realpathSync(submoduleState))?.decision.reason)
        .toBe("dirty");

      const removal = Bun.spawnSync({
        cmd: [process.execPath, script, "--remove", realpathSync(ignored)],
        cwd: primary,
        stderr: "pipe",
        stdout: "pipe",
      });
      expect(removal.exitCode).not.toBe(0);
      expect(existsSync(sentinel)).toBe(true);
      for (const [path, preserved] of [
        [skipWorktree, skipSentinel],
        [assumeUnchanged, assumeSentinel],
        [submoduleState, submoduleSentinel],
      ] as const) {
        const hiddenRemoval = Bun.spawnSync({
          cmd: [process.execPath, script, "--remove", realpathSync(path)],
          cwd: primary,
          stderr: "pipe",
          stdout: "pipe",
        });
        expect(hiddenRemoval.exitCode).not.toBe(0);
        expect(existsSync(preserved)).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([
    ["space", " "],
    ["carriage return", "\r"],
  ] as const)("never removes the invoking worktree when its path ends in %s", (_label, suffix) => {
    const root = mkdtempSync(join(tmpdir(), "hra-worktree-current-"));
    const remote = join(root, "remote.git");
    const primary = join(root, "primary");
    const current = join(root, `current${suffix}`);
    const run = (arguments_: readonly string[], cwd = root): string => {
      const result = Bun.spawnSync({ cmd: [...arguments_], cwd, stderr: "pipe", stdout: "pipe" });
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.toString() || `${arguments_.join(" ")} failed`);
      }
      return result.stdout.toString().trim();
    };
    try {
      run(["git", "init", "--bare", "--initial-branch=main", remote]);
      run(["git", "clone", remote, primary]);
      run(["git", "config", "user.email", "test@example.com"], primary);
      run(["git", "config", "user.name", "Test"], primary);
      writeFileSync(join(primary, "tracked.txt"), "base\n");
      run(["git", "add", "tracked.txt"], primary);
      run(["git", "commit", "-m", "base"], primary);
      run(["git", "push", "-u", "origin", "main"], primary);
      run(["git", "worktree", "add", "-b", `current-${suffix.charCodeAt(0)}`, current, "main"], primary);

      const script = join(import.meta.dir, "worktree-cleanup.ts");
      const removal = Bun.spawnSync({
        cmd: [process.execPath, script, "--remove", realpathSync(current)],
        cwd: current,
        stderr: "pipe",
        stdout: "pipe",
      });
      expect(removal.exitCode).not.toBe(0);
      expect(removal.stderr.toString()).toContain("REFUSE\tcurrent");
      expect(existsSync(join(current, ".git"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
