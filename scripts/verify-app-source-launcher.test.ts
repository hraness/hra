import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  appSourceProofChildEnvironment,
  appSourceProofLauncherErrorCodes,
  appSourceProofRuntimeInjectionEnvironmentNames,
  assertHardenedAppSourceProofStageZero,
  commandCapacityChildEnvironment,
  createAppSourceProofScratchDirectory,
  executeAppSourceProofLauncher,
  parseAppSourceProofLauncherArguments,
  type AppSourceProofLauncherDependencies,
} from "./verify-app-source-launcher";

const sourceCommit = "6".repeat(40);
const deploymentId = "dpl_AppSourceProof123456789012345";
const evidencePath = "/protected/release/app-source-proof.json";
const credentialPath = "/protected/credentials/vercel-auth.json";
const releaseVersion = "0.6.1";
const trackedDocument = "{}\n";
const hardenedRuntimeArguments = ["--no-env-file", "--config=/dev/null"] as const;
const trustedScratchRoot = realpathSync("/tmp");
const trackedObjectId = createHash("sha1")
  .update(`blob ${String(Buffer.byteLength(trackedDocument))}\0`)
  .update(trackedDocument)
  .digest("hex");

const proveArguments = [
  "prove",
  "--deployment-id",
  deploymentId,
  "--evidence-path",
  evidencePath,
  "--release-version",
  releaseVersion,
  "--source-commit",
  sourceCommit,
  "--vercel-auth-path",
  credentialPath,
] as const;
const commandCapacityArguments = [
  "command-capacity",
  "status",
  "--source-commit",
  sourceCommit,
  "--deploy-evidence",
  "/protected/deploy.json",
  "--prod",
] as const;

type CommandResult = Readonly<{
  exitCode: number;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
}>;

const result = (stdout = "", exitCode = 0): CommandResult => ({
  exitCode,
  signal: null,
  stderr: "",
  stdout,
});

const output = (): { readonly lines: string[]; readonly writer: { write(value: string): void } } => {
  const lines: string[] = [];
  return { lines, writer: { write: (value) => { lines.push(value); } } };
};

