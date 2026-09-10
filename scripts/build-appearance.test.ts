import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOompaAppearance, stageOompaAppearance } from "./build-appearance.ts";

const fixtures: string[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture(): Promise<{ root: string; run: string; entry: string; imported: string }> {
  const root = await mkdtemp(join(tmpdir(), "oompa-appearance-source-"));
  fixtures.push(root);
  const run = join(root, "run");
  const entry = join(root, "app/src/appearance-entry.ts");
  const imported = join(root, "app/src/preference.ts");
  await mkdir(join(root, "app/src"), { recursive: true });
  await mkdir(run, { mode: 0o700 });
  await writeFile(join(root, "package.json"), '{"name":"appearance-fixture","type":"module"}\n');
  await writeFile(join(root, "bun.lock"), "fixture lock\n");
  await writeFile(join(root, "tsconfig.json"), '{"compilerOptions":{"target":"ES2022"}}\n');
  await writeFile(imported, 'export const preference = "appearance-capture-marker";\n');
  await writeFile(entry, 'import { preference } from "./preference"; globalThis.appearanceFixture = preference;\n');
  return { root, run, entry, imported };
}

test("stages one root-contained ordinary classic asset bound to actual compiler inputs", async () => {
  const { root, run } = await fixture();
  const asset = await stageOompaAppearance(root, run);
  expect(asset.sourcePath).toBe(join(await realpath(run), "appearance.js"));
  expect(await readFile(asset.sourcePath, "utf8")).toBe(asset.source);
  expect(asset.source).toContain("appearance-capture-marker");
  expect(asset.source).not.toMatch(/\bimport\s/u);
  expect((await stat(asset.sourcePath)).mode & 0o777).toBe(0o600);
  await asset.verifyInputs();
  await expect(stageOompaAppearance(root, run)).rejects.toThrow();
});

test("binds cwd-relative compiler paths when the explicit build root differs", async () => {
  const { root, run } = await fixture();
  const cwd = join(root, "launcher/nested");
  await mkdir(cwd, { recursive: true });
  // Start a child rather than changing the test process's shared cwd. Both
  // directories exist below one owned fixture, but resolve ../ differently.
  const child = Bun.spawn([process.execPath, "--eval", `
    import assert from "node:assert/strict";
    import { realpath, writeFile } from "node:fs/promises";
    import { join, resolve } from "node:path";
    const [rootArgument, run, helper] = process.argv.slice(1);
    const root = await realpath(rootArgument);
    const entrypoint = join(root, "app/src/appearance-entry.ts");
    const observed = await Bun.build({ entrypoints: [entrypoint], root, format: "iife", target: "browser", minify: true, metafile: true });
    assert.ok(observed.success);
    const emitted = Object.values(observed.metafile.outputs)[0];
    assert.equal(resolve(process.cwd(), emitted.entryPoint), entrypoint);
    assert.notEqual(resolve(root, emitted.entryPoint), entrypoint);
    const { stageOompaAppearance } = await import(helper);
    const asset = await stageOompaAppearance(root, run);
    assert.ok(asset.source.includes("appearance-capture-marker"));
    await asset.verifyInputs();
    await writeFile(join(root, "app/src/preference.ts"), 'export const preference = "changed";');
    await assert.rejects(asset.verifyInputs(), /changed after capture/);
    process.stdout.write("cwd-relative appearance graph verified");
  `, root, run, new URL("./build-appearance.ts", import.meta.url).href], {
    cwd,
    env: { PATH: process.env.PATH ?? "", NODE_ENV: "production" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5_000,
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(status, stderr).toBe(0);
  expect(stdout).toBe("cwd-relative appearance graph verified");
}, 7_000);

test("rejects imported source changes after compilation", async () => {
  const { root, run, imported } = await fixture();
  const asset = await stageOompaAppearance(root, run);
  await writeFile(imported, 'export const preference = "changed";\n');
  await expect(asset.verifyInputs()).rejects.toThrow("changed after capture");
});

test("rejects configuration drift and a new configuration file after compilation", async () => {
  for (const name of ["bun.lock", "app/tsconfig.json"]) {
    const { root, run } = await fixture();
    const asset = await stageOompaAppearance(root, run);
    await writeFile(join(root, name), '{}\n');
    await expect(asset.verifyInputs()).rejects.toThrow(/configuration (changed|appeared) after capture/u);
  }
});

test("rejects changed staged compiler output", async () => {
  const { root, run } = await fixture();
  const asset = await stageOompaAppearance(root, run);
  await writeFile(asset.sourcePath, "changed output");
  await expect(asset.verifyInputs()).rejects.toThrow("Staged appearance output changed");
});

test("rejects imported symlinks escaping the root and browser-incompatible external modules", async () => {
  for (const escape of [true, false]) {
    const { root, run, entry, imported } = await fixture();
    if (escape) {
      const outside = await mkdtemp(join(tmpdir(), "oompa-appearance-outside-"));
      fixtures.push(outside);
      const source = join(outside, "outside.ts");
      await writeFile(source, 'export const preference = "outside";\n');
      await rm(imported);
      await symlink(source, imported);
    } else await writeFile(entry, 'import fs from "node:fs"; globalThis.appearanceFixture = fs;\n');
    await expect(stageOompaAppearance(root, run)).rejects.toThrow();
  }
});


test("rejects a FIFO configuration input without waiting for a writer", async () => {
  const { root, run } = await fixture();
  const path = join(root, "bun.lock");
  await rm(path);
  const create = Bun.spawn(["mkfifo", path], { stdout: "ignore", stderr: "pipe" });
  expect(await create.exited).toBe(0);
  await expect(stageOompaAppearance(root, run)).rejects.toThrow("bounded ordinary file");
}, 2_000);


test("captures a tree-shaken package barrel while omitting its unused reexport", async () => {
  const { root, run, entry } = await fixture();
  const dependency = join(root, "node_modules/appearance-package");
  await mkdir(dependency, { recursive: true });
  await writeFile(join(dependency, "package.json"), '{"name":"appearance-package","type":"module","sideEffects":false,"exports":"./index.js"}\n');
  await writeFile(join(dependency, "index.js"), 'export { preference } from "./preference.js"; export { unused } from "./unused.js";\n');
  await writeFile(join(dependency, "preference.js"), 'export const preference = "retained-package-preference";\n');
  await writeFile(join(dependency, "unused.js"), 'export function unused() { return "discarded-package-feature"; }\n');
  await writeFile(entry, 'import { preference } from "appearance-package"; globalThis.appearanceFixture = preference;\n');
  // Reproduce Bun's source-edge representation rather than assuming every
  // unused import is reported as external by the pinned compiler.
  const observed = await Bun.build({ entrypoints: [entry], root, format: "iife", target: "browser", minify: true, metafile: true });
  expect(observed.success).toBe(true);
  const barrel = Object.keys(observed.metafile?.inputs ?? {}).find((key) => key.endsWith("/appearance-package/index.js"));
  expect(barrel, JSON.stringify(observed.metafile?.inputs)).toBeDefined();
  expect(observed.metafile!.inputs[barrel!]!.imports.some((edge) => edge.external === true)).toBe(true);
  expect(Object.values(observed.metafile?.outputs ?? {})[0]?.inputs[barrel!]?.bytesInOutput).toBe(0);
  const asset = await stageOompaAppearance(root, run);
  expect(asset.source).toContain("retained-package-preference");
  expect(asset.source).not.toContain("discarded-package-feature");
  await asset.verifyInputs();
  await writeFile(join(dependency, "index.js"), 'export { preference } from "./preference.js";\n');
  await expect(asset.verifyInputs()).rejects.toThrow("changed after capture");
});

test("rejects an emitted external import even when it passes through a package barrel", async () => {
  const { root, run, entry } = await fixture();
  const dependency = join(root, "node_modules/appearance-package");
  await mkdir(dependency, { recursive: true });
  await writeFile(join(dependency, "package.json"), '{"name":"appearance-package","type":"module","sideEffects":false,"exports":"./index.js"}\n');
  await writeFile(join(dependency, "index.js"), 'export { preference } from "https://appearance.invalid/module.js";\n');
  await writeFile(entry, 'import { preference } from "appearance-package"; globalThis.appearanceFixture = preference;\n');
  await expect(stageOompaAppearance(root, run)).rejects.toThrow("Appearance input with external imports contributes emitted code");
});

test("the installed shared package compiles to one closed appearance program", async () => {
  const source = await buildOompaAppearance();
  expect(source).toContain("hraness-design-palette-v1");
  expect(source).toContain("data-oompa-appearance");
  expect(source).not.toContain("highlightCode");
});
