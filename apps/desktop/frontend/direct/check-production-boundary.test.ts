import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { checkHRAProductionBoundary } from "./check-production-boundary";

const temporaryDirectories: string[] = [];

async function makeFrontend(options: {
  readonly contractSource?: string;
  readonly emitted?: string | null;
  readonly nativeEmitted?: string;
  readonly packagedNativeEmitted?: string;
  readonly runtimeEmitted?: string;
  readonly runtimeSource?: string;
  readonly source?: string;
  readonly testSource?: string;
} = {}): Promise<string> {
  const desktop = await mkdtemp(path.join(tmpdir(), "hra-direct-boundary-"));
  const frontend = path.join(desktop, "frontend");
  temporaryDirectories.push(desktop);
  await mkdir(path.join(frontend, "src"), { recursive: true });
  await writeFile(
    path.join(frontend, "src/main.ts"),
    options.source ?? "export const production = true;\n",
    "utf8",
  );
  if (options.testSource !== undefined) {
    await writeFile(path.join(frontend, "src/main.test.ts"), options.testSource, "utf8");
  }
  if (options.emitted !== null) {
    await mkdir(path.join(frontend, "dist"), { recursive: true });
    if (options.emitted !== undefined) {
      await writeFile(path.join(frontend, "dist/index.js"), options.emitted, "utf8");
    }
  }
  if (options.runtimeSource !== undefined) {
    await mkdir(path.join(desktop, "runtime", "src"), { recursive: true });
    await writeFile(path.join(desktop, "runtime", "src", "main.ts"), options.runtimeSource, "utf8");
  }
  if (options.contractSource !== undefined) {
    await mkdir(path.join(desktop, "contracts"), { recursive: true });
    await writeFile(path.join(desktop, "contracts", "runtime.ts"), options.contractSource, "utf8");
  }
  if (options.runtimeEmitted !== undefined) {
    await mkdir(path.join(desktop, "runtime", "dist"), { recursive: true });
    await writeFile(
      path.join(desktop, "runtime", "dist", "oprte-gateway"),
      options.runtimeEmitted,
      "utf8",
    );
  }
  if (options.nativeEmitted !== undefined) {
    await mkdir(path.join(desktop, "zig-out", "bin"), { recursive: true });
    await writeFile(
      path.join(desktop, "zig-out", "bin", "oprte"),
      options.nativeEmitted,
      "utf8",
    );
  }
  if (options.packagedNativeEmitted !== undefined) {
    const executableDirectory = path.join(
      desktop,
      "zig-out",
      "package",
      "OPRTE-0.1.7-macos-ReleaseFast.app",
      "Contents",
      "MacOS",
    );
    await mkdir(executableDirectory, { recursive: true });
    await writeFile(
      path.join(executableDirectory, "oprte"),
      options.packagedNativeEmitted,
      "utf8",
    );
  }
  return frontend;
}

async function boundaryFailure(frontend: string): Promise<Error> {
  try {
    await checkHRAProductionBoundary(frontend);
  } catch (reason) {
    if (reason instanceof Error) return reason;
    throw reason;
  }
  throw new Error("Expected the HRA production boundary to reject the fixture.");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    force: true,
    recursive: true,
  })));
});

