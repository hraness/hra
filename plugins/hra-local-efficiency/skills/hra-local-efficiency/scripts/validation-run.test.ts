import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  fingerprintUntrackedEntry,
  parseValidationArguments,
  runValidation,
  validationFingerprint,
  validationReceiptPath,
} from "./validation-run";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "hra-validation-"));
  temporary.push(root);
  Bun.spawnSync({ cmd: ["git", "init", "-q", root] });
  Bun.spawnSync({ cmd: ["git", "-C", root, "config", "user.email", "test@example.com"] });
  Bun.spawnSync({ cmd: ["git", "-C", root, "config", "user.name", "Test"] });
  writeFileSync(join(root, "tracked.txt"), "one\n");
  writeFileSync(join(root, "bun.lock"), "lock\n");
  mkdirSync(join(root, "packages", "a"), { recursive: true });
  mkdirSync(join(root, "packages", "b"), { recursive: true });
  writeFileSync(join(root, "packages", "a", "tracked.txt"), "a\n");
  writeFileSync(join(root, "packages", "b", "tracked.txt"), "b\n");
  Bun.spawnSync({ cmd: ["git", "-C", root, "add", "."] });
  Bun.spawnSync({ cmd: ["git", "-C", root, "commit", "-qm", "fixture"] });
  return root;
}

