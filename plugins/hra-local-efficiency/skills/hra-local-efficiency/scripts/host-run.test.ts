import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  capabilityPlatformSupported,
  hostAccessRequiredCode,
  hostAccessRequiredExitCode,
  inheritedLeaseCovers,
  parseHostRunArguments,
  parseInheritedLease,
  permissionBoundaryDenied,
  permitCapacity,
  permitsForMode,
  resolveAtetHostResourceModule,
  resolveAtetRuntimeRoot,
  resolveCapabilityStateRoot,
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
      lane: "compute",
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
    expect(() => parseHostRunArguments(["--lane=cloud", "--", "true"]))
      .toThrow("invalid capability lane");
  });

  test("parses capability lanes independently from compute weight", () => {
    expect(parseHostRunArguments([
      "--mode=exclusive",
      "--lane=browser-auth",
      "--label=browser-test",
      "--",
      "true",
    ])).toEqual({
      command: ["true"],
      label: "browser-test",
      lane: "browser-auth",
      mode: "exclusive",
    });
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
    expect(resolveCapabilityStateRoot(first))
      .toBe("/opt/tester/.local/state/hra-local-efficiency/capabilities-v1");
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

  test("requires macOS for the mac-native lane", () => {
    expect(capabilityPlatformSupported("mac-native", "darwin")).toBe(true);
    expect(capabilityPlatformSupported("mac-native", "linux")).toBe(false);
    expect(capabilityPlatformSupported("browser-auth", "linux")).toBe(true);
  });

  test("validates inherited lease metadata and rejects mode or capability escalation", () => {
    expect(inheritedLeaseCovers(parseInheritedLease(JSON.stringify({
      capacity: 4,
      label: "legacy",
      mode: "exclusive",
      permits: 4,
      version: 1,
    })), {
      lane: "compute",
      mode: "exclusive",
    })).toBe(true);
    const sharedBrowser = parseInheritedLease(JSON.stringify({
      capacity: 4,
      label: "browser",
      lane: "browser-auth",
      mode: "shared",
      permits: 1,
      version: 2,
    }));
    expect(inheritedLeaseCovers(sharedBrowser, { lane: "compute", mode: "shared" })).toBe(true);
    expect(inheritedLeaseCovers(sharedBrowser, { lane: "browser-auth", mode: "shared" })).toBe(true);
    expect(inheritedLeaseCovers(sharedBrowser, { lane: "browser-auth", mode: "heavy" })).toBe(false);
    expect(inheritedLeaseCovers(sharedBrowser, { lane: "mac-native", mode: "shared" })).toBe(false);
    expect(() => parseInheritedLease('{"version":1}')).toThrow("malformed");
    expect(() => parseInheritedLease(JSON.stringify({
      capacity: 4,
      label: "changed",
      lane: "compute",
      mode: "exclusive",
      permits: 1,
      version: 2,
    }))).toThrow("malformed");
    expect(() => parseInheritedLease("not-json")).toThrow("malformed");
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

  test("a caller-forged inherited lease cannot bypass host-resource acquisition", () => {
    const root = mkdtempSync(join(tmpdir(), "hra-forged-inherited-lease-"));
    const childMarker = join(root, "child-ran");
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        join(import.meta.dir, "host-run.ts"),
        "--mode=exclusive",
        "--label=nested-test",
        "--",
        process.execPath,
        "-e",
        `await Bun.write(${JSON.stringify(childMarker)}, "ran")`,
      ],
      cwd: root,
      env: {
        ...process.env,
        HRA_ATET_HOST_RESOURCES_MODULE: "/missing/atet-module.js",
        HRA_LOCAL_EFFICIENCY_LEASE: JSON.stringify({
          capacity: permitCapacity(),
          label: "forged",
          lane: "compute",
          mode: "exclusive",
          permits: permitCapacity(),
          version: 2,
        }),
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    try {
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("lease descriptor");
      expect(existsSync(childMarker)).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("a nested wrapper accepts only the inherited live lease descriptor", () => {
    const root = mkdtempSync(join(tmpdir(), "hra-live-inherited-lease-"));
    try {
      const modulePath = join(root, "host-resources.js");
      const markerPath = join(root, "lease.lock");
      writeFileSync(modulePath, `
        import { createHash } from "node:crypto";
        import { chmodSync, closeSync, openSync, unlinkSync, writeFileSync } from "node:fs";
        const markerPath = ${JSON.stringify(markerPath)};
        export function createHostResourceCoordinator(options) {
          return {
            async withLease(claims, callback) {
              const document = {
                version: 1,
                owner: "a".repeat(32),
                profileSha256: createHash("sha256").update(JSON.stringify(options.profile)).digest("hex"),
                ticket: "1",
                phase: "A",
                claims,
              };
              writeFileSync(markerPath, JSON.stringify(document), { mode: 0o600 });
              chmodSync(markerPath, 0o600);
              const descriptor = openSync(markerPath, "r+");
              try {
                return await callback({ inheritedFileDescriptor: descriptor });
              } finally {
                closeSync(descriptor);
                unlinkSync(markerPath);
              }
            },
          };
        }
      `);
      const environment = { ...process.env };
      delete environment.HRA_LOCAL_EFFICIENCY_LEASE;
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          join(import.meta.dir, "host-run.ts"),
          "--mode=shared",
          "--label=outer-live",
          "--",
          process.execPath,
          join(import.meta.dir, "host-run.ts"),
          "--mode=shared",
          "--label=nested-live",
          "--",
          process.execPath,
          "-e",
          "process.exit(0)",
        ],
        cwd: root,
        env: {
          ...environment,
          HRA_ATET_HOST_RESOURCES_MODULE: modulePath,
          HRA_LOCAL_EFFICIENCY_STATE_ROOT: join(root, "state", "host-resources-v1"),
          HRA_LOCAL_EFFICIENCY_TELEMETRY: "off",
        },
        stderr: "pipe",
        stdout: "pipe",
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("records a canceled attempt before CPU admission", async () => {
    const root = mkdtempSync(join(tmpdir(), "hra-pre-admission-cancel-"));
    const ready = join(root, "ready");
    try {
      const modulePath = join(root, "host-resources.js");
      writeFileSync(modulePath, `
        import { writeFileSync } from "node:fs";
        const ready = ${JSON.stringify(ready)};
        export function createHostResourceCoordinator() {
          return {
            async withLease(_claims, _callback, options) {
              writeFileSync(ready, "ready");
              return await new Promise((_resolve, reject) => {
                const abort = () => {
                  const error = new Error("wait canceled");
                  error.code = "WAIT_ABORTED";
                  reject(error);
                };
                if (options.signal.aborted) abort();
                else options.signal.addEventListener("abort", abort, { once: true });
              });
            },
          };
        }
      `);
      const environment = { ...process.env };
      delete environment.HRA_LOCAL_EFFICIENCY_LEASE;
      const wrapper = Bun.spawn({
        cmd: [
          process.execPath,
          join(import.meta.dir, "host-run.ts"),
          "--mode=exclusive",
          "--label=cancel-before-admission",
          "--",
          process.execPath,
          "-e",
          "process.exit(0)",
        ],
        cwd: root,
        env: {
          ...environment,
          HRA_ATET_HOST_RESOURCES_MODULE: modulePath,
          HRA_LOCAL_EFFICIENCY_STATE_ROOT: join(root, "state", "host-resources-v1"),
        },
        stderr: "pipe",
        stdout: "pipe",
      });
      for (let attempts = 0; attempts < 100 && !existsSync(ready); attempts += 1) {
        await Bun.sleep(10);
      }
      expect(existsSync(ready)).toBe(true);
      wrapper.kill("SIGTERM");
      expect(await wrapper.exited).toBe(143);
      const telemetryRoot = join(root, "state", "telemetry-v1");
      const files = readdirSync(telemetryRoot);
      expect(files).toHaveLength(1);
      const lines = readFileSync(join(telemetryRoot, files[0] ?? ""), "utf8")
        .trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
        admittedAt: null,
        exitCode: 143,
        outcome: "canceled",
        runMilliseconds: null,
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("acquires the scarce browser capability before weighted CPU permits", () => {
    const root = mkdtempSync(join(tmpdir(), "hra-browser-capability-order-"));
    try {
      const log = join(root, "order.log");
      const modulePath = join(root, "host-resources.js");
      writeFileSync(modulePath, `
        import { appendFileSync, closeSync, openSync } from "node:fs";
        const log = ${JSON.stringify(log)};
        export function createHostResourceCoordinator(options) {
          const id = options.profile.id.includes("capabilities") ? "capability" : "cpu";
          return {
            async withLease(_claims, callback) {
              appendFileSync(log, id + ":start\\n");
              const descriptor = openSync("/dev/null", "r");
              try {
                return await callback({ inheritedFileDescriptor: descriptor });
              } finally {
                closeSync(descriptor);
                appendFileSync(log, id + ":end\\n");
              }
            },
          };
        }
      `);
      const environment = { ...process.env };
      delete environment.HRA_LOCAL_EFFICIENCY_LEASE;
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          join(import.meta.dir, "host-run.ts"),
          "--mode=shared",
          "--lane=browser-auth",
          "--label=browser-order",
          "--",
          process.execPath,
          "-e",
          "process.exit(0)",
        ],
        cwd: root,
        env: {
          ...environment,
          HRA_ATET_HOST_RESOURCES_MODULE: modulePath,
          HRA_LOCAL_EFFICIENCY_STATE_ROOT: join(root, "state", "host-resources-v1"),
          HRA_LOCAL_EFFICIENCY_TELEMETRY: "off",
        },
        stderr: "pipe",
        stdout: "pipe",
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
        "capability:start",
        "cpu:start",
        "cpu:end",
        "capability:end",
      ]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("forwards interruption to the complete child process group", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "hra-process-group-custody-"));
    const modulePath = join(root, "host-resources.js");
    const ready = join(root, "ready");
    const orphanMarker = join(root, "orphan-ran");
    writeFileSync(modulePath, `
      import { closeSync, openSync } from "node:fs";
      export function createHostResourceCoordinator() {
        return {
          async withLease(_claims, callback) {
            const descriptor = openSync("/dev/null", "r");
            try {
              return await callback({ inheritedFileDescriptor: descriptor });
            } finally {
              closeSync(descriptor);
            }
          },
        };
      }
    `);
    const leaderSource = `
      Bun.spawn({
        cmd: [process.execPath, "-e", ${JSON.stringify(`await Bun.sleep(800); await Bun.write(${JSON.stringify(orphanMarker)}, "ran")`)}],
        stderr: "ignore",
        stdout: "ignore",
      });
      await Bun.write(${JSON.stringify(ready)}, "ready");
      await Bun.sleep(10_000);
    `;
    const environment = { ...process.env };
    delete environment.HRA_LOCAL_EFFICIENCY_LEASE;
    const wrapper = Bun.spawn({
      cmd: [
        process.execPath,
        join(import.meta.dir, "host-run.ts"),
        "--mode=shared",
        "--label=process-group",
        "--",
        process.execPath,
        "-e",
        leaderSource,
      ],
      cwd: root,
      env: {
        ...environment,
        HRA_ATET_HOST_RESOURCES_MODULE: modulePath,
        HRA_LOCAL_EFFICIENCY_STATE_ROOT: join(root, "state", "host-resources-v1"),
        HRA_LOCAL_EFFICIENCY_TELEMETRY: "off",
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    try {
      for (let attempts = 0; attempts < 100 && !existsSync(ready); attempts += 1) {
        await Bun.sleep(10);
      }
      expect(existsSync(ready)).toBe(true);
      wrapper.kill("SIGTERM");
      await wrapper.exited;
      await Bun.sleep(1_000);
      expect(existsSync(orphanMarker)).toBe(false);
    } finally {
      wrapper.kill("SIGKILL");
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("force-cleans a residual descendant after its command leader exits", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "hra-residual-process-group-"));
    const modulePath = join(root, "host-resources.js");
    const ready = join(root, "ready");
    const residualMarker = join(root, "residual-ran");
    writeFileSync(modulePath, `
      import { closeSync, openSync } from "node:fs";
      export function createHostResourceCoordinator() {
        return {
          async withLease(_claims, callback) {
            const descriptor = openSync("/dev/null", "r");
            try {
              return await callback({ inheritedFileDescriptor: descriptor });
            } finally {
              closeSync(descriptor);
            }
          },
        };
      }
    `);
    const descendantSource = `
      process.on("SIGTERM", () => {});
      await Bun.sleep(800);
      await Bun.write(${JSON.stringify(residualMarker)}, "ran");
    `;
    const leaderSource = `
      const { spawn } = await import("node:child_process");
      const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], {
        stdio: "ignore",
      });
      child.unref();
      await Bun.write(${JSON.stringify(ready)}, "ready");
    `;
    const environment = { ...process.env };
    delete environment.HRA_LOCAL_EFFICIENCY_LEASE;
    const wrapper = Bun.spawn({
      cmd: [
        process.execPath,
        join(import.meta.dir, "host-run.ts"),
        "--mode=shared",
        "--label=residual-process-group",
        "--",
        process.execPath,
        "-e",
        leaderSource,
      ],
      cwd: root,
      env: {
        ...environment,
        HRA_ATET_HOST_RESOURCES_MODULE: modulePath,
        HRA_LOCAL_EFFICIENCY_STATE_ROOT: join(root, "state", "host-resources-v1"),
        HRA_LOCAL_EFFICIENCY_TELEMETRY: "off",
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    try {
      for (let attempts = 0; attempts < 100 && !existsSync(ready); attempts += 1) {
        await Bun.sleep(10);
      }
      expect(existsSync(ready)).toBe(true);
      expect(await wrapper.exited).toBe(0);
      await Bun.sleep(1_000);
      expect(existsSync(residualMarker)).toBe(false);
    } finally {
      wrapper.kill("SIGKILL");
      rmSync(root, { force: true, recursive: true });
    }
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
