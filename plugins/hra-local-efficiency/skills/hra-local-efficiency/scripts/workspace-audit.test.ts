import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseWorkspaceAuditArguments } from "./workspace-audit";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("workspace audit arguments", () => {
  test("is read-only and unfetched by default", () => {
    expect(parseWorkspaceAuditArguments(["--root", "/tmp/repos"])).toEqual({
      fetch: false,
      json: false,
      roots: ["/tmp/repos"],
      sizes: false,
    });
  });

  test("requires bounded absolute roots", () => {
    expect(() => parseWorkspaceAuditArguments(["--root", "relative"]))
      .toThrow("absolute");
  });

  test("opts into the slower recursive size estimate", () => {
    expect(parseWorkspaceAuditArguments(["--sizes", "--root", "/tmp/repos"]))
      .toMatchObject({ sizes: true });
  });

  test("emits JSON with decimal disk bytes and no remote credentials", () => {
    const root = mkdtempSync(join(tmpdir(), "hra-workspace-json-"));
    temporary.push(root);
    const repository = join(root, "repo");
    const run = (arguments_: readonly string[], cwd = root): void => {
      const result = Bun.spawnSync({ cmd: [...arguments_], cwd, stderr: "pipe", stdout: "pipe" });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    };
    run(["git", "init", "--initial-branch=main", repository]);
    run(["git", "config", "user.email", "test@example.com"], repository);
    run(["git", "config", "user.name", "Test"], repository);
    writeFileSync(join(repository, "tracked.txt"), "tracked\n");
    run(["git", "add", "."], repository);
    run(["git", "commit", "-m", "base"], repository);
    const sentinel = "fake-userinfo-secret";
    run([
      "git",
      "remote",
      "add",
      "origin",
      `https://${sentinel}@github.com/hraness/example.git`,
    ], repository);
    run(["git", "update-ref", "refs/remotes/origin/main", "HEAD"], repository);

    const result = Bun.spawnSync({
      cmd: [process.execPath, join(import.meta.dir, "workspace-audit.ts"), "--json", "--root", root],
      cwd: root,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(result.exitCode).toBe(0);
    const stdout = result.stdout.toString();
    expect(stdout).not.toContain(sentinel);
    const payload = JSON.parse(stdout) as {
      disk: { availableBytes: string; requiredBytes: string };
      repositories: Array<Record<string, unknown>>;
    };
    expect(payload.disk.availableBytes).toMatch(/^\d+$/u);
    expect(payload.disk.requiredBytes).toMatch(/^\d+$/u);
    expect(payload.repositories).toHaveLength(1);
    expect(payload.repositories[0]).not.toHaveProperty("remote");
  });
});
