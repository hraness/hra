import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  authoritySupervisorBuildCommand,
  parseAuthoritySupervisorBuildVerifierArguments,
} from "./verify-authority-supervisor-build";

describe("authority supervisor build verifier", () => {
  test("constructs the exact pinned Zig 0.16 static-musl build command", () => {
    expect(authoritySupervisorBuildCommand(
      "/opt/zig/zig",
      "x86_64-linux-musl",
      "/workspace/scripts/authority-supervisor.zig",
      "/temporary/x64",
    )).toEqual([
      "/opt/zig/zig",
      "build-exe",
      "-O",
      "ReleaseSafe",
      "-fstrip",
      "-target",
      "x86_64-linux-musl",
      "/workspace/scripts/authority-supervisor.zig",
      "-femit-bin=/temporary/x64",
    ]);
    expect(authoritySupervisorBuildCommand(
      "/opt/zig/zig",
      "aarch64-linux-musl",
      "/workspace/scripts/authority-supervisor.zig",
      "/temporary/arm64",
    )).toContain("aarch64-linux-musl");
  });

  test("requires one explicit absolute Zig executable", () => {
    expect(parseAuthoritySupervisorBuildVerifierArguments([
      "--zig",
      "/opt/zig/zig",
    ])).toEqual({ zigExecutable: "/opt/zig/zig" });
    for (const arguments_ of [
      [],
      ["--zig"],
      ["--zig", "zig"],
      ["--compiler", "/opt/zig/zig"],
      ["--zig", "/opt/zig/zig", "--extra"],
    ]) {
      expect(() => parseAuthoritySupervisorBuildVerifierArguments(arguments_)).toThrow(
        "authority_supervisor_build_usage_invalid",
      );
    }
  });

  test("pins the official Zig archive and rebuilds the checked-in artifacts in CI and release", async () => {
    const paths = [
      join(import.meta.dir, "..", ".github", "workflows", "ci.yml"),
      join(import.meta.dir, "..", ".github", "workflows", "release.yml"),
    ];
    for (const path of paths) {
      const workflow = await readFile(path, "utf8");
      expect(workflow).toContain("https://ziglang.org/download/0.16.0/zig-x86_64-linux-0.16.0.tar.xz");
      expect(workflow).toContain("70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00");
      expect(workflow).toContain("sha256sum --check --status");
      expect(workflow).toMatch(/verify-authority-supervisor-build\.ts\s+--zig/u);
      expect(workflow).toContain("authority-supervisor-runtime.test.ts --isolate --max-concurrency=1");
      expect(workflow).not.toContain("setup-zig");
    }
  });
});