describe("HRA production Direct boundary", () => {
  test("rejects natural sibling fixture imports without relying on a package marker", async () => {
    const frontend = await makeFrontend({
      emitted: "export const production = true;\n",
      source: 'import { fixture } from "../direct/world";\nexport { fixture };\n',
    });

    expect((await boundaryFailure(frontend)).message).toContain(
      "production assets contain browser-lab markers",
    );
  });

  test("ignores Direct references that exist only in colocated test modules", async () => {
    const frontend = await makeFrontend({
      emitted: "export const production = true;\n",
      testSource: 'import document from "../direct/index.html?raw";\nvoid document;\n',
    });

    const result = await checkHRAProductionBoundary(frontend);

    expect(result.source.scanned).toEqual([path.join(frontend, "src/main.ts")]);
    expect(result.source.violations).toEqual([]);
  });

  test("fails closed when the production output is missing or empty", async () => {
    const missing = await makeFrontend({ emitted: null });
    const empty = await makeFrontend();

    expect((await boundaryFailure(missing)).message).toContain(
      "did not scan any emitted production assets",
    );
    expect((await boundaryFailure(empty)).message).toContain(
      "did not scan any emitted production assets",
    );
  });

  test("rejects Direct from gateway source and emitted runtime surfaces", async () => {
    const sourceLeak = await makeFrontend({
      emitted: "export const production = true;\n",
      runtimeSource: 'import { createLogicalRuntime } from "@hraness/direct";\nvoid createLogicalRuntime;\n',
    });
    const emittedLeak = await makeFrontend({
      emitted: "export const production = true;\n",
      runtimeEmitted: "binary\0direct.runtime/v1\0",
    });
    const contractLeak = await makeFrontend({
      contractSource: 'export { LOGICAL_RUNTIME_SCHEMA } from "@hraness/direct";\n',
      emitted: "export const production = true;\n",
    });

    expect((await boundaryFailure(sourceLeak)).message).toContain("@hraness/direct");
    expect((await boundaryFailure(emittedLeak)).message).toContain("direct.runtime/");
    expect((await boundaryFailure(contractLeak)).message).toContain("@hraness/direct");
  });

  test("rejects distinctive Hugeicons module and compiled glyph markers", async () => {
    for (const marker of [
      "@hugeicons/core-free-icons",
      "@hugeicons/react",
      "Hugeicons",
    ]) {
      const frontend = await makeFrontend({ emitted: `const iconRuntime = ${JSON.stringify(marker)};\n` });

      expect((await boundaryFailure(frontend)).message).toContain(
        "production assets contain forbidden frontend dependencies",
      );
    }
  });

  test("rejects serve-only malleable-development markers from production output", async () => {
    for (const marker of [
      "hra-dev-status/v1",
      "/__hra_dev_status",
      "hra:dev-status",
      "HRA — Dev",
    ]) {
      const frontend = await makeFrontend({
        emitted: `const developmentMarker = ${JSON.stringify(marker)};\n`,
      });

      expect((await boundaryFailure(frontend)).message).toContain(
        "production assets contain malleable-development markers",
      );
    }
  });

  test("scans both retained oprte native executable locations", async () => {
    const installedLeak = await makeFrontend({
      emitted: "export const production = true;\n",
      nativeEmitted: "binary\0direct.runtime/v1\0",
    });
    const packagedLeak = await makeFrontend({
      emitted: "export const production = true;\n",
      packagedNativeEmitted: "binary\0direct.runtime/v1\0",
    });

    expect((await boundaryFailure(installedLeak)).message).toContain(
      "direct.runtime/",
    );
    expect((await boundaryFailure(packagedLeak)).message).toContain(
      "direct.runtime/",
    );
  });

  test("rejects gateway-private state from the renderer contract and production graph", async () => {
    const contractLeak = await makeFrontend({
      contractSource: "export const provider = { providerThreadId: 'thread_private' };\n",
      emitted: "export const production = true;\n",
    });
    const importLeak = await makeFrontend({
      emitted: "export const production = true;\n",
      source: 'import type { ThreadSummary } from "../../runtime/src/internal-contracts";\nexport type { ThreadSummary };\n',
    });
    const emittedLeak = await makeFrontend({
      emitted: 'const eventType = "interaction.upserted";\n',
    });

    expect((await boundaryFailure(contractLeak)).message).toContain(
      "renderer boundary exposes gateway-private state",
    );
    expect((await boundaryFailure(importLeak)).message).toContain(
      "runtime/src/internal-contracts",
    );
    expect((await boundaryFailure(emittedLeak)).message).toContain("interaction.upserted");
  });

  test("admits only the app-owned transient chat prompt and turn vocabulary", async () => {
    const chatCommand = await makeFrontend({
      contractSource: `
        export const command = {
          type: "chat.turn.start",
          paneId: "pane_owned",
          turnId: "chatturn_owned",
          prompt: "transient renderer input",
        };
      `,
      emitted: 'const command = "chat.turn.start";\n',
    });
    const privateProviderCommand = await makeFrontend({
      emitted: 'const command = "turn.start";\n',
    });
    const privateRestartBinding = await makeFrontend({
      contractSource: "export const binding = { restartThreadId: 'thread_raw' };\n",
      emitted: "export const production = true;\n",
    });

    expect((await checkHRAProductionBoundary(chatCommand)).source.violations)
      .toEqual([]);
    expect((await boundaryFailure(privateProviderCommand)).message)
      .toContain('"turn.start"');
    expect((await boundaryFailure(privateRestartBinding)).message)
      .toContain("restartThreadId:");
  });

  test("distinguishes portable task vocabulary from gateway-private workspace and interaction events", async () => {
    const portable = await makeFrontend({
      contractSource: `
        export const portableKinds = [
          "workspace.rename",
          "interaction.respond",
          "interaction.settle",
        ];
      `,
      emitted: "export const production = true;\n",
    });
    const privateWorkspace = await makeFrontend({
      contractSource: 'export const kind = "workspace.upserted";\n',
      emitted: "export const production = true;\n",
    });
    const privateInteraction = await makeFrontend({
      contractSource: 'export const kind = "interaction.upserted";\n',
      emitted: "export const production = true;\n",
    });

    expect((await checkHRAProductionBoundary(portable)).source.violations)
      .toEqual([]);
    expect((await boundaryFailure(privateWorkspace)).message)
      .toContain('"workspace.upserted');
    expect((await boundaryFailure(privateInteraction)).message)
      .toContain('"interaction.upserted');
  });

  test("accepts a non-empty production graph without fixture markers", async () => {
    const frontend = await makeFrontend({ emitted: "export const production = true;\n" });

    const result = await checkHRAProductionBoundary(frontend);

    expect(result.source.scanned).toHaveLength(1);
    expect(result.emitted.scanned).toHaveLength(1);
  });
});
