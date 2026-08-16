import { describe, expect, test } from "bun:test";
import {
  optionalRenamedEnvironmentValue,
  renamedEnvironmentValue,
} from "../src/security/renamed-environment";

describe("renamed environment", () => {
  test("prefers the canonical name while accepting one exact legacy alias", () => {
    expect(renamedEnvironmentValue({}, "HRA_CODEX_BIN")).toEqual({
      state: "missing",
    });
    expect(renamedEnvironmentValue({
      OPRTE_CODEX_BIN: "/legacy/codex",
    }, "HRA_CODEX_BIN")).toEqual({
      state: "value",
      source: "legacy",
      value: "/legacy/codex",
    });
    expect(renamedEnvironmentValue({
      HRA_CODEX_BIN: "/canonical/codex",
    }, "HRA_CODEX_BIN")).toEqual({
      state: "value",
      source: "canonical",
      value: "/canonical/codex",
    });
  });

  test("accepts equal dual configuration and rejects disagreement", () => {
    expect(optionalRenamedEnvironmentValue({
      HRA_GIT_ROOT: "/runtime/git",
      OPRTE_GIT_ROOT: "/runtime/git",
    }, "HRA_GIT_ROOT")).toBe("/runtime/git");
    expect(() => optionalRenamedEnvironmentValue({
      HRA_GIT_ROOT: "/canonical/git",
      OPRTE_GIT_ROOT: "/legacy/git",
    }, "HRA_GIT_ROOT")).toThrow(
      "HRA_GIT_ROOT conflicts with a legacy alias.",
    );
  });

  test("retains the oldest Kitchen spelling as input-only compatibility", () => {
    expect(optionalRenamedEnvironmentValue({
      KITCHEN_CODEX_BIN: "/legacy/codex",
    }, "HRA_CODEX_BIN")).toBe("/legacy/codex");
    expect(() => optionalRenamedEnvironmentValue({
      OPRTE_CODEX_BIN: "/oprte/codex",
      KITCHEN_CODEX_BIN: "/kitchen/codex",
    }, "HRA_CODEX_BIN")).toThrow("HRA_CODEX_BIN conflicts with a legacy alias.");
  });
});
