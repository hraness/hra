import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, renameSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { RuntimePaths } from "../src/runtime-paths";
import {
  BundledGitRunner,
  GitCommandError,
  GitExecutionError,
  type GitRunnerInstrumentation,
} from "../src/workspaces/git-runner";

const temporaryDirectories: string[] = [];
const bundledGitRoot = join(
  import.meta.dir,
  "..",
  "..",
  "node_modules",
  "dugite",
  "git",
);
const bundledGitBinary = join(bundledGitRoot, "bin", "git");
const unsafePathExecution = {
  unsafeTestOnlyAllowPathExecution: true,
} as const;
let descriptorExecutorBinary: string | null = null;
let descriptorExecutorCacheRoots: readonly [string, string] | null = null;
let descriptorExecutorRoot: string | null = null;
// A clean release-safe Zig compile can exceed Bun's 30-second hook default
// when the repository gate is sharing an Apple Silicon runner with another
// compiler lane. Keep the build bounded, but budget for that supported load.
const descriptorExecutorBuildTimeoutMs = 120_000;

beforeAll(async () => {
  if (process.platform !== "darwin") return;
  descriptorExecutorRoot = await realpath(
    await mkdtemp(join(tmpdir(), "oprte-git-directory-executor-")),
  );
  const localCacheRoot = join(descriptorExecutorRoot, "zig-local-cache");
  const globalCacheRoot = join(descriptorExecutorRoot, "zig-global-cache");
  await Promise.all([
    mkdir(localCacheRoot, { mode: 0o700 }),
    mkdir(globalCacheRoot, { mode: 0o700 }),
  ]);
  descriptorExecutorCacheRoots = [
    await realpath(localCacheRoot),
    await realpath(globalCacheRoot),
  ];
  const binary = join(
    descriptorExecutorRoot,
    "oprte-git-executor",
  );
  const child = Bun.spawn([
    process.execPath,
    join(import.meta.dir, "..", "run-zig.ts"),
    "build-exe",
    join(import.meta.dir, "..", "..", "src", "git_executor.zig"),
    "-OReleaseSafe",
    "-lc",
    `-femit-bin=${binary}`,
  ], {
    env: {
      ...process.env,
      ZIG_GLOBAL_CACHE_DIR: descriptorExecutorCacheRoots[1],
      ZIG_LOCAL_CACHE_DIR: descriptorExecutorCacheRoots[0],
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`Failed to build Git directory executor: ${stderr}`);
  }
  descriptorExecutorBinary = await realpath(binary);
}, descriptorExecutorBuildTimeoutMs);

afterAll(async () => {
  if (descriptorExecutorRoot !== null) {
    await rm(descriptorExecutorRoot, { force: true, recursive: true });
  }
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true })
    ),
  );
});

