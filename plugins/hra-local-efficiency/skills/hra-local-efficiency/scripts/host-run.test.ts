import { describe, expect, test } from "bun:test";

import {
  parseHostRunArguments,
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
});
