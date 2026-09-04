import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initializeStatePaths, resolveStatePaths } from "../storage/paths";
import {
  clearGatewayKey,
  gatewayKeyPath,
  hasGatewayKey,
  readGatewayKey,
  setGatewayKey,
} from "./gateway-key-custody";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function custodyPaths(): Promise<ReturnType<typeof resolveStatePaths>> {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "hra-gateway-key-")));
  temporaryDirectories.push(temporary);
  const paths = resolveStatePaths({ homeDirectory: temporary, platform: "linux" });
  await initializeStatePaths(paths);
  return paths;
}

// Built rather than written literally so no secret-shaped constant enters the
// repository; only the shape matters to custody.
const fixtureKey = ["gw", "a".repeat(24)].join("-");
const replacementKey = ["gw", "b".repeat(30)].join("-");

describe("gateway key custody", () => {
  test("stores, reports, replaces, and clears the key in a user-only file", async () => {
    const paths = await custodyPaths();
    expect(await hasGatewayKey(paths)).toBe(false);
    expect(await readGatewayKey(paths)).toBeNull();
    expect(await clearGatewayKey(paths)).toBe(false);

    await setGatewayKey(paths, fixtureKey);
    expect(await hasGatewayKey(paths)).toBe(true);
    expect(await readGatewayKey(paths)).toBe(fixtureKey);
    expect(lstatSync(gatewayKeyPath(paths)).mode & 0o777).toBe(0o600);

    await setGatewayKey(paths, replacementKey);
    expect(await readGatewayKey(paths)).toBe(replacementKey);

    expect(await clearGatewayKey(paths)).toBe(true);
    expect(await hasGatewayKey(paths)).toBe(false);
  });

  test("refuses a malformed key and reports an unsafe custody file as absent", async () => {
    const paths = await custodyPaths();
    await expect(setGatewayKey(paths, "short")).rejects.toThrow("unsupported shape");
    await expect(setGatewayKey(paths, `gw ${"c".repeat(24)}`)).rejects.toThrow("unsupported shape");

    await writeFile(gatewayKeyPath(paths), "tiny", { mode: 0o600 });
    expect(await hasGatewayKey(paths)).toBe(false);
    await writeFile(gatewayKeyPath(paths), `two words ${"d".repeat(20)}`, { mode: 0o600 });
    expect(await hasGatewayKey(paths)).toBe(false);

    await writeFile(gatewayKeyPath(paths), fixtureKey, { mode: 0o600 });
    await chmod(gatewayKeyPath(paths), 0o644);
    expect(await hasGatewayKey(paths)).toBe(false);

    await rm(gatewayKeyPath(paths));
    await writeFile(join(paths.root, "gateway-key-target"), fixtureKey, { mode: 0o600 });
    await symlink(join(paths.root, "gateway-key-target"), gatewayKeyPath(paths));
    expect(await hasGatewayKey(paths)).toBe(false);
  });
});