describe("bundled Git execution boundary", () => {
  test("builds its descriptor executor with fixture-owned Zig caches", async () => {
    if (process.platform !== "darwin") return;
    const root = descriptorExecutorRoot;
    const cacheRoots = descriptorExecutorCacheRoots;
    if (root === null || cacheRoots === null) {
      throw new Error("Descriptor executor cache fixture was not initialized");
    }
    for (const cacheRoot of cacheRoots) {
      expect(dirname(cacheRoot)).toBe(root);
      expect((await stat(cacheRoot)).isDirectory()).toBeTrue();
    }
  });

  test("runs every admitted Git builtin through the sealed generation boundary", async () => {
    if (process.platform !== "darwin") return;
    const root = await temporaryRoot("oprte-real-git-generation-");
    const repository = join(root, "repository");
    const checkout = join(root, "checkout");
    const codexHome = join(root, "codex-home");
    await mkdir(codexHome);
    await initializeRepository(repository, "generation\n");
    const runner = new BundledGitRunner(
      runtimePaths(codexHome, bundledGitBinary, bundledGitRoot),
      process.env,
      descriptorExecution(),
    );

    // Each call first executes the runner-owned `config` inspection. Together
    // these cover config, rev-parse, status, branch, and both mutating worktree
    // operations under the packaged Mach-O executor/sandbox chain.
    expect((await runner.run(repository, [
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ])).exitCode).toBe(0);
    expect((await runner.run(repository, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ])).exitCode).toBe(0);
    expect((await runner.run(repository, [
      "branch",
      "--show-current",
    ])).exitCode).toBe(0);
    expect((await runner.run(repository, [
      "worktree",
      "add",
      "--detach",
      checkout,
      "HEAD",
    ])).exitCode).toBe(0);
    expect((await runner.run(repository, [
      "worktree",
      "remove",
      "--force",
      checkout,
    ])).exitCode).toBe(0);
    expect(await Bun.file(checkout).exists()).toBeFalse();
  }, 20_000);

  test("admits only the fixed environment and safety argv", async () => {
    const fixture = await fixtureRunner([
      "for argument in \"$@\"; do",
      "  if [ \"$argument\" = config ]; then exit 0; fi",
      "done",
      "/usr/bin/env",
      "printf '%s\\n' '---ARGS---'",
      "for argument in \"$@\"; do",
      "  printf 'ARG=%s\\n' \"$argument\"",
      "done",
    ]);
    const hostile = "/private/hostile-parent-value";
    const runner = new BundledGitRunner(fixture.paths, {
      CODEX_HOME: hostile,
      DYLD_INSERT_LIBRARIES: hostile,
      GIT_CONFIG_GLOBAL: hostile,
      HOME: hostile,
      HTTPS_PROXY: hostile,
      SECRET_TOKEN: hostile,
    }, unsafePathExecution);

    const result = await runner.run(fixture.root, [
      "status",
      "--porcelain=v1",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("HOME=/var/empty");
    expect(result.stdout).toContain("GIT_CONFIG_GLOBAL=/dev/null");
    expect(result.stdout).toContain("GIT_CONFIG_NOSYSTEM=1");
    expect(result.stdout).toContain("GIT_NO_LAZY_FETCH=1");
    expect(result.stdout).toContain("GIT_NO_REPLACE_OBJECTS=1");
    expect(result.stdout).toContain("GIT_TERMINAL_PROMPT=0");
    expect(result.stdout).toContain(`GIT_EXEC_PATH=${join(
      fixture.paths.gitRoot,
      "libexec",
      "git-core",
    )}`);
    expect(result.stdout).not.toContain(hostile);
    expect(result.stdout).not.toContain("SECRET_TOKEN");
    expect(result.stdout).not.toContain("DYLD_INSERT_LIBRARIES");
    const observedArguments = result.stdout
      .split("\n")
      .filter((line) => line.startsWith("ARG="))
      .map((line) => line.slice("ARG=".length));
    expect(observedArguments.slice(0, 3)).toEqual([
      "--no-replace-objects",
      "--no-pager",
      "--no-optional-locks",
    ]);
    expect(observedArguments).toContain("core.hooksPath=/dev/null");
    expect(observedArguments).toContain("core.fsmonitor=false");
    expect(observedArguments).toContain("credential.helper=");
    expect(observedArguments).toContain("protocol.ext.allow=never");
    expect(observedArguments.slice(-2)).toEqual([
      "status",
      "--porcelain=v1",
    ]);
  }, 20_000);

  test("rejects caller configuration switches before starting Git", async () => {
    const fixture = await fixtureRunner([
      "/usr/bin/touch \"$PWD/git-started\"",
    ]);
    const runner = new BundledGitRunner(
      fixture.paths,
      process.env,
      unsafePathExecution,
    );

    const error = await executionFailure(
      runner.run(fixture.root, [
        "-c",
        "filter.evil.clean=/private/untrusted-filter",
        "status",
      ]),
    );

    expect(error.reason).toBe("invalid_arguments");
    expect(await Bun.file(join(fixture.root, "git-started")).exists()).toBeFalse();
  });

  test.each([
    ["stdout", "stdout_limit"],
    ["stderr", "stderr_limit"],
  ] as const)(
    "stops the process tree when %s exceeds its byte budget",
    async (stream, expectedReason) => {
      const redirection = stream === "stderr" ? " >&2" : "";
      const fixture = await fixtureRunner([
        "for argument in \"$@\"; do",
        "  if [ \"$argument\" = config ]; then exit 0; fi",
        "done",
        "while :; do",
        `  printf '0123456789abcdef0123456789abcdef\\n'${redirection}`,
        "done",
      ]);
      const runner = new BundledGitRunner(
        fixture.paths,
        process.env,
        unsafePathExecution,
      );
      const startedAt = performance.now();

      const error = await executionFailure(
        runner.run(fixture.root, ["status"], {
          killGraceMs: 1_000,
          stderrLimitBytes: 128,
          stdoutLimitBytes: 128,
          terminateGraceMs: 50,
          timeoutMs: 5_000,
        }),
      );

      expect(error.reason).toBe(expectedReason);
      expect(performance.now() - startedAt).toBeLessThan(5_000);
    },
    10_000,
  );

  test("uses a monotonic deadline and TERM-to-KILL cleanup for stubborn descendants", async () => {
    if (process.platform === "win32") return;
    const fixture = await fixtureRunner([
      "for argument in \"$@\"; do",
      "  if [ \"$argument\" = config ]; then exit 0; fi",
      "done",
      "trap '' TERM",
      "/bin/sh -c 'trap \"\" TERM; echo $$ > \"$1\"; while :; do /bin/sleep 60; done' child \"$PWD/grandchild.pid\" &",
      "while :; do /bin/sleep 60; done",
    ]);
    const runner = new BundledGitRunner(
      fixture.paths,
      process.env,
      unsafePathExecution,
    );
    const startedAt = performance.now();

    const error = await executionFailure(
      runner.run(fixture.root, ["status"], {
        killGraceMs: 1_500,
        stderrLimitBytes: 1_024,
        stdoutLimitBytes: 1_024,
        terminateGraceMs: 50,
        timeoutMs: 1_000,
      }),
    );

    expect(error.reason).toBe("timeout");
    const elapsed = performance.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(850);
    expect(elapsed).toBeLessThan(4_000);
    const grandchildPid = Number(
      (await readFile(join(fixture.root, "grandchild.pid"), "utf8")).trim(),
    );
    expect(Number.isSafeInteger(grandchildPid)).toBeTrue();
    try {
      for (
        let attempt = 0;
        attempt < 40 && processExists(grandchildPid);
        attempt += 1
      ) {
        await Bun.sleep(25);
      }
      expect(processExists(grandchildPid)).toBeFalse();
    } finally {
      if (processExists(grandchildPid)) {
        process.kill(grandchildPid, "SIGKILL");
      }
    }
  }, 10_000);

  test("fatal Git uncertainty leaves the old generation for Native to fence before relaunch", async () => {
    if (process.platform !== "darwin") return;
    if (descriptorExecutorBinary === null) {
      throw new Error("Git directory executor was not built");
    }
    const root = await temporaryRoot("oprte-git-fatal-generation-");
    const repository = join(root, "repository");
    const checkout = join(root, "interrupted-checkout");
    const codexHome = join(root, "codex-home");
    await mkdir(codexHome);
    await initializeRepository(repository, "fatal-generation\n");
    const bulk = join(repository, "bulk");
    await mkdir(bulk);
    for (let offset = 0; offset < 4_096; offset += 64) {
      await Promise.all(Array.from({ length: 64 }, async (_, index) => {
        const ordinal = String(offset + index).padStart(4, "0");
        await writeFile(join(bulk, `${ordinal}.txt`), `${ordinal}\n`.repeat(16));
      }));
    }
    await runRawGit(["-C", repository, "add", "bulk"]);
    await runRawGit([
      "-C",
      repository,
      "commit",
      "--quiet",
      "-m",
      "bulk fixture",
    ]);

    const child = Bun.spawn([
      process.execPath,
      join(import.meta.dir, "fixtures", "git-generation-fatal.ts"),
    ], {
      cwd: join(import.meta.dir, "..", ".."),
      detached: true,
      env: {
        LANG: "C",
        LC_ALL: "C",
        HRA_TEST_CHECKOUT: checkout,
        HRA_TEST_CODEX_HOME: codexHome,
        HRA_TEST_GIT_BINARY: bundledGitBinary,
        HRA_TEST_GIT_EXECUTOR: descriptorExecutorBinary,
        HRA_TEST_GIT_ROOT: bundledGitRoot,
        HRA_TEST_REPOSITORY: repository,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
      },
      stderr: "ignore",
      stdout: "ignore",
    });
    const generationProcessId = child.pid;
    let fenced = false;
    try {
      expect(await child.exited).toBe(86);
      expect(processGroupExists(generationProcessId)).toBeTrue();

      // This is the Native handoff: one signal to the still-owned old PGID,
      // followed only by absence polling. No new runner starts beforehand.
      process.kill(-generationProcessId, "SIGKILL");
      for (
        let attempt = 0;
        attempt < 200 && processGroupExists(generationProcessId);
        attempt += 1
      ) {
        await Bun.sleep(10);
      }
      expect(processGroupExists(generationProcessId)).toBeFalse();
      fenced = true;

      const nextRepository = join(root, "next-repository");
      const nextCheckout = join(root, "next-checkout");
      await initializeRepository(nextRepository, "next-generation\n");
      const next = new BundledGitRunner(
        runtimePaths(codexHome, bundledGitBinary, bundledGitRoot),
        process.env,
        descriptorExecution(),
      );
      expect((await next.run(nextRepository, [
        "worktree",
        "add",
        "--detach",
        nextCheckout,
        "HEAD",
      ])).exitCode).toBe(0);
      expect((await next.run(nextRepository, [
        "worktree",
        "remove",
        "--force",
        nextCheckout,
      ])).exitCode).toBe(0);
    } finally {
      if (!fenced && processGroupExists(generationProcessId)) {
        process.kill(-generationProcessId, "SIGKILL");
      }
    }
  }, 60_000);

  test("applies one caller deadline across configuration inspection and the command", async () => {
    const fixture = await fixtureRunner([
      "for argument in \"$@\"; do",
      "  if [ \"$argument\" = config ]; then",
      "    /bin/sleep 0.35",
      "    exit 0",
      "  fi",
      "done",
      "/bin/sleep 0.35",
    ]);
    const runner = new BundledGitRunner(
      fixture.paths,
      process.env,
      unsafePathExecution,
    );
    const startedAt = performance.now();

    const error = await executionFailure(
      runner.run(fixture.root, ["status"], {
        killGraceMs: 500,
        terminateGraceMs: 50,
        timeoutMs: 500,
      }),
    );

    expect(error.reason).toBe("timeout");
    const elapsed = performance.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(400);
    expect(elapsed).toBeLessThan(1_500);
  }, 5_000);

  test.each(["local", "worktree"] as const)(
    "rejects a repo-%s clean filter before the requested Git command",
    async (scope) => {
      const root = await temporaryRoot("oprte-real-git-");
      const repository = join(root, "repository");
      const codexHome = join(root, "codex-home");
      await mkdir(codexHome);
      await runRawGit(["init", "--quiet", repository]);
      await writeFile(join(repository, ".gitattributes"), "payload filter=evil\n");
      await writeFile(join(repository, "payload"), "original\n");
      await runRawGit(["-C", repository, "config", "user.email", "fixture@example.test"]);
      await runRawGit(["-C", repository, "config", "user.name", "Fixture"]);
      await runRawGit(["-C", repository, "add", ".gitattributes", "payload"]);
      await runRawGit(["-C", repository, "commit", "--quiet", "-m", "fixture"]);
      const sentinel = join(root, "filter-ran");
      if (scope === "worktree") {
        await runRawGit([
          "-C",
          repository,
          "config",
          "extensions.worktreeConfig",
          "true",
        ]);
      }
      await runRawGit([
        "-C",
        repository,
        "config",
        `--${scope}`,
        "filter.evil.clean",
        `/bin/sh -c '/usr/bin/touch "${sentinel}"; /bin/cat'`,
      ]);
      await writeFile(join(repository, "payload"), "modified\n");
      const runner = new BundledGitRunner(
        runtimePaths(codexHome, bundledGitBinary, bundledGitRoot),
        process.env,
        descriptorExecution(),
      );

      const error = await executionFailure(
        runner.run(repository, [
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
        ]),
      );

      expect(error.reason).toBe("unsafe_configuration");
      expect(await Bun.file(sentinel).exists()).toBeFalse();
    },
    15_000,
  );

  test("denies executable repository config added after safety inspection", async () => {
    if (process.platform !== "darwin") return;
    const root = await temporaryRoot("oprte-real-git-config-race-");
    const repository = join(root, "repository");
    const codexHome = join(root, "codex-home");
    await mkdir(codexHome);
    await runRawGit(["init", "--quiet", repository]);
    await writeFile(
      join(repository, ".gitattributes"),
      "payload filter=late\n",
    );
    await writeFile(join(repository, "payload"), "original\n");
    await runRawGit([
      "-C",
      repository,
      "config",
      "user.email",
      "fixture@example.test",
    ]);
    await runRawGit([
      "-C",
      repository,
      "config",
      "user.name",
      "Fixture",
    ]);
    await runRawGit([
      "-C",
      repository,
      "add",
      ".gitattributes",
      "payload",
    ]);
    await runRawGit([
      "-C",
      repository,
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ]);
    await writeFile(join(repository, "payload"), "modified\n");
    const sentinel = join(root, "late-filter-ran");
    const runner = new BundledGitRunner(
      runtimePaths(codexHome, bundledGitBinary, bundledGitRoot),
      process.env,
      descriptorExecution({
        afterConfigurationInspection() {
          appendFileSync(
            join(repository, ".git", "config"),
            `\n[filter "late"]\n\tclean = /bin/sh -c '/usr/bin/touch ${sentinel}; /bin/cat'\n`,
          );
        },
      }),
    );

    const result = await runner.run(repository, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);

    expect(await Bun.file(sentinel).exists()).toBeFalse();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("payload");
  }, 15_000);

  test("runs the real bundled Git with global and system configuration disabled", async () => {
    const root = await temporaryRoot("oprte-real-git-smoke-");
    const repository = join(root, "repository");
    const codexHome = join(root, "codex-home");
    await mkdir(codexHome);
    await runRawGit(["init", "--quiet", repository]);
    const runner = new BundledGitRunner(
      runtimePaths(codexHome, bundledGitBinary, bundledGitRoot),
      {
        GIT_CONFIG_GLOBAL: join(root, "must-not-be-read"),
        HOME: join(root, "must-not-be-home"),
      },
      descriptorExecution(),
    );

    const result = await runner.run(repository, [
      "rev-parse",
      "--show-toplevel",
    ]);

    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: await realpath(repository),
    });
  }, 10_000);

  test("binds worktree mutation to the inspected repository descriptor", async () => {
    if (process.platform !== "darwin") return;
    const root = await temporaryRoot("oprte-real-git-path-race-");
    const repository = join(root, "repository");
    const replacement = join(root, "replacement");
    const displaced = join(root, "inspected-repository");
    const checkout = join(root, "checkout");
    const codexHome = join(root, "codex-home");
    await mkdir(codexHome);
    await initializeRepository(repository, "inspected\n");
    const inspectedCommit = await runRawGitCapture([
      "-C",
      repository,
      "rev-parse",
      "HEAD",
    ]);
    await initializeRepository(replacement, "replacement\n");
    let swapped = false;
    const runner = new BundledGitRunner(
      runtimePaths(codexHome, bundledGitBinary, bundledGitRoot),
      process.env,
      descriptorExecution({
        afterConfigurationInspection() {
          if (swapped) return;
          renameSync(repository, displaced);
          renameSync(replacement, repository);
          swapped = true;
        },
      }),
    );

    const result = await runner.run(repository, [
      "worktree",
      "add",
      "--detach",
      checkout,
      inspectedCommit,
    ]);

    expect(result.exitCode).toBe(0);
    expect(await readFile(join(checkout, "payload"), "utf8")).toBe(
      "inspected\n",
    );
    expect(await runRawGitCapture([
      "-C",
      displaced,
      "worktree",
      "list",
      "--porcelain",
    ])).toContain(checkout);
    expect(await runRawGitCapture([
      "-C",
      repository,
      "worktree",
      "list",
      "--porcelain",
    ])).not.toContain(checkout);

    const independentRunner = new BundledGitRunner(
      runtimePaths(codexHome, bundledGitBinary, bundledGitRoot),
      process.env,
      descriptorExecution(),
    );
    const reuseError = await executionFailure(
      independentRunner.run(repository, ["show-ref", "--head"]),
    );
    expect(reuseError.reason).toBe("unsafe_configuration");
  }, 20_000);

  test("queues sixty-four concurrent descriptor-bound worktrees within one FD budget", async () => {
    if (process.platform !== "darwin") return;
    const root = await temporaryRoot("oprte-real-git-sixty-four-worktrees-");
    const repository = join(root, "repository");
    const codexHome = join(root, "codex-home");
    await mkdir(codexHome);
    await initializeRepository(repository, "sixty-four\n");
    const worktrees = Array.from(
      { length: 64 },
      (_, index) => join(root, `lane-${String(index + 1).padStart(2, "0")}`),
    );
    for (const checkout of worktrees) {
      await runRawGit([
        "-C",
        repository,
        "worktree",
        "add",
        "--quiet",
        "--detach",
        checkout,
        "HEAD",
      ]);
    }
    const runner = new BundledGitRunner(
      runtimePaths(codexHome, bundledGitBinary, bundledGitRoot),
      process.env,
      descriptorExecution(),
    );

    const observed = await Promise.all(worktrees.map(async (checkout) => {
      const result = await runner.run(checkout, [
        "rev-parse",
        "--show-toplevel",
      ], { timeoutMs: 30_000 });
      expect(result.exitCode).toBe(0);
      return result.stdout;
    }));
    expect(observed).toEqual(await Promise.all(
      worktrees.map(async (checkout) => await realpath(checkout)),
    ));
    expect(new Set(observed).size).toBe(64);
  }, 60_000);

  test("fails closed when Darwin Git executables are not sealed Mach-O inputs", async () => {
    if (process.platform !== "darwin") return;
    const fixture = await fixtureRunner(["exit 0"]);

    const scriptError = constructionFailure(() => {
      new BundledGitRunner(
        fixture.paths,
        process.env,
        descriptorExecution(),
      );
    });
    expect(scriptError.reason).toBe("unsafe_configuration");

    const missingCoreError = constructionFailure(() => {
      new BundledGitRunner(
        runtimePaths(
          fixture.paths.codexHome,
          bundledGitBinary,
          fixture.paths.gitRoot,
        ),
        process.env,
        descriptorExecution(),
      );
    });
    expect(missingCoreError.reason).toBe("unsafe_configuration");

    const scriptHelperError = constructionFailure(() => {
      new BundledGitRunner(
        runtimePaths(
          fixture.paths.codexHome,
          bundledGitBinary,
          bundledGitRoot,
        ),
        process.env,
        { descriptorExecutorBinary: fixture.paths.gitBinary },
      );
    });
    expect(scriptHelperError.reason).toBe("unsafe_configuration");
  });

  test("ignores replace refs when materializing a caller-selected commit", async () => {
    const root = await temporaryRoot("oprte-real-git-replace-ref-");
    const repository = join(root, "repository");
    const checkout = join(root, "checkout");
    const codexHome = join(root, "codex-home");
    await mkdir(codexHome);
    await runRawGit(["init", "--quiet", repository]);
    await runRawGit(["-C", repository, "config", "user.email", "fixture@example.test"]);
    await runRawGit(["-C", repository, "config", "user.name", "Fixture"]);
    await writeFile(join(repository, "payload"), "original\n");
    await runRawGit(["-C", repository, "add", "payload"]);
    await runRawGit(["-C", repository, "commit", "--quiet", "-m", "original"]);
    const originalCommit = await runRawGitCapture([
      "-C",
      repository,
      "rev-parse",
      "HEAD",
    ]);
    await writeFile(join(repository, "payload"), "replacement\n");
    await runRawGit(["-C", repository, "commit", "--quiet", "-am", "replacement"]);
    const replacementCommit = await runRawGitCapture([
      "-C",
      repository,
      "rev-parse",
      "HEAD",
    ]);
    await runRawGit([
      "-C",
      repository,
      "replace",
      originalCommit,
      replacementCommit,
    ]);
    const runner = new BundledGitRunner(
      runtimePaths(codexHome, bundledGitBinary, bundledGitRoot),
      process.env,
      descriptorExecution(),
    );

    const result = await runner.run(repository, [
      "worktree",
      "add",
      "--detach",
      checkout,
      originalCommit,
    ]);

    expect(result.exitCode).toBe(0);
    expect(await readFile(join(checkout, "payload"), "utf8")).toBe("original\n");
  }, 15_000);

  test("serializable failures never retain argv or child diagnostics", () => {
    const secretArgument = "/private/secret-repository";
    const secretDiagnostic = "credential helper emitted a private token";
    const commandError = new GitCommandError(
      ["status", secretArgument],
      {
        exitCode: 128,
        stderr: secretDiagnostic,
        stdout: "",
      },
    );
    const executionError = new GitExecutionError("spawn_failed");
    const serialized = JSON.stringify({ commandError, executionError });
    const visible = `${commandError.name}: ${commandError.message}\n`
      + `${executionError.name}: ${executionError.message}\n`
      + serialized;

    expect(visible).not.toContain(secretArgument);
    expect(visible).not.toContain(secretDiagnostic);
    expect(commandError.exitCode).toBe(128);
    expect(executionError.message.length).toBeLessThan(100);
  });
});