const launcherFixture = (overrides: Readonly<{
  childExitCode?: number;
  cleanupLeavesRegistered?: boolean;
  hiddenIndex?: boolean;
  installFails?: boolean;
  mainAdvancesAfterFirstRead?: boolean;
  maskedOrigin?: boolean;
  remoteMain?: string;
  sshOrigin?: boolean;
  worktreeAddFails?: boolean;
  wrongOrigin?: boolean;
}> = {}): Readonly<{
  cleanup: () => void;
  dependencies: AppSourceProofLauncherDependencies;
  events: string[];
  root: string;
}> => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "hra-app-launch-root-"));
  const scratch = mkdtempSync(join(trustedScratchRoot, "hra-app-source-verifier-"));
  writeFileSync(join(root, "package.json"), trackedDocument);
  const events: string[] = [];
  let mainReadCount = 0;
  let worktreeRegistered = false;
  const runCommand: NonNullable<AppSourceProofLauncherDependencies["runCommand"]> = (
    command,
    options,
  ) => {
    const key = command.join("\0");
    events.push(`command:${options.cwd}:${key}:${String(options.credentialDescriptor ?? "none")}`);
    if (key.includes("\0rev-parse\0--show-toplevel")) return result(options.cwd);
    if (key.includes("\0rev-parse\0--verify\0HEAD^{commit}")) return result(`${sourceCommit}\n`);
    if (key.includes("\0rev-parse\0--show-object-format")) return result("sha1\n");
    if (key.includes("\0config\0--null\0--list")) {
      return result(overrides.maskedOrigin === true
        ? "core.repositoryformatversion\n0\0remote.origin.url\nhttps://attacker.invalid/hra.git\0url.https://github.com/hraness/hra.git.insteadof\nhttps://attacker.invalid/hra.git\0"
        : `core.repositoryformatversion\n0\0remote.origin.url\n${overrides.wrongOrigin === true
          ? "https://github.com/attacker/hra.git"
          : overrides.sshOrigin === true
            ? "git@github.com:hraness/hra.git"
            : "https://github.com/hraness/hra.git"}\0`);
    }
    if (key.includes("\0status\0--porcelain=v1\0--untracked-files=all")) return result();
    if (key.includes("\0ls-files\0-v\0-z")) {
      return result(overrides.hiddenIndex === true ? "S package.json\0" : "H package.json\0");
    }
    if (key.includes("\0ls-tree\0-r\0-z\0--full-tree")) {
      return result(`100644 blob ${trackedObjectId}\tpackage.json\0`);
    }
    if (key.includes("\0ls-files\0--stage\0-z")) {
      return result(`100644 ${trackedObjectId} 0\tpackage.json\0`);
    }
    if (key.includes("\0remote\0get-url\0--all\0origin")) {
      return result(overrides.wrongOrigin === true
        ? "https://github.com/attacker/hra.git\n"
        : overrides.sshOrigin === true
          ? "git@github.com:hraness/hra.git\n"
          : "https://github.com/hraness/hra.git\n");
    }
    if (key.includes("\0remote\0get-url\0--push\0--all\0origin")) {
      return result(overrides.sshOrigin === true
        ? "git@github.com:hraness/hra.git\n"
        : "https://github.com/hraness/hra.git\n");
    }
    if (key.includes("\0ls-remote\0--heads\0https://github.com/hraness/hra.git\0refs/heads/main")) {
      mainReadCount += 1;
      const current = overrides.mainAdvancesAfterFirstRead === true && mainReadCount > 2
        ? "7".repeat(40)
        : overrides.remoteMain ?? sourceCommit;
      return result(`${current}\trefs/heads/main\n`);
    }
    if (key.includes("\0worktree\0add\0--detach")) {
      if (overrides.worktreeAddFails === true) return result("", 1);
      worktreeRegistered = true;
      mkdirSync(join(scratch, "source"), { recursive: true });
      writeFileSync(join(scratch, "source", "package.json"), trackedDocument);
      return result();
    }
    if (key.includes("\0worktree\0list\0--porcelain")) {
      return result(worktreeRegistered ? `worktree ${join(scratch, "source")}\n\n` : "");
    }
    if (key.includes("\0worktree\0remove\0--force")) {
      if (overrides.cleanupLeavesRegistered !== true) worktreeRegistered = false;
      return result();
    }
    if (key.includes("\0install\0--frozen-lockfile\0--ignore-scripts\0--backend=copyfile")) {
      return result("", overrides.installFails === true ? 1 : 0);
    }
    if (key.includes("/scripts/verify-app-source.ts\0")) {
      return result(
        overrides.childExitCode === 1
          ? ""
          : '{"kind":"hra-app-source-proof","schemaVersion":2}\n',
        overrides.childExitCode ?? 0,
      );
    }
    if (key.includes("/scripts/manage-command-lifecycle-capacity.ts\0")) {
      events.push(`capacity-environment:${JSON.stringify(options.environment ?? {})}`);
      return result('{"state":"ready"}\n');
    }
    throw new Error(`Unexpected command: ${key}`);
  };
  return {
    cleanup: () => {
      rmSync(root, { force: true, recursive: true });
      rmSync(scratch, { force: true, recursive: true });
    },
    dependencies: {
      closeCredential: () => { events.push("credential:closed"); },
      createScratchDirectory: () => {
        events.push("scratch:created");
        return scratch;
      },
      cwd: root,
      openCredential: (path) => {
        events.push(`credential:opened:${path}`);
        return 9;
      },
      removeScratchDirectory: (path) => {
        events.push(`scratch:removed:${path}`);
        rmSync(path, { force: true, recursive: true });
      },
      runCommand,
      runtimePath: "/trusted/bun",
      runtimeArguments: hardenedRuntimeArguments,
      runtimeEnvironment: {},
      runtimeVersion: "1.3.14",
      validateCredential: () => { events.push("credential:validated"); },
    },
    events,
    root,
  };
};

