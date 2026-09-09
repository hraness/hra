import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type HraAppearanceAsset = Readonly<{
  sourcePath: string;
  source: string;
  verifyInputs: () => Promise<void>;
}>;

type Snapshot = Readonly<{ path: string; bytes: Buffer; identity: string }>;
const maximumInputBytes = 8 * 1024 * 1024;
const maximumOutputBytes = 512 * 1024;
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function assertContained(root: string, path: string): void {
  const key = relative(root, path);
  assert.ok(key !== "" && key !== ".." && !key.startsWith("../") && !isAbsolute(key), "Appearance input must stay inside its repository");
}

async function readSnapshot(root: string, path: string): Promise<Snapshot> {
  assertContained(root, path);
  const canonical = await realpath(path);
  assertContained(root, canonical);
  const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    const identity = (stat: typeof before): string =>
      [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
    assert.ok(before.isFile() && before.size <= BigInt(maximumInputBytes), "Appearance input must be a bounded ordinary file");
    const buffer = Buffer.alloc(Number(before.size) + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, 0);
    assert.equal(BigInt(bytesRead), before.size, "Appearance input length changed while it was read");
    const bytes = buffer.subarray(0, bytesRead);
    assert.equal(identity(await file.stat({ bigint: true })), identity(before), "Appearance input changed while it was read");
    assert.equal(identity(await lstat(canonical, { bigint: true })), identity(before), "Appearance input was replaced while it was read");
    assert.equal(await realpath(path), canonical, "Appearance input target changed while it was read");
    return { path, bytes, identity: [canonical, identity(before), digest(bytes)].join(":") };
  } finally { await file.close(); }
}

