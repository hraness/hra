import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  hostAccessRequiredCode,
  hostAccessRequiredExitCode,
  parseHostRunArguments,
  permissionBoundaryDenied,
  permitCapacity,
  permitsForMode,
  resolveAtetHostResourceModule,
  resolveAtetRuntimeRoot,
  resolveHostResourceStateRoot,
} from "./host-run";

describe("host-wide resource wrapper", () => {
  test("uses the established 1/2/all weighted model", () => {
    expect(permitCapacity(18)).toBe(4);
    expect(permitsForMode("shared", 18)).toBe(1);
    expect(permitsForMode("heavy", 18)).toBe(2);
    expect(permitsForMode("exclusive", 18)).toBe(4);
    expect(permitsForMode("exclusive", 2)).toBe(1);
  });

  test("parses argv without invoking a shell", () => {
    expect(parseHostRunArguments([
      "--mode=heavy",
      "--label=repo-check",
      "--",
      "bun",
      "run",
      "check",
    ])).toEqual({
      command: ["bun", "run", "check"],
      label: "repo-check",
      mode: "heavy",
    });
  });

  test("rejects malformed modes and missing command delimiters", () => {
    expect(() => parseHostRunArguments(["--mode=wide", "--", "true"]))
      .toThrow("invalid resource mode");
    expect(() => parseHostRunArguments(["true"]))
      .toThrow("requires --");
    expect(() => parseHostRunArguments(["--label=contains spaces", "--", "true"]))
      .toThrow("ASCII identifier");
  });

  test("uses one machine-wide state root across isolated Codex profiles", () => {
    const first = resolveHostResourceStateRoot(
      { CODEX_HOME: "/profiles/one" },
      "/opt/tester",
    );
    const second = resolveHostResourceStateRoot(
      { CODEX_HOME: "/profiles/two" },
      "/opt/tester",
    );
    expect(first).toBe("/opt/tester/.local/state/hra-local-efficiency/host-resources-v1");
    expect(second).toBe(first);
    expect(resolveHostResourceStateRoot(
      { CODEX_HOME: "/profiles/three", XDG_STATE_HOME: "/state" },
      "/opt/tester",
    )).toBe("/state/hra-local-efficiency/host-resources-v1");
    expect(resolveAtetRuntimeRoot(
      { CODEX_HOME: "/profiles/one" },
      "/opt/tester",
    )).toBe("/opt/tester/.local/share/hra-local-efficiency/runtime/atet-v2.0.0");
    expect(resolveAtetRuntimeRoot(
      { CODEX_HOME: "/profiles/two" },
      "/opt/tester",
    )).toBe(resolveAtetRuntimeRoot({}, "/opt/tester"));
  });

  test("accepts an explicit Atet module path for isolated installations", () => {
    const modulePath = resolveAtetHostResourceModule(
      { HRA_ATET_HOST_RESOURCES_MODULE: import.meta.path },
      "/nonexistent-home",
    );
    expect(modulePath).toBe(import.meta.path);
  });

  test("classifies only bounded permission-denial cause chains", () => {
    expect(permissionBoundaryDenied({ code: "EPERM" })).toBe(true);
    expect(permissionBoundaryDenied({ code: "UNSAFE_STATE", cause: { code: "EACCES" } }))
      .toBe(true);
    expect(permissionBoundaryDenied({ code: "UNSAFE_STATE" })).toBe(false);
    expect(permissionBoundaryDenied({ code: "WAIT_TIMEOUT", cause: { code: "ETIMEDOUT" } }))
      .toBe(false);

    const cycle: { cause?: unknown; code: string } = { code: "UNSAFE_STATE" };
    cycle.cause = cycle;
    expect(permissionBoundaryDenied(cycle)).toBe(false);
    expect(permissionBoundaryDenied({
      code: "UNSAFE_STATE",
      cause: {
        code: "UNSAFE_STATE",
        cause: {
          code: "UNSAFE_STATE",
          cause: { code: "UNSAFE_STATE", cause: { code: "EPERM" } },
        },
      },
    })).toBe(false);
  });

  test("an inherited outer lease bypasses host-resource acquisition", () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        join(import.meta.dir, "host-run.ts"),
        "--mode=exclusive",
        "--label=nested-test",
        "--",
        process.execPath,
        "-e",
        "process.exit(0)",
      ],
      env: {
        ...process.env,
        HRA_ATET_HOST_RESOURCES_MODULE: "/missing/atet-module.js",
        HRA_LOCAL_EFFICIENCY_LEASE: '{"version":1}',
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  });

  test("reports a stable reviewed-host-access boundary before child execution", () => {
    const root = mkdtempSync(join(tmpdir(), "hra-host-access-boundary-"));
    try {
      const modulePath = join(root, "host-resources.js");
      writeFileSync(modulePath, `
        export function createHostResourceCoordinator() {
          return {
            async withLease() {
              const cause = new Error("private scheduler path");
              cause.code = "EPERM";
              const error = new Error("unsafe state", { cause });
              error.code = "UNSAFE_STATE";
              throw error;
            },
          };
        }
      `);
      const childMarker = join(root, "child-ran");
      const environment = { ...process.env };
      delete environment.HRA_LOCAL_EFFICIENCY_LEASE;
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          join(import.meta.dir, "host-run.ts"),
          "--mode=shared",
          "--label=boundary-test",
          "--",
          process.execPath,
          "-e",
          `await Bun.write(${JSON.stringify(childMarker)}, "ran")`,
        ],
        cwd: root,
        env: {
          ...environment,
          HRA_ATET_HOST_RESOURCES_MODULE: modulePath,
          HRA_LOCAL_EFFICIENCY_STATE_ROOT: join(root, "state"),
        },
        stderr: "pipe",
        stdout: "pipe",
      });
      expect(result.exitCode).toBe(hostAccessRequiredExitCode);
      expect(result.stderr.toString()).toContain(hostAccessRequiredCode);
      expect(result.stderr.toString()).toContain("identical hra-host-run invocation");
      expect(result.stderr.toString()).not.toContain("private scheduler path");
      expect(existsSync(childMarker)).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