const runFixtureGit = (root: string, arguments_: readonly string[]): string => {
  const invocation = spawnSync("/usr/bin/git", arguments_, {
    cwd: root,
    encoding: "utf8",
    env: appSourceProofChildEnvironment(),
    maxBuffer: 2 * 1024 * 1024,
  });
  if (invocation.status !== 0 || invocation.signal !== null) {
    throw new Error(`Fixture Git command failed: ${arguments_.join(" ")}\n${invocation.stderr}`);
  }
  return invocation.stdout;
};

const realRepositoryLauncherFixture = (
  files: Readonly<Record<string, string>>,
): Readonly<{
  arguments: readonly string[];
  cleanup: () => void;
  dependencies: AppSourceProofLauncherDependencies;
  events: string[];
  git: (arguments_: readonly string[]) => string;
  root: string;
}> => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "hra-app-launch-real-root-"));
  const scratch = mkdtempSync(join(trustedScratchRoot, "hra-app-source-verifier-"));
  const events: string[] = [];
  const git = (arguments_: readonly string[]): string => runFixtureGit(root, arguments_);
  git(["init", "--quiet"]);
  git(["config", "user.email", "fixture@hra.invalid"]);
  git(["config", "user.name", "HRA Fixture"]);
  git(["remote", "add", "origin", "https://github.com/hraness/hra.git"]);
  for (const [path, document] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, document);
  }
  git(["add", "--all"]);
  git(["commit", "--quiet", "--message", "fixture"]);
  const commit = git(["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  const arguments_ = [
    "prove",
    "--deployment-id",
    deploymentId,
    "--evidence-path",
    evidencePath,
    "--release-version",
    releaseVersion,
    "--source-commit",
    commit,
    "--vercel-auth-path",
    credentialPath,
  ] as const;
  const runCommand: NonNullable<AppSourceProofLauncherDependencies["runCommand"]> = (
    command,
    options,
  ) => {
    const key = command.join("\0");
    events.push(`command:${options.cwd}:${key}:${String(options.credentialDescriptor ?? "none")}`);
    if (key.includes("\0ls-remote\0--heads\0https://github.com/hraness/hra.git\0refs/heads/main")) {
      return result(`${commit}\trefs/heads/main\n`);
    }
    if (command[0] === "/trusted/bun") {
      if (command[3] === "install") return result();
      if (command[3]?.endsWith("/scripts/verify-app-source.ts") === true) {
        return result('{"kind":"hra-app-source-proof","schemaVersion":2}\n');
      }
    }
    const executable = command[0];
    if (executable === undefined) return result("", 1);
    const invocation = spawnSync(executable, command.slice(1), {
      cwd: options.cwd,
      encoding: "utf8",
      env: appSourceProofChildEnvironment(),
      maxBuffer: options.maximumOutputBytes ?? 64 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      exitCode: invocation.status ?? 1,
      signal: invocation.signal,
      stderr: invocation.stderr,
      stdout: invocation.stdout,
    };
  };
  return {
    arguments: arguments_,
    cleanup: () => {
      rmSync(scratch, { force: true, recursive: true });
      try {
        git(["worktree", "prune"]);
      } catch {
        // The root may already have been removed after a completed cleanup.
      }
      rmSync(root, { force: true, recursive: true });
    },
    dependencies: {
      closeCredential: () => { events.push("credential:closed"); },
      createScratchDirectory: () => {
        events.push("scratch:created");
        return scratch;
      },
      cwd: root,
      openCredential: (path) => {
        events.push(`credential:opened:${path}`);
        return 9;
      },
      removeScratchDirectory: (path) => {
        events.push(`scratch:removed:${path}`);
        rmSync(path, { force: true, recursive: true });
      },
      runCommand,
      runtimePath: "/trusted/bun",
      runtimeArguments: hardenedRuntimeArguments,
      runtimeEnvironment: {},
      runtimeVersion: "1.3.14",
      validateCredential: () => { events.push("credential:validated"); },
    },
    events,
    git,
    root,
  };
};

describe("HRA browser app source proof launcher", () => {
  test("parses exact stable proof and retained-verification inputs", () => {
    expect(parseAppSourceProofLauncherArguments(proveArguments)).toEqual({
      deploymentId,
      evidencePath,
      mode: "prove",
      releaseVersion,
      sourceCommit,
      vercelAuthPath: credentialPath,
    });
    expect(parseAppSourceProofLauncherArguments([
      "verify-retained",
      "--evidence-path",
      evidencePath,
      "--release-version",
      "1.0.0",
      "--source-commit",
      sourceCommit,
    ])).toEqual({
      evidencePath,
      mode: "verify-retained",
      releaseVersion: "1.0.0",
      sourceCommit,
    });
    expect(parseAppSourceProofLauncherArguments(commandCapacityArguments)).toEqual({
      mode: "command-capacity",
      operatorArguments: commandCapacityArguments.slice(1),
      sourceCommit,
    });
    for (const invalid of [
      proveArguments.slice(0, -2),
      [...proveArguments, "--unknown", "value"],
      [...proveArguments.slice(0, 7), "1.0.0-beta.1", ...proveArguments.slice(8)],
      [...proveArguments.slice(0, 7), `${"1".repeat(65)}.0.0`, ...proveArguments.slice(8)],
    ]) expect(() => parseAppSourceProofLauncherArguments(invalid)).toThrow("usage_invalid");
  });

  test("passes only a fixed non-provider environment with no hook or proxy input", () => {
    const environment = appSourceProofChildEnvironment();
    expect(Object.keys(environment).sort()).toEqual([
      "GCM_INTERACTIVE",
      "GIT_ATTR_NOSYSTEM",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_NO_REPLACE_OBJECTS",
      "GIT_OPTIONAL_LOCKS",
      "GIT_TERMINAL_PROMPT",
      "LANG",
      "LC_ALL",
      "PATH",
      "SSH_ASKPASS_REQUIRE",
      "TMPDIR",
      "TZ",
    ]);
    expect(environment.GIT_ATTR_NOSYSTEM).toBe("1");
    expect(environment.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(environment.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(environment.GIT_NO_REPLACE_OBJECTS).toBe("1");
    expect(environment.LANG).toBe("C");
    expect(environment.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
    expect(environment.TMPDIR).toBe("/tmp");
    for (const name of [
      "BUN_OPTIONS",
      "GH_TOKEN",
      "GIT_ASKPASS",
      "HTTPS_PROXY",
      "NODE_OPTIONS",
      "NPM_TOKEN",
      "SSL_CERT_FILE",
      "VERCEL_TOKEN",
    ]) {
      expect(environment[name]).toBeUndefined();
    }
  });

  test("launches command-capacity only from the sealed exact-commit tree", () => {
    const fixture = launcherFixture();
    const stdout = output();
    const stderr = output();
    try {
      expect(executeAppSourceProofLauncher(commandCapacityArguments, {
        ...fixture.dependencies,
        runtimeEnvironment: {
          HOME: fixture.root,
          NODE_OPTIONS: undefined,
        },
        stderr: stderr.writer,
        stdout: stdout.writer,
      })).toBe(0);
      expect(stderr.lines).toEqual([]);
      expect(stdout.lines).toEqual(['{"state":"ready"}\n']);
      const child = fixture.events.find((event) =>
        event.includes("/scripts/manage-command-lifecycle-capacity.ts"));
      expect(child).toContain("/hra-app-source-verifier-");
      expect(child).not.toContain(`${fixture.root}/scripts/manage-command-lifecycle-capacity.ts`);
      expect(fixture.events.some((event) => event.startsWith("credential:"))).toBe(false);
      expect(fixture.events.some((event) => event.includes("\0ls-remote\0"))).toBe(false);
      expect(fixture.events).toContain(`capacity-environment:${JSON.stringify(
        commandCapacityChildEnvironment({ HOME: fixture.root }),
      )}`);
    } finally {
      fixture.cleanup();
    }
  });

  test("requires a neutral stage-zero Bun invocation before launcher code runs", () => {
    expect(() => assertHardenedAppSourceProofStageZero(hardenedRuntimeArguments, {}))
      .not.toThrow();
    for (const runtimeArguments of [
      [],
      ["--config=/dev/null"],
      ["--no-env-file"],
      ["--no-env-file", "--config=./bunfig.toml"],
      ["--no-env-file", "--config=/dev/null", "--preload=./ambient.ts"],
      ["--no-env-file", "--config=/dev/null", "--env-file=.env"],
    ]) {
      expect(() => assertHardenedAppSourceProofStageZero(runtimeArguments, {}))
        .toThrow("runtime_environment_unsafe");
    }
    for (const name of appSourceProofRuntimeInjectionEnvironmentNames) {
      expect(() => assertHardenedAppSourceProofStageZero(
        hardenedRuntimeArguments,
        { [name]: "/untrusted/injection" },
      )).toThrow("runtime_environment_unsafe");
    }
    const runbook = readFileSync(join(import.meta.dir, "..", "docs", "hosted-sync.md"), "utf8");
    expect(runbook.match(/command bun --no-env-file --config=\/dev\/null/gu)).toHaveLength(3);
    expect(runbook).not.toContain("\nbun ./scripts/verify-app-source-launcher.ts");
    expect(runbook).not.toContain("bun run hosted:command-capacity");
    expect(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"))
      .not.toContain("hosted:command-capacity");

    const root = mkdtempSync(join(realpathSync(tmpdir()), "hra-app-source-stage-zero-"));
    const preload = join(root, "ambient-preload.ts");
    const sentinel = join(root, "ambient-preload-ran");
    try {
      writeFileSync(
        preload,
        `await Bun.write(${JSON.stringify(sentinel)}, "ambient preload executed\\n");\n`,
        { mode: 0o600 },
      );
      writeFileSync(join(root, "bunfig.toml"), `preload = [${JSON.stringify(preload)}]\n`);
      writeFileSync(join(root, ".env"), "NODE_OPTIONS=--require=/untrusted/from-dotenv.js\n");
      const invocation = spawnSync("/bin/sh", [
        "-c",
        `unset ${appSourceProofRuntimeInjectionEnvironmentNames.join(" ")} && command bun --no-env-file --config=/dev/null ${JSON.stringify(join(import.meta.dir, "verify-app-source-launcher.ts"))} verify-retained`,
      ], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          BUN_OPTIONS: `--preload=${preload}`,
        },
      });
      expect(invocation.status).toBe(1);
      expect(invocation.stdout).toBe("");
      expect(invocation.stderr).toContain('"code":"usage_invalid"');
      expect(() => readFileSync(sentinel)).toThrow();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("refuses a scratch directory selected through an unsafe ambient temporary parent", () => {
    const fixture = launcherFixture();
    const unsafeParent = mkdtempSync(join(trustedScratchRoot, "hra-app-unsafe-tmpdir-"));
    chmodSync(unsafeParent, 0o777);
    const unsafeScratch = mkdtempSync(join(unsafeParent, "hra-app-source-verifier-"));
    const stdout = output();
    const stderr = output();
    try {
      expect(executeAppSourceProofLauncher(proveArguments, {
        ...fixture.dependencies,
        createScratchDirectory: () => unsafeScratch,
        runtimeEnvironment: { TMPDIR: unsafeParent },
        stderr: stderr.writer,
        stdout: stdout.writer,
      })).toBe(1);
      expect(stdout.lines).toEqual([]);
      expect(stderr.lines.join("")).toContain('"code":"verifier_install_failed"');
      expect(fixture.events.some((event) => event.startsWith("credential:"))).toBe(false);
      expect(fixture.events.some((event) => event.includes("\0worktree\0add\0"))).toBe(false);
    } finally {
      fixture.cleanup();
      rmSync(unsafeParent, { force: true, recursive: true });
    }
  });

  test("the default scratch creator ignores ambient TMPDIR", () => {
    const unsafeParent = mkdtempSync(join(trustedScratchRoot, "hra-app-ambient-tmpdir-"));
    chmodSync(unsafeParent, 0o777);
    const previous = process.env.TMPDIR;
    let created: string | undefined;
    try {
      process.env.TMPDIR = unsafeParent;
      created = createAppSourceProofScratchDirectory();
      expect(dirname(created)).toBe(trustedScratchRoot);
      expect(dirname(created)).not.toBe(unsafeParent);
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
      if (created !== undefined) rmSync(created, { force: true, recursive: true });
      rmSync(unsafeParent, { force: true, recursive: true });
    }
  });

  test("imports only runtime builtins before creating the sealed verifier tree", () => {
    const source = readFileSync(join(import.meta.dir, "verify-app-source-launcher.ts"), "utf8");
    const imports = [...source.matchAll(/from\s+"([^"]+)"/gu)].map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((specifier) => specifier?.startsWith("node:") === true)).toBe(true);
  });

  test("accepts a real clean repository whose tracked bytes equal the exact commit blobs", () => {
    const fixture = realRepositoryLauncherFixture({ "package.json": trackedDocument });
    const stdout = output();
    const stderr = output();
    try {
      expect(executeAppSourceProofLauncher(fixture.arguments, {
        ...fixture.dependencies,
        stderr: stderr.writer,
        stdout: stdout.writer,
      })).toBe(0);
      expect(stderr.lines).toEqual([]);
      expect(stdout.lines.join("")).toContain('"schemaVersion":2');
      expect(fixture.events.some((event) => event.startsWith("credential:opened:"))).toBe(true);
      expect(fixture.events.some((event) => event.includes("\0ls-tree\0-r\0-z\0--full-tree")))
        .toBe(true);
      expect(fixture.events.some((event) => event.includes("\0ls-files\0--stage\0-z")))
        .toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test("rejects a real Git-clean smudge-filter checkout before scratch or credential access", () => {
    const fixture = realRepositoryLauncherFixture({
      ".gitattributes": "payload.txt filter=hra-proof\n",
      "payload.txt": "canonical\n",
    });
    const stdout = output();
    const stderr = output();
    try {
      fixture.git(["config", "filter.hra-proof.clean", "/usr/bin/sed s/transformed/canonical/g"]);
      fixture.git(["config", "filter.hra-proof.required", "true"]);
      fixture.git(["config", "filter.hra-proof.smudge", "/usr/bin/sed s/canonical/transformed/g"]);
      rmSync(join(fixture.root, "payload.txt"));
      fixture.git(["checkout", "--", "payload.txt"]);
      expect(readFileSync(join(fixture.root, "payload.txt"), "utf8")).toBe("transformed\n");
      expect(fixture.git(["status", "--porcelain=v1", "--untracked-files=all"])).toBe("");

      expect(executeAppSourceProofLauncher(fixture.arguments, {
        ...fixture.dependencies,
        stderr: stderr.writer,
        stdout: stdout.writer,
      })).toBe(1);
      expect(stdout.lines).toEqual([]);
      expect(stderr.lines.join("")).toContain('"code":"verifier_source_invalid"');
      expect(fixture.events.some((event) => event.startsWith("scratch:"))).toBe(false);
      expect(fixture.events.some((event) => event.startsWith("credential:"))).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test("raw-hash rejects a Git-clean attribute-transformed checkout", () => {
    const fixture = realRepositoryLauncherFixture({
      ".gitattributes": "payload.txt text eol=crlf\n",
      "payload.txt": "canonical\n",
    });
    const stdout = output();
    const stderr = output();
    try {
      rmSync(join(fixture.root, "payload.txt"));
      fixture.git(["checkout", "--", "payload.txt"]);
      expect(readFileSync(join(fixture.root, "payload.txt"), "utf8")).toBe("canonical\r\n");
      expect(fixture.git(["status", "--porcelain=v1", "--untracked-files=all"])).toBe("");

      expect(executeAppSourceProofLauncher(fixture.arguments, {
        ...fixture.dependencies,
        stderr: stderr.writer,
        stdout: stdout.writer,
      })).toBe(1);
      expect(stdout.lines).toEqual([]);
      expect(stderr.lines.join("")).toContain('"code":"verifier_source_invalid"');
      expect(fixture.events.some((event) => event.startsWith("scratch:"))).toBe(false);
      expect(fixture.events.some((event) => event.startsWith("credential:"))).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test("opens credentials only after source sealing and a second current-main proof", () => {
    const fixture = launcherFixture();
    const stdout = output();
    const stderr = output();
    try {
      const code = executeAppSourceProofLauncher(proveArguments, {
        ...fixture.dependencies,
        stderr: stderr.writer,
        stdout: stdout.writer,
      });
      expect(code).toBe(0);
      expect(stderr.lines).toEqual([]);
      expect(stdout.lines.join("")).toContain('"schemaVersion":2');
      const opened = fixture.events.findIndex((event) => event.startsWith("credential:opened:"));
      const installed = fixture.events.findIndex((event) => event.includes("\0install\0--frozen-lockfile"));
      const mainReads = fixture.events
        .map((event, index) => event.includes("\0ls-remote\0--heads\0https://github.com/hraness/hra.git") ? index : -1)
        .filter((index) => index >= 0);
      const child = fixture.events.findIndex((event) => event.includes("/scripts/verify-app-source.ts\0"));
      expect(installed).toBeGreaterThan(-1);
      expect(mainReads).toHaveLength(4);
      expect(mainReads.every((index) => fixture.events[index]?.startsWith("command:/:")))
        .toBe(true);
      expect(fixture.events
        .filter((event) => event.startsWith("command:") && event.includes("/usr/bin/git\0"))
        .every((event) => event.includes("\0core.hooksPath=/dev/null\0")))
        .toBe(true);
      const runtimeCommands = fixture.events.filter((event) =>
        event.includes(":/trusted/bun\0")
      );
      expect(runtimeCommands).toHaveLength(2);
      expect(runtimeCommands.every((event) => event.includes(
        ":/trusted/bun\0--no-env-file\0--config=/dev/null\0",
      ))).toBe(true);
      expect(opened).toBeGreaterThan(mainReads.at(-1) ?? Number.MAX_SAFE_INTEGER);
      expect(child).toBeGreaterThan(opened);
      expect(fixture.events.indexOf("credential:validated")).toBeGreaterThan(opened);
      expect(child).toBeGreaterThan(fixture.events.indexOf("credential:validated"));
      expect(fixture.events).toContain("credential:closed");
      expect(fixture.events.some((event) => event.includes("\0worktree\0remove\0--force"))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test("refuses hidden-index or stale-main source before scratch or credential access", () => {
    for (const options of [
      { hiddenIndex: true },
      { remoteMain: "7".repeat(40) },
      { maskedOrigin: true },
      { sshOrigin: true },
      { wrongOrigin: true },
    ]) {
      const fixture = launcherFixture(options);
      const stdout = output();
      const stderr = output();
      try {
        expect(executeAppSourceProofLauncher(proveArguments, {
          ...fixture.dependencies,
          stderr: stderr.writer,
          stdout: stdout.writer,
        })).toBe(1);
        expect(stdout.lines).toEqual([]);
        expect(stderr.lines.join("")).toContain('"code":"verifier_source_invalid"');
        expect(fixture.events.some((event) => event.startsWith("scratch:"))).toBe(false);
        expect(fixture.events.some((event) => event.startsWith("credential:"))).toBe(false);
      } finally {
        fixture.cleanup();
      }
    }
  });

  test("rechecks protected main after installation and before opening credentials", () => {
    const fixture = launcherFixture({ mainAdvancesAfterFirstRead: true });
    const stdout = output();
    const stderr = output();
    try {
      expect(executeAppSourceProofLauncher(proveArguments, {
        ...fixture.dependencies,
        stderr: stderr.writer,
        stdout: stdout.writer,
      })).toBe(1);
      expect(stderr.lines.join("")).toContain('"code":"verifier_source_invalid"');
      expect(fixture.events).toContain("scratch:created");
      expect(fixture.events.some((event) => event.includes("\0install\0--frozen-lockfile"))).toBe(true);
      expect(fixture.events.some((event) => event.startsWith("credential:"))).toBe(false);
      expect(fixture.events.some((event) => event.includes("\0worktree\0remove\0--force"))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test("removes a registered scratch worktree after install refusal without opening credentials", () => {
    const fixture = launcherFixture({ installFails: true });
    const stdout = output();
    const stderr = output();
    try {
      expect(executeAppSourceProofLauncher(proveArguments, {
        ...fixture.dependencies,
        stderr: stderr.writer,
        stdout: stdout.writer,
      })).toBe(1);
      expect(stdout.lines).toEqual([]);
      expect(stderr.lines.join("")).toContain('"code":"verifier_install_failed"');
      expect(fixture.events.some((event) => event.startsWith("credential:"))).toBe(false);
      expect(fixture.events.some((event) => event.includes("\0worktree\0remove\0--force")))
        .toBe(true);
      expect(fixture.events.some((event) => event.startsWith("scratch:removed:"))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test("cleans an unregistered partial add without opening credentials", () => {
    const fixture = launcherFixture({ worktreeAddFails: true });
    const stdout = output();
    const stderr = output();
    try {
      expect(executeAppSourceProofLauncher(proveArguments, {
        ...fixture.dependencies,
        stderr: stderr.writer,
        stdout: stdout.writer,
      })).toBe(1);
      expect(stderr.lines.join("")).toContain('"code":"verifier_install_failed"');
      expect(fixture.events.some((event) => event.startsWith("credential:"))).toBe(false);
      expect(fixture.events.some((event) => event.startsWith("scratch:removed:"))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test("closes a refused credential and cleans before returning", () => {
    const fixture = launcherFixture();
    const stdout = output();
    const stderr = output();
    try {
      expect(executeAppSourceProofLauncher(proveArguments, {
        ...fixture.dependencies,
        stderr: stderr.writer,
        stdout: stdout.writer,
        validateCredential: () => { throw new Error("invalid credential identity"); },
      })).toBe(1);
      expect(stderr.lines.join("")).toContain('"code":"provider_credentials_refused"');
      expect(fixture.events).toContain("credential:closed");
      expect(fixture.events.some((event) => event.includes("/scripts/verify-app-source.ts\0")))
        .toBe(false);
      expect(fixture.events.some((event) => event.startsWith("scratch:removed:"))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test("refuses cleanup that leaves the exact worktree registered", () => {
    const fixture = launcherFixture({ cleanupLeavesRegistered: true });
    const stdout = output();
    const stderr = output();
    try {
      expect(executeAppSourceProofLauncher(proveArguments, {
        ...fixture.dependencies,
        stderr: stderr.writer,
        stdout: stdout.writer,
      })).toBe(1);
      expect(stdout.lines).toEqual([]);
      expect(stderr.lines.join("")).toContain('"code":"verifier_cleanup_failed"');
      expect(fixture.events.some((event) => event.startsWith("scratch:removed:"))).toBe(false);
      expect(fixture.events).toContain("credential:closed");
    } finally {
      fixture.cleanup();
    }
  });

  test("verifies retained evidence without ever opening a credential", () => {
    const fixture = launcherFixture();
    const stdout = output();
    const stderr = output();
    try {
      const code = executeAppSourceProofLauncher([
        "verify-retained",
        "--evidence-path",
        evidencePath,
        "--release-version",
        releaseVersion,
        "--source-commit",
        sourceCommit,
      ], {
        ...fixture.dependencies,
        stderr: stderr.writer,
        stdout: stdout.writer,
      });
      expect(code).toBe(0);
      expect(fixture.events.some((event) => event.startsWith("credential:"))).toBe(false);
      expect(fixture.events.some((event) => event.includes("\0--verify-retained\0"))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test("keeps launcher refusal codes closed", () => {
    expect(new Set(appSourceProofLauncherErrorCodes).size)
      .toBe(appSourceProofLauncherErrorCodes.length);
  });
});
