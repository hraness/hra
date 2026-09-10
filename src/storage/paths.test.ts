import { describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  initializeProfilePaths,
  initializeStatePaths,
  profilePaths,
  resolveStatePaths,
} from "./paths";
import { GenerationalSecretCustody } from "./secret-custody";

describe("Oompa v1 local namespace", () => {
  test("initializes beside Oompa v0 custody without reading or changing it", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-namespace-")));
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
    await initializeStatePaths(paths);
    const custody = new GenerationalSecretCustody(paths);
    await custody.compareAndSwap("namespace-sentinel", null, "v1-secret");
    expect(await readdir(join(paths.root, "secret-values"))).toHaveLength(1);
    expect(await readFile(legacyStateSentinel, "utf8")).toBe("v0-state");
    expect(await readFile(legacyWindowSentinel, "utf8")).toBe("v0-window");
  });

  test("uses a versioned collision-proof Linux root", () => {
    const paths = resolveStatePaths({ homeDirectory: "/workspace/oompa-user", platform: "linux" });
    expect(paths.root).toBe("/workspace/oompa-user/.local/state/hra-control-plane-v1");
  });

  test("does not create retired provider directories or alter existing provider-owned files", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-devin-profile-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const profileId = `acct_${"a".repeat(32)}`;
    const expected = profilePaths(paths, profileId);
    const initialized = await initializeProfilePaths(paths, profileId);

    expect(initialized).toEqual(expected);
    expect((await readdir(initialized.root)).sort())
      .toEqual(["claude-config", "codex-home", "desktop-user-data"]);
    const legacyDirectory = join(initialized.root, "devin-home");
    await mkdir(legacyDirectory, { mode: 0o700 });
    const legacySentinel = join(legacyDirectory, "provider-owned-sentinel");
    await writeFile(legacySentinel, "retained provider-owned state", { mode: 0o600 });
    await initializeProfilePaths(paths, profileId);
    expect(await readFile(legacySentinel, "utf8")).toBe("retained provider-owned state");
    for (const path of Object.values(initialized)) {
      const metadata = await lstat(path);
      expect(metadata.isDirectory()).toBe(true);
      expect(metadata.isSymbolicLink()).toBe(false);
      expect(metadata.mode & 0o077).toBe(0);
    }
  });
});