async function fixtureRunner(
  scriptLines: readonly string[],
): Promise<{
  readonly paths: RuntimePaths;
  readonly root: string;
}> {
  const root = await temporaryRoot("oprte-git-runner-");
  const codexHome = join(root, "codex-home");
  const gitRoot = join(root, "git");
  const gitBinary = join(gitRoot, "bin", "git");
  await mkdir(codexHome);
  await mkdir(join(gitRoot, "bin"), { recursive: true });
  await writeFile(
    gitBinary,
    ["#!/bin/sh", ...scriptLines, ""].join("\n"),
  );
  await chmod(gitBinary, 0o700);
  return {
    paths: runtimePaths(codexHome, gitBinary, gitRoot),
    root,
  };
}

function runtimePaths(
  codexHome: string,
  gitBinary: string,
  gitRoot: string,
): RuntimePaths {
  return {
    bunBinary: process.execPath,
    codexBinary: "/usr/bin/true",
    codexHome,
    gitBinary,
    gitRoot,
  };
}

function descriptorExecution(
  instrumentation: GitRunnerInstrumentation = {},
): GitRunnerInstrumentation {
  return descriptorExecutorBinary === null
    ? instrumentation
    : { ...instrumentation, descriptorExecutorBinary };
}

async function initializeRepository(
  repository: string,
  payload: string,
): Promise<void> {
  await runRawGit(["init", "--quiet", repository]);
  await runRawGit([
    "-C",
    repository,
    "config",
    "user.email",
    "fixture@example.test",
  ]);
  await runRawGit([
    "-C",
    repository,
    "config",
    "user.name",
    "Fixture",
  ]);
  await writeFile(join(repository, "payload"), payload);
  await runRawGit(["-C", repository, "add", "payload"]);
  await runRawGit([
    "-C",
    repository,
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

async function executionFailure(
  promise: Promise<unknown>,
): Promise<GitExecutionError> {
  try {
    await promise;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(GitExecutionError);
    if (error instanceof GitExecutionError) return error;
    throw error;
  }
  throw new Error("Expected bundled Git execution to fail.");
}

function constructionFailure(
  construct: () => void,
): GitExecutionError {
  try {
    construct();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(GitExecutionError);
    if (error instanceof GitExecutionError) return error;
    throw error;
  }
  throw new Error("Expected bundled Git construction to fail.");
}

async function runRawGit(args: readonly string[]): Promise<void> {
  const child = Bun.spawn([bundledGitBinary, ...args], {
    env: {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      HOME: "/var/empty",
      LANG: "C",
      LC_ALL: "C",
      PATH: `${join(bundledGitRoot, "bin")}:/usr/bin:/bin`,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`Git fixture setup failed with code ${String(exitCode)}: ${stderr}`);
  }
}

async function runRawGitCapture(args: readonly string[]): Promise<string> {
  const child = Bun.spawn([bundledGitBinary, ...args], {
    env: {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      HOME: "/var/empty",
      LANG: "C",
      LC_ALL: "C",
      PATH: `${join(bundledGitRoot, "bin")}:/usr/bin:/bin`,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `Git fixture setup failed with code ${String(exitCode)}: ${stderr}`,
    );
  }
  return stdout.trim();
}

function processExists(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
