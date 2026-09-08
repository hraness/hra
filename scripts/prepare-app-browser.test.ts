import { expect, test } from "bun:test";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertBrowserDriverAst, publishBrowserDriver, settleBrowserDriverPublication } from "./prepare-app-browser.ts";
import { browserFile } from "./app-browser-handoff.ts";

const importNode = (value: string) => ({ type: "ImportDeclaration", source: { type: "StringLiteral", value } });
const tree = (...body: unknown[]) => ({ type: "Program", body: [importNode("playwright-core"), ...body] });

test("emitted driver closure admits only native Node and the three runtime dependencies", () => {
  expect(() => assertBrowserDriverAst(tree(importNode("node:http"), importNode("linkedom"), importNode("lightningcss")))).not.toThrow();
  for (const path of ["bun:ffi", "vite", "@hraness/ui/stylex-build", "./build-app.ts", "./other.mjs", "/private/source.ts"]) {
    expect(() => assertBrowserDriverAst(tree(importNode(path)))).toThrow();
  }
  expect(() => assertBrowserDriverAst({ type: "Program", body: [importNode("node:http")] })).toThrow("real installed Playwright");
  expect(() => assertBrowserDriverAst(tree({ type: "Identifier", name: "Bun" }))).toThrow("global Bun");
});

test("driver closure refuses computed imports and CommonJS or eval escape hatches", () => {
  for (const name of ["require", "eval"]) {
    expect(() => assertBrowserDriverAst(tree({ type: "CallExpression", callee: { type: "Identifier", name }, arguments: [] }))).toThrow();
  }
  expect(() => assertBrowserDriverAst(tree({ type: "ImportExpression", source: { type: "Identifier", name: "runtimePath" } }))).toThrow();
  expect(() => assertBrowserDriverAst(tree({ type: "CallExpression", callee: { type: "Import" }, arguments: [{ type: "Identifier", name: "runtimePath" }] }))).toThrow();
  expect(() => assertBrowserDriverAst(tree({ type: "ImportExpression", source: { type: "StringLiteral", value: "playwright-core" } }))).not.toThrow();
});

const publicationStages = ["open-driver", "write", "file-sync", "file-close", "open-directory", "directory-sync", "directory-close"] as const;
type PublicationStage = typeof publicationStages[number];
function publicationFixture(failures: ReadonlyMap<PublicationStage, unknown> = new Map()) {
  const events: PublicationStage[] = [];
  const step = (stage: PublicationStage): Promise<void> => {
    events.push(stage);
    return failures.has(stage) ? Promise.reject(failures.get(stage)) : Promise.resolve();
  };
  return { events, operations: {
    openDriver: async () => {
      await step("open-driver");
      return { write: () => step("write"), sync: () => step("file-sync"), close: () => step("file-close") };
    },
    openDirectory: async () => {
      await step("open-directory");
      return { sync: () => step("directory-sync"), close: () => step("directory-close") };
    },
  } };
}

test("driver publication finishes file write/sync/close and directory sync/close before admission", async () => {
  const fixture = publicationFixture();
  await settleBrowserDriverPublication(fixture.operations);
  expect(fixture.events).toEqual([...publicationStages]);
});

test("every driver publication failure stops admission and closes each acquired descriptor once", async () => {
  const expected: Record<PublicationStage, PublicationStage[]> = {
    "open-driver": ["open-driver"],
    write: ["open-driver", "write", "file-close"],
    "file-sync": ["open-driver", "write", "file-sync", "file-close"],
    "file-close": ["open-driver", "write", "file-sync", "file-close"],
    "open-directory": ["open-driver", "write", "file-sync", "file-close", "open-directory"],
    "directory-sync": [...publicationStages],
    "directory-close": [...publicationStages],
  };
  for (const stage of publicationStages) {
    const failure = new Error(stage), fixture = publicationFixture(new Map<PublicationStage, unknown>([[stage, failure]]));
    await expect(settleBrowserDriverPublication(fixture.operations)).rejects.toBe(failure);
    expect(fixture.events).toEqual(expected[stage]);
  }
});

test("descriptor-close failures preserve the primary write or sync error", async () => {
  for (const stage of ["write", "file-sync", "directory-sync"] as const) {
    const closeStage = stage === "directory-sync" ? "directory-close" : "file-close";
    const first = new Error(stage), second = new Error(closeStage);
    const fixture = publicationFixture(new Map<PublicationStage, unknown>([[stage, first], [closeStage, second]]));
    let caught: unknown;
    try { await settleBrowserDriverPublication(fixture.operations); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AggregateError);
    if (!(caught instanceof AggregateError)) throw new Error("Missing publication aggregate");
    expect(caught.errors).toEqual([first, second]);
    expect(fixture.events.filter((event) => event === closeStage)).toHaveLength(1);
  }
  const fixture = publicationFixture(new Map<PublicationStage, unknown>([["write", undefined]]));
  await expect(settleBrowserDriverPublication(fixture.operations)).rejects.toThrow("publication failed");
  expect(fixture.events).toEqual(["open-driver", "write", "file-close"]);
});

test("durable driver bytes remain private, write-once and identity-bound", async () => {
  const run = await realpath(await mkdtemp(join(tmpdir(), "browser-driver-publication-test-")));
  try {
    const bytes = Buffer.from("export const fixture = true;\n"), path = join(run, "driver.mjs");
    await publishBrowserDriver(run, bytes);
    expect(await readFile(path)).toEqual(bytes);
    const metadata = await lstat(path);
    expect(metadata.mode & 0o777).toBe(0o600); expect(metadata.nlink).toBe(1);
    const sealed = await browserFile(run, "driver.mjs");
    expect(sealed.identity).toHaveLength(7);
    await expect(publishBrowserDriver(run, Buffer.from("replacement"))).rejects.toThrow();
    expect(await browserFile(run, "driver.mjs")).toEqual(sealed);
    await chmod(path, 0o400);
    expect(await browserFile(run, "driver.mjs")).not.toEqual(sealed);
    await chmod(path, 0o600);
    const beforeAlias = await browserFile(run, "driver.mjs");
    await link(path, join(run, "alias"));
    expect(await browserFile(run, "driver.mjs")).not.toEqual(beforeAlias);
  } finally { await rm(run, { recursive: true }); }
});

test("driver publication refuses linked targets, nonphysical directories and invalid byte bounds", async () => {
  const run = await realpath(await mkdtemp(join(tmpdir(), "browser-driver-refusal-test-")));
  try {
    const target = join(run, "retained"); await writeFile(target, "retained", { mode: 0o600 });
    const linked = join(run, "linked"); await mkdir(linked);
    await symlink(target, join(linked, "driver.mjs"));
    await expect(publishBrowserDriver(linked, Buffer.from("replacement"))).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("retained");
    const alias = join(run, "directory-alias"); await symlink(linked, alias);
    await expect(publishBrowserDriver(alias, Buffer.from("replacement"))).rejects.toThrow("physical");
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(4 * 1024 * 1024 + 1)]) {
      await expect(publishBrowserDriver(run, bytes)).rejects.toThrow();
    }
    expect((await lstat(join(linked, "driver.mjs"))).isSymbolicLink()).toBe(true);
  } finally { await rm(run, { recursive: true }); }
});
