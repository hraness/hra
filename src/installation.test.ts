import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertInstallationHome,
  createProductionInstallation,
} from "./installation";
import {
  createAcceptanceInstallation,
  type AcceptanceInstallationDescriptor,
} from "../scripts/live-acceptance-installation";
import { resolveStatePaths } from "./storage/paths";

const roots: string[] = [];
const ACCEPTANCE_RUN_ID = "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3b";

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { force: true, recursive: true });
  }));
});

async function acceptanceDescriptor(
  device: "a" | "b" = "a",
): Promise<AcceptanceInstallationDescriptor> {
  const runRoot = await realpath(
    await mkdtemp(join(tmpdir(), `hra-live-acceptance-${ACCEPTANCE_RUN_ID}-`)),
  );
  roots.push(runRoot);
  const documentsDirectory = join(runRoot, `project-${device}-fixture`);
  await mkdir(documentsDirectory, { mode: 0o700 });
  const expectedHomeDirectory = process.env.HOME;
  if (expectedHomeDirectory === undefined) throw new Error("Test requires HOME.");
  return {
    device,
    documentsDirectory,
    expectedHomeDirectory,
    rootDirectory: join(runRoot, `device-${device}-fixture`),
    runId: ACCEPTANCE_RUN_ID,
    type: "hra-live-acceptance-device",
    version: 1,
  };
}

describe("HRA installation composition", () => {
  test("keeps the production namespace fixed", () => {
    const installation = createProductionInstallation();
    expect(installation.kind).toBe("production");
    expect(installation.desktopSwitching).toBe(true);
    expect(installation.credentialStorePreflight).toEqual({
      cliAuth: "file",
      cwd: process.cwd(),
      mcpOauth: "file",
    });
    expect(installation.paths).toEqual(resolveStatePaths());
  });

  test("uses only file-backed custody and an isolated process temp directory", async () => {
    const descriptor = await acceptanceDescriptor();
    const installation = createAcceptanceInstallation(descriptor);
    await installation.prepareCodexHome(join(installation.paths.profiles, "profile-a", "codex-home"));
    const custody = installation.createSecretCustody();
    await expect(custody.compareAndSwap("device-secret", null, "secret-value")).resolves.toEqual({
      generation: 0,
      value: "secret-value",
    });

    const configPath = join(
      installation.paths.profiles,
      "profile-a",
      "codex-home",
      "config.toml",
    );
    expect(await readFile(configPath, "utf8")).toBe([
      'cli_auth_credentials_store = "file"',
      'mcp_oauth_credentials_store = "file"',
      "",
    ].join("\n"));
    expect((await lstat(configPath)).mode & 0o777).toBe(0o600);
    expect((await readdir(join(installation.paths.root, "secret-values"))).length).toBe(1);

    const environment = await installation.codexEnvironment(
      join(installation.paths.profiles, "profile-a", "codex-home"),
    );
    expect(environment?.HOME).toBe(process.env.HOME);
    expect(environment?.TMPDIR).toBe(
      join(installation.paths.profiles, "profile-a", "codex-home", "tmp"),
    );
    expect(environment?.CODEX_HOME).toBeUndefined();
    expect(environment?.HRA_CONVEX_URL).toBeUndefined();
    expect(installation.desktopSwitching).toBe(false);
    expect(installation.credentialStorePreflight).toEqual({
      cliAuth: "file",
      cwd: descriptor.documentsDirectory,
      mcpOauth: "file",
    });
  });

  test("refuses a changed Codex credential-store file on restart", async () => {
    const installation = createAcceptanceInstallation(await acceptanceDescriptor());
    const codexHome = join(installation.paths.profiles, "profile-a", "codex-home");
    await installation.prepareCodexHome(codexHome);
    const configPath = join(codexHome, "config.toml");
    await writeFile(configPath, 'mcp_oauth_credentials_store = "keyring"\n');
    await chmod(configPath, 0o600);

    await expect(installation.prepareCodexHome(codexHome)).rejects.toThrow(
      "unexpected credential-store configuration",
    );
  });

  test("rejects unbounded roots, unknown descriptor fields, and HOME changes", async () => {
    const descriptor = await acceptanceDescriptor();
    expect(() => createAcceptanceInstallation({
      ...descriptor,
      rootDirectory: join(descriptor.rootDirectory, "nested"),
    })).toThrow("direct child");
    expect(() => createAcceptanceInstallation({
      ...descriptor,
      extra: true,
    } as AcceptanceInstallationDescriptor)).toThrow();

    const installation = createAcceptanceInstallation({
      ...descriptor,
      expectedHomeDirectory: join(descriptor.expectedHomeDirectory, "changed"),
    });
    expect(() => assertInstallationHome(installation)).toThrow("preserve the invoking HOME");
  });
});
