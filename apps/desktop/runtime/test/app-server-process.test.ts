import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerProcess } from "../src/app-server-process";
import {
  CodexRequestExpiredError,
  PinnedCodexPayloadError,
} from "../src/codex";
import type { RuntimePaths } from "../src/runtime-paths";

const FAULT_APP_SERVER = fileURLToPath(new URL("./fixtures/fault-app-server.ts", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixturePaths(codexHomeName = "codex-home"): Promise<RuntimePaths> {
  const root = await mkdtemp(join(tmpdir(), "oprte-process-core-"));
  temporaryDirectories.push(root);
  const codexHome = join(root, codexHomeName);
  const codexBinary = join(root, "fault-app-server");
  await mkdir(codexHome);
  const build = Bun.spawn(
    [process.execPath, "build", "--compile", FAULT_APP_SERVER, "--outfile", codexBinary],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
    build.exited,
  ]);
  if (exitCode !== 0) throw new Error(`fixture compile failed: ${stdout}${stderr}`);
  return { codexBinary, codexHome, gitBinary: "/usr/bin/git", gitRoot: "/usr" };
}

describe("Codex app-server process integration", () => {
  test("uses the canonical HRA Codex client identity", async () => {
    const source = await Bun.file(
      new URL("../src/app-server-process.ts", import.meta.url),
    ).text();

    expect(source).toMatch(
      /clientInfo:\s*\{\s*name:\s*"hra",\s*title:\s*"HRA",\s*version:\s*hraReleaseIdentity\.version,/u,
    );
    expect(source).not.toMatch(/clientInfo:\s*\{\s*name:\s*"oprte"/u);
  });

  test("rejects and expires a process that reports a different CODEX_HOME", async () => {
    const paths = await fixturePaths("wrong-codex-home");
    const [started] = await Promise.allSettled([
      CodexAppServerProcess.start(6, paths),
    ]);

    expect(started?.status).toBe("rejected");
    expect(
      await Bun.file(join(paths.codexHome, ".initialized-notification")).exists(),
    ).toBeFalse();
  });

  test("initializes through the pinned protocol and expires mutations without replay", async () => {
    const paths = await fixturePaths();
    const process = await CodexAppServerProcess.start(7, paths);
    expect(process.initialized.userAgent).toBe("fault-app-server/1");
    expect(process.initialized.codexHome).toBe(paths.codexHome);
    const request = process.protocol.request("turnInterrupt", {
      threadId: "fixture-thread",
      turnId: "fixture-turn",
    });
    expect(await process.faulted).toBe("process_exited");
    try {
      await request;
      throw new Error("expected request to expire");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(CodexRequestExpiredError);
      if (!(error instanceof CodexRequestExpiredError)) throw error;
      expect(error.automaticReplay).toBeFalse();
      expect(error.intent).toBe("ambiguousMutation");
    }
    await process.expire("process_exited");
  });

  test("turns malformed stdout into one terminal protocol fault", async () => {
    const diagnostics: string[] = [];
    const process = await CodexAppServerProcess.start(8, await fixturePaths(), {
      callbacks: {
        onDiagnostic(diagnostic) {
          diagnostics.push(diagnostic.type);
        },
      },
    });
    const request = process.protocol.request("accountRead", {
      refreshToken: true,
    });
    expect(await process.faulted).toBe("protocol_fault");
    try {
      await request;
      throw new Error("expected request to expire");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(CodexRequestExpiredError);
    }
    expect(diagnostics).toContain("invalid_envelope");
    await process.expire("protocol_fault");
  });

  test("keeps response-codec faults terminal when a diagnostic observer fails", async () => {
    const process = await CodexAppServerProcess.start(9, await fixturePaths(), {
      callbacks: {
        onDiagnostic() {
          throw new Error("fixture diagnostic observer failed");
        },
      },
    });
    const request = process.protocol.request("accountRead", {
      refreshToken: false,
    });
    expect(await process.faulted).toBe("protocol_fault");
    try {
      await request;
      throw new Error("expected response payload validation to fail");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(PinnedCodexPayloadError);
    }
    await process.expire("protocol_fault");
  });

  test("faults and kills a live generation after an ambiguous request timeout", async () => {
    const paths = await fixturePaths();
    const process = await CodexAppServerProcess.start(10, paths);
    const request = process.protocol.request("accountLoginCancel", {
      loginId: "login-live-wedge",
    });

    expect(await process.faulted).toBe("protocol_fault");
    const [result] = await Promise.allSettled([request]);
    expect(result?.status).toBe("rejected");
    if (result?.status !== "rejected") throw new Error("timed-out mutation resolved");
    expect(result.reason).toMatchObject({
      automaticReplay: false,
      generation: 10,
      intent: "ambiguousMutation",
      reason: "timeout",
    });
    await process.expire("protocol_fault");

    const attempts = (await Bun.file(
      join(paths.codexHome, ".ignored-mutations.jsonl"),
    ).text()).trim().split("\n");
    expect(attempts).toHaveLength(1);
    expect(JSON.parse(attempts[0] ?? "null")).toMatchObject({
      method: "account/login/cancel",
    });
  }, 20_000);
});
