import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { initializeStatePaths, resolveStatePaths } from "./paths";
import { HRA_KEYCHAIN_SERVICE } from "./secret-custody";

describe("HRA v1 local namespace", () => {
  test("initializes beside HRA v0 custody without reading or changing it", async () => {
    const home = await mkdtemp(join("/private/tmp", "hra-namespace-"));
    const applicationSupport = join(home, "Library", "Application Support");
    const legacyState = join(applicationSupport, "OPRTE");
    const legacyWindowState = join(applicationSupport, "kitchen.hraness");
    await mkdir(legacyState, { recursive: true });
    await mkdir(legacyWindowState, { recursive: true });
    const legacyStateSentinel = join(legacyState, "v0-state-sentinel");
    const legacyWindowSentinel = join(legacyWindowState, "v0-window-sentinel");
    await writeFile(legacyStateSentinel, "v0-state", "utf8");
    await writeFile(legacyWindowSentinel, "v0-window", "utf8");

    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    expect(paths.root).toBe(join(applicationSupport, "HRA Control Plane v1"));
    expect(paths.root).not.toBe(legacyState);
    expect(paths.root).not.toBe(legacyWindowState);
    expect(HRA_KEYCHAIN_SERVICE).toBe("sh.hra.control-plane.v1");
    expect(HRA_KEYCHAIN_SERVICE).not.toStartWith("kitchen.hraness");

    await initializeStatePaths(paths);
    expect(await readFile(legacyStateSentinel, "utf8")).toBe("v0-state");
    expect(await readFile(legacyWindowSentinel, "utf8")).toBe("v0-window");
  });

  test("uses a versioned collision-proof Linux root", () => {
    const paths = resolveStatePaths({ homeDirectory: "/workspace/hra-user", platform: "linux" });
    expect(paths.root).toBe("/workspace/hra-user/.local/state/hra-control-plane-v1");
  });
});
