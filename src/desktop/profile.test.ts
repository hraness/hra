import { describe, expect, test } from "bun:test";

import { DesktopSwitchError } from "./errors.ts";
import { deriveDesktopProfilePaths } from "./profile.ts";

describe("desktop profile paths", () => {
  test("derives separate full profile boundaries", () => {
    expect(deriveDesktopProfilePaths("/tmp/hra-control-plane", "personal-2")).toEqual({
      profileRoot: "/tmp/hra-control-plane/profiles/personal-2",
      codexHome: "/tmp/hra-control-plane/profiles/personal-2/codex-home",
      desktopUserData: "/tmp/hra-control-plane/profiles/personal-2/desktop-user-data",
    });
  });

  test.each(["../escape", "a/b", "UPPER", "", ".", "-bad", "bad-"])(
    "rejects unsafe profile component %s",
    (profileId) => {
      expect(() => deriveDesktopProfilePaths("/tmp/hra-control-plane", profileId)).toThrow(
        DesktopSwitchError,
      );
    },
  );
});