describe("validation receipts", () => {
  test("requires explicit argv boundaries and validates reuse controls", () => {
    expect(() => parseValidationArguments(["bun", "test"]))
      .toThrow("requires --");
    expect(parseValidationArguments([
      "--reuse",
      "--ttl-minutes=30",
      "--context",
      "browser=none",
      "--",
      "bun",
      "test",
    ])).toMatchObject({
      command: ["bun", "test"],
      contexts: ["browser=none"],
      reuse: true,
      ttlMinutes: 30,
    });
    expect(() => parseValidationArguments(["--label=contains spaces", "--", "true"]))
      .toThrow("ASCII identifier");
    expect(() => parseValidationArguments(["--context", "bad name=value", "--", "true"]))
      .toThrow("context name");
  });

  test("changes identity with tracked and untracked content", () => {
    const root = fixture();
    const baseline = validationFingerprint(root, ["bun", "test"], []);
    writeFileSync(join(root, "tracked.txt"), "two\n");
    const tracked = validationFingerprint(root, ["bun", "test"], []);
    expect(tracked.digest).not.toBe(baseline.digest);
    writeFileSync(join(root, "new.txt"), "new\n");
    const untracked = validationFingerprint(root, ["bun", "test"], []);
    expect(untracked.digest).not.toBe(tracked.digest);
  });

  test("hashes an outside-repository symlink without reading its target", () => {
    const root = fixture();
    const outside = mkdtempSync(join(tmpdir(), "hra-validation-outside-"));
    temporary.push(outside);
    const firstTarget = join(outside, "first.txt");
    const secondTarget = join(outside, "second.txt");
    writeFileSync(firstTarget, "first secret\n");
    writeFileSync(secondTarget, "first secret\n");
    const link = join(root, "outside-link");
    symlinkSync(firstTarget, link);
    expect(fingerprintUntrackedEntry(root, "outside-link")[1]).toBe("120000");

    const first = validationFingerprint(root, ["bun", "test"], []);
    writeFileSync(firstTarget, "changed secret\n");
    const targetContentChanged = validationFingerprint(root, ["bun", "test"], []);
    expect(targetContentChanged.digest).toBe(first.digest);

    unlinkSync(link);
    symlinkSync(secondTarget, link);
    const linkTargetChanged = validationFingerprint(root, ["bun", "test"], []);
    expect(linkTargetChanged.digest).not.toBe(first.digest);
  });

  test("hashes a symlinked lockfile without reading its outside target", () => {
    const root = fixture();
    const outside = mkdtempSync(join(tmpdir(), "hra-validation-lock-outside-"));
    temporary.push(outside);
    const firstTarget = join(outside, "first.lock");
    const secondTarget = join(outside, "second.lock");
    writeFileSync(firstTarget, "same lock content\n");
    writeFileSync(secondTarget, "same lock content\n");
    const lockfile = join(root, "bun.lock");
    unlinkSync(lockfile);
    symlinkSync(firstTarget, lockfile);

    const first = validationFingerprint(root, ["bun", "test"], []);
    writeFileSync(firstTarget, "changed outside lock content\n");
    const targetContentChanged = validationFingerprint(root, ["bun", "test"], []);
    expect(targetContentChanged.digest).toBe(first.digest);

    unlinkSync(lockfile);
    symlinkSync(secondTarget, lockfile);
    const linkTargetChanged = validationFingerprint(root, ["bun", "test"], []);
    expect(linkTargetChanged.digest).not.toBe(first.digest);
  });

  test("includes normalized executable mode for an untracked regular file", () => {
    const root = fixture();
    const path = join(root, "new-script");
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, 0o644);
    expect(fingerprintUntrackedEntry(root, "new-script")[1]).toBe("100644");
    const regular = validationFingerprint(root, ["bun", "test"], []);
    chmodSync(path, 0o755);
    expect(fingerprintUntrackedEntry(root, "new-script")[1]).toBe("100755");
    const executable = validationFingerprint(root, ["bun", "test"], []);
    expect(executable.digest).not.toBe(regular.digest);
  });

  test("refuses a FIFO without opening or reading it", () => {
    if (process.platform === "win32" || Bun.which("mkfifo") === null) return;
    const root = fixture();
    const fifo = join(root, "untracked-pipe");
    const created = Bun.spawnSync({ cmd: ["mkfifo", fifo] });
    expect(created.exitCode).toBe(0);
    expect(() => fingerprintUntrackedEntry(root, "untracked-pipe"))
      .toThrow("untracked directory or special entry");
  });

  test("changes identity with command and explicit environment context", () => {
    const root = fixture();
    const first = validationFingerprint(root, ["bun", "test"], ["browser=none"]);
    const command = validationFingerprint(root, ["bun", "run", "check"], ["browser=none"]);
    const context = validationFingerprint(root, ["bun", "test"], ["browser=chromium"]);
    expect(command.digest).not.toBe(first.digest);
    expect(context.digest).not.toBe(first.digest);
  });

  test("fingerprints sibling changes when validation starts in a package", () => {
    const root = fixture();
    const cwd = join(root, "packages", "a");
    const first = validationFingerprint(cwd, ["bun", "test"], []);
    writeFileSync(join(root, "packages", "b", "tracked.txt"), "changed\n");
    expect(validationFingerprint(cwd, ["bun", "test"], []).digest).not.toBe(first.digest);
  });

  test("refuses hidden skip-worktree and assume-unchanged inputs", () => {
    for (const flag of ["--skip-worktree", "--assume-unchanged"] as const) {
      const root = fixture();
      Bun.spawnSync({ cmd: ["git", "-C", root, "update-index", flag, "tracked.txt"] });
      writeFileSync(join(root, "tracked.txt"), `${flag}\n`);
      expect(() => validationFingerprint(root, ["bun", "test"], []))
        .toThrow("skip-worktree or assume-unchanged");
    }
  });

  test("refuses a populated raw gitlink without .gitmodules", () => {
    const root = fixture();
    const head = Bun.spawnSync({
      cmd: ["git", "-C", root, "rev-parse", "HEAD"],
      stdout: "pipe",
    }).stdout.toString().trim();
    const updated = Bun.spawnSync({
      cmd: ["git", "-C", root, "update-index", "--add", "--cacheinfo", "160000", head, "vendor/raw"],
    });
    expect(updated.exitCode).toBe(0);
    mkdirSync(join(root, "vendor", "raw"), { recursive: true });
    writeFileSync(join(root, "vendor", "raw", "private-state"), "do not ignore\n");
    expect(() => validationFingerprint(root, ["bun", "test"], []))
      .toThrow(/populated gitlink|submodule/iu);
  });

  test("does not write a reusable receipt when validation changes inputs", async () => {
    const root = fixture();
    const options = parseValidationArguments([
      "--json",
      "--ttl-minutes=30",
      "--",
      "bun",
      "-e",
      "await Bun.write('tracked.txt', 'changed by validation\\n')",
    ]);
    const before = validationFingerprint(root, options.command, options.contexts);
    expect(await runValidation(options, root, {
      ...process.env,
      HRA_LOCAL_EFFICIENCY_LEASE: '{"version":1}',
    })).toBe(0);
    expect(existsSync(validationReceiptPath(before))).toBe(false);
  });

  test("keeps raw command arguments out of receipts and wrapper output", async () => {
    const root = fixture();
    const secret = "not-a-real-secret-command-value";
    const options = parseValidationArguments([
      "--json",
      "--label=receipt-test",
      "--",
      "bun",
      "-e",
      `void ${JSON.stringify(secret)}`,
    ]);
    const fingerprint = validationFingerprint(root, options.command, options.contexts);
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((value?: unknown) => {
      lines.push(String(value));
    });
    try {
      expect(await runValidation(options, root, {
        ...process.env,
        HRA_LOCAL_EFFICIENCY_LEASE: '{"version":1}',
      })).toBe(0);
    } finally {
      log.mockRestore();
    }
    const receipt = readFileSync(validationReceiptPath(fingerprint), "utf8");
    expect(receipt).not.toContain(secret);
    expect(lines.join("\n")).not.toContain(secret);
    expect(JSON.parse(receipt)).toMatchObject({
      label: "receipt-test",
      program: "bun",
      version: 2,
    });
  });

  test("rejects malformed and oversized reusable receipts without echoing them", async () => {
    const root = fixture();
    const options = parseValidationArguments([
      "--json",
      "--reuse",
      "--label=reuse-test",
      "--",
      "bun",
      "-e",
      "process.exit(0)",
    ]);
    const fingerprint = validationFingerprint(root, options.command, options.contexts);
    const path = validationReceiptPath(fingerprint);
    const environment = {
      ...process.env,
      HRA_LOCAL_EFFICIENCY_LEASE: '{"version":1}',
    };
    expect(await runValidation(options, root, environment)).toBe(0);
    const safe = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const sentinel = "foreign-receipt-secret";
    writeFileSync(path, `${JSON.stringify({
      ...safe,
      expiresAt: "garbage",
      foreign: sentinel,
    })}\n`);
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((value?: unknown) => {
      lines.push(String(value));
    });
    try {
      expect(await runValidation(options, root, environment)).toBe(0);
      expect(lines.join("\n")).toContain('"kind": "executed"');
      expect(lines.join("\n")).not.toContain(sentinel);
      lines.length = 0;
      writeFileSync(path, "x".repeat(16 * 1024 + 1));
      expect(await runValidation(options, root, environment)).toBe(0);
      expect(lines.join("\n")).toContain('"kind": "executed"');
    } finally {
      log.mockRestore();
    }
  });

  test("reuses a valid receipt once across a canonical cwd alias", async () => {
    const root = fixture();
    const counterRoot = mkdtempSync(join(tmpdir(), "hra-validation-counter-"));
    temporary.push(counterRoot);
    const counter = join(counterRoot, "count.txt");
    const options = parseValidationArguments([
      "--json",
      "--reuse",
      "--label=positive-reuse",
      "--",
      "bun",
      "-e",
      `const path=${JSON.stringify(counter)}; const current=await Bun.file(path).exists()?Number(await Bun.file(path).text()):0; await Bun.write(path,String(current+1));`,
    ]);
    const environment = {
      ...process.env,
      HRA_LOCAL_EFFICIENCY_LEASE: '{"version":1}',
    };
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((value?: unknown) => {
      lines.push(String(value));
    });
    try {
      expect(await runValidation(options, root, environment)).toBe(0);
      expect(await runValidation(options, root, environment)).toBe(0);
    } finally {
      log.mockRestore();
    }
    expect(readFileSync(counter, "utf8")).toBe("1");
    expect(lines.join("\n")).toContain('"kind": "executed"');
    expect(lines.join("\n")).toContain('"kind": "reused"');
    const receipt = JSON.parse(readFileSync(
      validationReceiptPath(validationFingerprint(root, options.command, options.contexts)),
      "utf8",
    )) as { cwd: string };
    expect(receipt.cwd).not.toContain("..");
  });

  test("honors the reuse caller's shorter freshness bound", async () => {
    const root = fixture();
    const counterRoot = mkdtempSync(join(tmpdir(), "hra-validation-ttl-"));
    temporary.push(counterRoot);
    const counter = join(counterRoot, "count.txt");
    const command = [
      "bun",
      "-e",
      `const path=${JSON.stringify(counter)}; const current=await Bun.file(path).exists()?Number(await Bun.file(path).text()):0; await Bun.write(path,String(current+1));`,
    ];
    const long = parseValidationArguments([
      "--json",
      "--reuse",
      "--ttl-minutes=1440",
      "--label=ttl-reuse",
      "--",
      ...command,
    ]);
    const environment = {
      ...process.env,
      HRA_LOCAL_EFFICIENCY_LEASE: '{"version":1}',
    };
    expect(await runValidation(long, root, environment)).toBe(0);
    const path = validationReceiptPath(validationFingerprint(root, command, []));
    const receipt = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const finishedAt = Date.now() - 2 * 60_000;
    writeFileSync(path, `${JSON.stringify({
      ...receipt,
      expiresAt: new Date(finishedAt + 24 * 60 * 60_000).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      startedAt: new Date(finishedAt - 100).toISOString(),
    }, null, 2)}\n`);
    const short = parseValidationArguments([
      "--json",
      "--reuse",
      "--ttl-minutes=1",
      "--label=ttl-reuse",
      "--",
      ...command,
    ]);
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((value?: unknown) => {
      lines.push(String(value));
    });
    try {
      expect(await runValidation(short, root, environment)).toBe(0);
    } finally {
      log.mockRestore();
    }
    expect(readFileSync(counter, "utf8")).toBe("2");
    expect(lines.join("\n")).toContain('"kind": "executed"');
  });
});