async function compileHraAppearance(rootDirectory: string): Promise<Readonly<{ source: string; verifyInputs: () => Promise<void> }>> {
  const root = await realpath(rootDirectory);
  const sources = new Map<string, Snapshot>();
  const configuration = new Map<string, Snapshot | null>();
  let inputBytes = 0;
  const pendingConfiguration = new Map<string, Promise<void>>();
  const captureConfiguration = (path: string): Promise<void> => {
    const prior = pendingConfiguration.get(path);
    if (prior !== undefined) return prior;
    const capture = (async () => {
      try { configuration.set(path, await readSnapshot(root, path)); }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") configuration.set(path, null);
        else throw error;
      }
    })();
    pendingConfiguration.set(path, capture);
    return capture;
  };
  for (const name of ["package.json", "bun.lock", "bunfig.toml", "tsconfig.json", "scripts/build-appearance.ts"]) {
    await captureConfiguration(join(root, name));
  }
  const entrypoint = join(root, "app/src/appearance-entry.ts");
  const result = await Bun.build({
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    entrypoints: [entrypoint],
    root,
    format: "iife",
    minify: true,
    sourcemap: "none",
    target: "browser",
    metafile: true,
    plugins: [{
      name: "hra-appearance-source-capture",
      setup(build) {
        build.onLoad({ filter: /.*/, namespace: "file" }, async ({ path }) => {
          assert.ok(sources.size < 512, "Appearance input graph exceeded its bound");
          const snapshot = await readSnapshot(root, path);
          const prior = sources.get(path);
          if (prior !== undefined) assert.equal(snapshot.identity, prior.identity, "Appearance input changed during compilation");
          else {
            inputBytes += snapshot.bytes.byteLength;
            assert.ok(inputBytes <= maximumInputBytes, "Appearance input graph exceeded its byte bound");
            sources.set(path, snapshot);
          }
          for (let directory = dirname(path); ; directory = dirname(directory)) {
            assert.ok(directory === root || relative(root, directory) !== ".." && !relative(root, directory).startsWith("../"));
            await captureConfiguration(join(directory, "package.json"));
            await captureConfiguration(join(directory, "tsconfig.json"));
            if (directory === root) break;
          }
          const extension = extname(path);
          const loader = extension === ".tsx" ? "tsx" : extension === ".jsx" ? "jsx"
            : [".ts", ".mts", ".cts"].includes(extension) ? "ts"
              : [".js", ".mjs", ".cjs"].includes(extension) ? "js"
                : extension === ".json" ? "json" : null;
          assert.ok(loader !== null, "Appearance bootstrap imported an unsupported asset");
          return { contents: snapshot.bytes, loader };
        });
      },
    }],
  });
  const output = result.outputs[0];
  assert.ok(result.success, `HRA appearance bundle failed: ${result.logs.map((log) => log.message).join("\n")}`);
  assert.ok(result.outputs.length === 1 && output?.kind === "entry-point", "Appearance bootstrap must emit one classic program");
  const metafile = result.metafile;
  assert.ok(metafile !== undefined && Object.keys(metafile.inputs).length > 0, "Appearance compiler input graph was not captured");
  const emittedPrograms = Object.values(metafile.outputs);
  assert.equal(emittedPrograms.length, 1, "Appearance compiler must describe one emitted program");
  const emitted = emittedPrograms[0];
  assert.ok(emitted !== undefined && emitted.entryPoint !== undefined);
  assert.equal(resolve(root, emitted.entryPoint), entrypoint, "Appearance emitted entrypoint changed");
  assert.equal(emitted.imports.length, 0, "Appearance bootstrap cannot emit imports");
  assert.equal(emitted.exports.length, 0, "Appearance bootstrap cannot emit exports");
  const contributions = new Map<string, number>();
  for (const [key, contribution] of Object.entries(emitted.inputs)) {
    const path = resolve(root, key);
    assert.ok(sources.has(path), "Appearance output contains an uncaptured compiler input");
    assert.ok(Number.isSafeInteger(contribution.bytesInOutput) && contribution.bytesInOutput >= 0,
      "Appearance compiler reported an invalid input contribution");
    contributions.set(path, contribution.bytesInOutput);
  }
  const captured = new Set<string>();
  for (const [key, input] of Object.entries(metafile.inputs)) {
    const path = resolve(root, key);
    const snapshot = sources.get(path);
    assert.ok(snapshot !== undefined, "Appearance compiler used uncaptured input bytes");
    assert.equal(input.bytes, snapshot.bytes.byteLength, "Appearance compiler input length changed");
    // Bun marks unused package-barrel reexports external even when it removes
    // the whole barrel. Admit only explicitly zero-byte inputs; the emitted
    // program above must have no imports, including those through a barrel.
    if (input.imports.some((entry) => entry.external === true)) {
      assert.equal(contributions.get(path), 0, "Appearance input with external imports contributes emitted code");
    }
    captured.add(path);
  }
  // The loader may visit tree-shaken inputs; bind those as well, but no compiler
  // input or emitted contribution may bypass the exact bytes supplied above.
  assert.ok(captured.has(entrypoint), "Appearance compiler did not capture its entrypoint");
  assert.ok([...contributions.keys()].every((path) => captured.has(path)), "Appearance output input is absent from the captured graph");
  const source = await output.text();
  assert.equal(Buffer.byteLength(source), emitted.bytes, "Appearance output bytes differ from its compiler graph");
  assert.ok(Buffer.byteLength(source) > 0 && Buffer.byteLength(source) <= maximumOutputBytes, "Appearance bootstrap output exceeded its bound");
  const verifyInputs = async (): Promise<void> => {
    for (const snapshot of sources.values()) {
      assert.equal((await readSnapshot(root, snapshot.path)).identity, snapshot.identity, "Appearance compiler input changed after capture");
    }
    for (const [path, snapshot] of configuration) {
      if (snapshot !== null) assert.equal((await readSnapshot(root, path)).identity, snapshot.identity, "Appearance build configuration changed after capture");
      else await assert.rejects(lstat(path), { code: "ENOENT" }, "Appearance build configuration appeared after capture");
    }
  };
  await verifyInputs();
  return { source, verifyInputs };
}

/** A classic external script applies the saved palette before the page paints. */
export async function buildHraAppearance(): Promise<string> {
  const root = fileURLToPath(new URL("..", import.meta.url));
  return (await compileHraAppearance(root)).source;
}

/** Stage immutable compiler bytes so the StyleX adapter can bind a native asset. */
export async function stageHraAppearance(rootDirectory: string, runDirectory: string): Promise<HraAppearanceAsset> {
  const root = await realpath(rootDirectory);
  const run = await realpath(runDirectory);
  assertContained(root, run);
  assert.ok((await lstat(run)).isDirectory(), "Appearance staging directory is not ordinary");
  const compiled = await compileHraAppearance(root);
  const sourcePath = join(run, "appearance.js");
  await writeFile(sourcePath, compiled.source, { flag: "wx", mode: 0o600 });
  const staged = await readSnapshot(root, sourcePath);
  assert.equal(staged.bytes.toString("utf8"), compiled.source, "Staged appearance bytes differ from compiler output");
  const verifyInputs = async (): Promise<void> => {
    await compiled.verifyInputs();
    assert.equal((await readSnapshot(root, sourcePath)).identity, staged.identity, "Staged appearance output changed");
  };
  await verifyInputs();
  return { sourcePath, source: compiled.source, verifyInputs };
}

if (import.meta.main) process.stdout.write(await buildHraAppearance());
