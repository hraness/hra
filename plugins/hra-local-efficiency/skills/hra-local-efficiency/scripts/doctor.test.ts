import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { doctorReport, parseDoctorArguments } from "./doctor";

describe("local-efficiency doctor", () => {
  test("requires bounded absolute overrides", () => {
    expect(parseDoctorArguments([
      "--json",
      "--codex-home",
      "/tmp/codex",
      "--claude-home",
      "/tmp/claude",
      "--bun-bin",
      "/tmp/bin",
    ])).toEqual({
      bunBin: "/tmp/bin",
      claudeHome: "/tmp/claude",
      codexHome: "/tmp/codex",
      json: true,
    });
    expect(() => parseDoctorArguments(["--codex-home", "relative"])).toThrow("absolute");
    expect(() => parseDoctorArguments(["--json", "--json"])).toThrow("only once");
  });

  test("reports an incomplete installation without mutating it", () => {
    const root = mkdtempSync(join(tmpdir(), "hra-doctor-"));
    try {
      const modulePath = join(root, "host-resources.js");
      writeFileSync(modulePath, "export const createHostResourceCoordinator = () => ({})\n");
      const report = doctorReport(
        {
          bunBin: join(root, "bin"),
          claudeHome: join(root, "claude"),
          codexHome: join(root, "codex"),
          json: true,
        },
        { HRA_ATET_HOST_RESOURCES_MODULE: modulePath },
      );
      expect(report.ok).toBe(false);
      expect(report.version).toBe(3);
      expect(report.claudeAutoMode).toEqual({
        available: false,
        reason: "cli_missing",
        version: null,
      });
      expect(report.failures).toContain(`global guidance differs: ${join(root, "codex", "AGENTS.md")}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
