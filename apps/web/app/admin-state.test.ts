import { describe, expect, test } from "bun:test";

import {
  canonicalWorkspaceRoles,
  refreshedSelection,
  sameWorkspaceRoles,
  withWorkspaceRole,
} from "./admin-state";

describe("workspace role state", () => {
  test("canonicalizes foreign role arrays into a stable safe order", () => {
    expect(canonicalWorkspaceRoles(["viewer", "owner", "planner", "viewer", 1])).toEqual([
      "planner",
      "viewer",
    ]);
  });

  test("toggles one role without disturbing other roles", () => {
    expect(withWorkspaceRole(["viewer"], "planner", true)).toEqual(["planner", "viewer"]);
    expect(withWorkspaceRole(["planner", "viewer"], "viewer", false)).toEqual(["planner"]);
  });

  test("compares role sets rather than provider order", () => {
    expect(sameWorkspaceRoles(["viewer", "planner"], ["planner", "viewer"])).toBe(true);
    expect(sameWorkspaceRoles(["viewer"], ["reviewer"])).toBe(false);
  });
});

describe("refreshedSelection", () => {
  test("preserves a valid selection and replaces a stale selection", () => {
    expect(refreshedSelection("workspace_b", ["workspace_a", "workspace_b"])).toBe(
      "workspace_b",
    );
    expect(refreshedSelection("workspace_missing", ["workspace_a", "workspace_b"])).toBe(
      "workspace_a",
    );
  });

  test("returns null for an empty collection", () => {
    expect(refreshedSelection("workspace_old", [])).toBeNull();
  });
});
