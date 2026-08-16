import { describe, expect, test } from "bun:test";

import {
  hraSessionSyncEnabled,
  resolveHraEnvironmentValue,
} from "./hraEnvironment";

describe("HRA environment cutover", () => {
  test("prefers the canonical name and preserves the legacy value as fallback", () => {
    expect(resolveHraEnvironmentValue("same-bytes", undefined)).toEqual({
      kind: "value",
      value: "same-bytes",
    });
    expect(resolveHraEnvironmentValue(undefined, "legacy-bytes")).toEqual({
      kind: "value",
      value: "legacy-bytes",
    });
    expect(resolveHraEnvironmentValue("same-bytes", "same-bytes")).toEqual({
      kind: "value",
      value: "same-bytes",
    });
  });

  test("rejects conflicting names and keeps session sync disabled", () => {
    expect(resolveHraEnvironmentValue("new", "old")).toEqual({
      kind: "conflict",
    });
    expect(hraSessionSyncEnabled({
      HRA_SESSION_SYNC_ENABLED: "true",
      OPRTE_SESSION_SYNC_ENABLED: "false",
    })).toBe(false);
    expect(hraSessionSyncEnabled({
      OPRTE_SESSION_SYNC_ENABLED: "true",
    })).toBe(true);
    expect(hraSessionSyncEnabled({
      HRA_SESSION_SYNC_ENABLED: "true",
    })).toBe(true);
  });
});
