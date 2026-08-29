import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { DaemonAuthorityReceipt } from "../src/daemon/daemon-lock";
import type { DaemonIdentity } from "../src/daemon/daemon-startup";
import {
  assertCompleteGitHistoryPublic,
  buildGitHistoryEnvironment,
  parseGitHistoryCommitList,
  projectGitHistorySpawnResult,
  requireGitHistoryOutput,
  runPackageCommand,
  waitForOwnedInstalledDaemonReady,
} from "./check-package";
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

const runHistoryFixtureGit = (root: string, ...arguments_: readonly string[]) => Bun.spawnSync(
  [
    "/usr/bin/git",
    "-c",
    "commit.gpgSign=false",
    "-c",
    "core.hooksPath=/dev/null",
    ...arguments_,
  ],
  { cwd: root, env: { ...process.env, GIT_MERGE_AUTOEDIT: "no" } },
);

const requireHistoryFixtureGit = (root: string, ...arguments_: readonly string[]): string => {
  const result = runHistoryFixtureGit(root, ...arguments_);
  if (result.exitCode !== 0) {
    throw new Error(`Git history fixture command failed: ${arguments_[0] ?? "unknown"}.`);
  }
  return Buffer.from(result.stdout).toString("utf8").trim();
};

const initializeHistoryFixture = async (root: string, body = "base\n"): Promise<string> => {
  requireHistoryFixtureGit(root, "init", "--initial-branch=main");
  requireHistoryFixtureGit(root, "config", "user.name", "HRA History Fixture");
  requireHistoryFixtureGit(root, "config", "user.email", "history-fixture@example.invalid");
  await writeFile(join(root, "document.txt"), body, "utf8");
  requireHistoryFixtureGit(root, "add", "document.txt");
  requireHistoryFixtureGit(root, "commit", "-m", "base");
  return requireHistoryFixtureGit(root, "rev-parse", "HEAD");
};

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
  test("scans complete Git history one bounded commit patch at a time", async () => {
    const source = await readFile(join(import.meta.dir, "check-package.ts"), "utf8");
    expect(source).toContain('["--no-replace-objects", "rev-list", "--max-count=100001", "--all"]');
    expect(source).toContain('["--no-replace-objects", "rev-parse", "--is-shallow-repository"]');
    expect(source).toContain('"--diff-merges=first-parent"');
    expect(source).toContain('"--text"');
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
      '["pm", "pack", "--ignore-scripts"',
      '["-xzpf", archive, "-C", inspectionDirectory]',
      '["add", "--backend=copyfile", "--ignore-scripts", archive]',
      '["-e", "await import(\'hra\')"]',
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
