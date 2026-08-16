import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  isCompatibleZigVersion,
  nativeSdkZigVersion,
  resolveZigExecutable,
} from "../zig-toolchain";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function executable(
  directory: string,
  version = nativeSdkZigVersion,
  name = "zig",
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  await Bun.write(path, `#!/bin/sh\nprintf '${version}\\n'\n`);
  await chmod(path, 0o755);
  return path;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hra zig toolchain "));
  temporaryDirectories.push(root);
  return root;
}

test("resolves a compatible Zig from PATH in directory order", async () => {
  const root = await temporaryRoot();
  const first = await executable(join(root, "first"));
  await executable(join(root, "second"), "0.16.2");

  expect(
    resolveZigExecutable(
      { PATH: [join(root, "first"), join(root, "second")].join(delimiter) },
      { commonExecutables: [] },
    ),
  ).toBe(await realpath(first));
});

test("uses a common-location fallback when PATH omits Zig", async () => {
  const root = await temporaryRoot();
  const fallback = await executable(join(root, "homebrew"));

  expect(
    resolveZigExecutable(
      { PATH: "/usr/bin" },
      { commonExecutables: [fallback] },
    ),
  ).toBe(await realpath(fallback));
});

test("NATIVE_SDK_ZIG wins, is canonicalized, and permits an intentional version", async () => {
  const root = await temporaryRoot();
  const target = await executable(join(root, "toolchain"), "0.17.0-dev.1", "zig-real");
  const override = join(root, "zig");
  await symlink(target, override);

  expect(
    resolveZigExecutable(
      { NATIVE_SDK_ZIG: override, PATH: "/path/that/is/not/used" },
      { commonExecutables: [] },
    ),
  ).toBe(await realpath(target));
});

test("a blank override is ignored and invalid explicit overrides fail closed", async () => {
  const root = await temporaryRoot();
  const fallback = await executable(join(root, "fallback"));

  expect(
    resolveZigExecutable(
      { NATIVE_SDK_ZIG: "  ", PATH: "" },
      { commonExecutables: [fallback] },
    ),
  ).toBe(await realpath(fallback));
  expect(() =>
    resolveZigExecutable(
      { NATIVE_SDK_ZIG: "relative/zig" },
      { commonExecutables: [fallback] },
    ),
  ).toThrow("NATIVE_SDK_ZIG must be an absolute path");
  expect(() =>
    resolveZigExecutable(
      { NATIVE_SDK_ZIG: join(root, "missing-zig") },
      { commonExecutables: [fallback] },
    ),
  ).toThrow("NATIVE_SDK_ZIG is not an executable file");
});

test("rejects incompatible PATH Zig and uses the Native SDK managed toolchain", async () => {
  const root = await temporaryRoot();
  await executable(join(root, "path"), "0.17.0");
  const managed = await executable(
    join(root, "native", "toolchains", `zig-${nativeSdkZigVersion}`),
  );

  expect(
    resolveZigExecutable(
      {
        NATIVE_SDK_HOME: join(root, "native"),
        PATH: join(root, "path"),
      },
      { commonExecutables: [] },
    ),
  ).toBe(await realpath(managed));
});

test("NATIVE_SDK_HOME takes precedence over the HOME managed location", async () => {
  const root = await temporaryRoot();
  const nativeHomeManaged = await executable(
    join(root, "native", "toolchains", `zig-${nativeSdkZigVersion}`),
  );
  await executable(
    join(root, "home", ".native", "toolchains", `zig-${nativeSdkZigVersion}`),
  );

  expect(
    resolveZigExecutable(
      {
        HOME: join(root, "home"),
        NATIVE_SDK_HOME: join(root, "native"),
        PATH: "",
      },
      { commonExecutables: [] },
    ),
  ).toBe(await realpath(nativeHomeManaged));
});

test("compatibility pins major and minor, floors patch, and rejects prereleases", () => {
  expect(isCompatibleZigVersion("0.16.0")).toBe(true);
  expect(isCompatibleZigVersion("0.16.2")).toBe(true);
  expect(isCompatibleZigVersion("0.16.2+local.1")).toBe(true);
  expect(isCompatibleZigVersion("0.15.1")).toBe(false);
  expect(isCompatibleZigVersion("0.17.0")).toBe(false);
  expect(isCompatibleZigVersion("0.17.0-dev.123+abcdef")).toBe(false);
  expect(isCompatibleZigVersion("garbage")).toBe(false);
});

test("reports actionable setup when no compatible executable can be found", async () => {
  const root = await temporaryRoot();
  const wrongVersion = await executable(join(root, "wrong"), "0.15.2");

  expect(() =>
    resolveZigExecutable(
      { PATH: "relative-only" },
      { commonExecutables: [wrongVersion] },
    ),
  ).toThrow("Install it with `brew install zig`");
});
