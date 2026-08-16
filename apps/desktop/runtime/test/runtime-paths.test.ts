import { afterEach, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountPaths,
  resolvePortableRuntimeAssets,
  resolveRuntimePaths,
} from "../src/runtime-paths";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("repairs an existing credential directory to user-only permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "oprte-runtime-paths-"));
  temporaryDirectories.push(root);
  const codexHome = join(root, "codex-home");
  await mkdir(codexHome);
  await Bun.write(join(codexHome, ".keep"), "fixture");
  await chmod(codexHome, 0o777);

  const paths = resolveRuntimePaths({
    HRA_CODEX_BIN: "/usr/bin/true",
    HRA_CODEX_HOME: codexHome,
    HRA_GIT_BIN: "/usr/bin/true",
    HRA_GIT_ROOT: "/usr",
  });

  expect(paths.codexHome).toBe(await realpath(codexHome));
  expect((await stat(codexHome)).mode & 0o777).toBe(0o700);
});

test("shares portable runtime assets while isolating every account Codex home", async () => {
  const root = await mkdtemp(join(tmpdir(), "oprte-account-runtime-paths-"));
  temporaryDirectories.push(root);
  const assets = resolvePortableRuntimeAssets({
    HRA_CODEX_BIN: "/usr/bin/true",
    HRA_GIT_BIN: "/usr/bin/true",
    HRA_GIT_ROOT: "/usr",
  });

  const first = accountPaths(assets, join(root, "first", "codex-home"));
  const second = accountPaths(assets, join(root, "second", "codex-home"));

  expect(first.codexBinary).toBe(second.codexBinary);
  expect(first.gitBinary).toBe(second.gitBinary);
  expect(first.codexHome).not.toBe(second.codexHome);
  expect((await stat(first.codexHome)).mode & 0o777).toBe(0o700);
  expect((await stat(second.codexHome)).mode & 0o777).toBe(0o700);
});

test("rejects a relative account credential home", () => {
  const assets = resolvePortableRuntimeAssets({
    HRA_CODEX_BIN: "/usr/bin/true",
    HRA_GIT_BIN: "/usr/bin/true",
    HRA_GIT_ROOT: "/usr",
  });

  expect(() => accountPaths(assets, "profiles/account/codex-home")).toThrow(
    "Codex home must be an absolute path",
  );
});

test("uses the OPRTE root for the development credential fallback", async () => {
  const home = await mkdtemp(join(tmpdir(), "oprte-runtime-paths-"));
  temporaryDirectories.push(home);
  const canonicalHome = await realpath(home);

  const paths = resolveRuntimePaths({
    HOME: home,
    HRA_CODEX_BIN: "/usr/bin/true",
    HRA_GIT_BIN: "/usr/bin/true",
    HRA_GIT_ROOT: "/usr",
  });

  expect(paths.codexHome).toBe(
    join(
      canonicalHome,
      "Library",
      "Application Support",
      "OPRTE",
      "profiles",
      "default",
      "codex-home",
    ),
  );
  expect(
    await lstat(
      join(home, "Library", "Application Support", "OPRTE Development"),
    ).catch(() => null),
  ).toBeNull();
});
