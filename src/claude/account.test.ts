import { describe, expect, test } from "bun:test";
import { constants } from "node:fs";
import { chmod, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  claudeAccountDocumentPath,
  readClaudeAccountProjection,
} from "./account";
import { CLAUDE_PIN, CLAUDE_PIN_EFFORT, CLAUDE_PIN_MODEL, CLAUDE_PIN_NATIVE_FALLBACK_CAPABILITY } from "./pin";
import type { PinnedClaudeRuntime } from "./runtime";

const runtime: PinnedClaudeRuntime = Object.freeze({
  argv: ["/synthetic/bin/claude"] as const,
  effort: CLAUDE_PIN_EFFORT,
  executablePath: "/synthetic/bin/claude",
  model: CLAUDE_PIN_MODEL,
  nativeFallback: CLAUDE_PIN_NATIVE_FALLBACK_CAPABILITY,
  version: CLAUDE_PIN,
});

const accountMetadata = (identity: Readonly<Record<string, unknown>> = {}) => ({
  oauthAccount: {
    accountUuid: " Account-A ",
    emailAddress: " Account-A@Example.test ",
    organizationUuid: " Organization-A ",
    ...identity,
  },
});

function fifoTestsSupported(): boolean {
  return process.platform !== "win32" && Bun.which("mkfifo") !== null;
}

function makeFifo(path: string): void {
  const created = Bun.spawnSync({ cmd: ["mkfifo", path] });
  if (created.exitCode !== 0) {
    throw new Error(`mkfifo failed: ${new TextDecoder().decode(created.stderr)}`);
  }
}

async function rejectBeforeFifoWriter(pending: Promise<unknown>, fifo: string): Promise<void> {
  type Outcome =
    | Readonly<{ kind: "blocked" }>
    | Readonly<{ kind: "rejected"; error: unknown }>
    | Readonly<{ kind: "resolved" }>;
  const completion: Promise<Outcome> = pending.then(
    () => ({ kind: "resolved" }),
    (error: unknown) => ({ kind: "rejected", error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const blocked = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "blocked" }), 1_000);
  });
  const outcome = await Promise.race([completion, blocked]);
  if (timer !== undefined) clearTimeout(timer);
  if (outcome.kind === "rejected") {
    expect(outcome.error).toMatchObject({ code: "AUTHORITY_STALE" });
    return;
  }
  if (outcome.kind === "resolved") {
    throw new Error("Claude account FIFO was accepted as metadata.");
  }

  const writer = await open(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
  await writer.close();
  await completion;
  throw new Error("Claude account FIFO open blocked instead of failing promptly.");
}

describe("Claude account projection", () => {
  test("uses the documented personal and isolated account document paths", () => {
    expect(claudeAccountDocumentPath("/synthetic/.claude", "personal"))
      .toBe("/synthetic/.claude.json");
    expect(claudeAccountDocumentPath("/synthetic/profiles/work", "isolated"))
      .toBe("/synthetic/profiles/work/.claude.json");
    expect(() => claudeAccountDocumentPath("relative", "isolated"))
      .toThrow("must be absolute");
  });

  test("fences a stable pre-status-post identity and projects account organization metadata", async () => {
    const calls: string[] = [];
    const statusInputs: unknown[] = [];
    const projection = await readClaudeAccountProjection({
      configDir: "/synthetic/profiles/work",
      configHome: "isolated",
      runtime,
      signal: new AbortController().signal,
      readMetadata: async (path) => {
        calls.push(`metadata:${path}`);
        return accountMetadata();
      },
      probeAuthStatus: async (input) => {
        calls.push("status");
        statusInputs.push(input);
        return { loggedIn: true };
      },
    });

    expect(calls).toEqual([
      "metadata:/synthetic/profiles/work/.claude.json",
      "status",
      "metadata:/synthetic/profiles/work/.claude.json",
    ]);
    expect(statusInputs).toEqual([{
      configDir: "/synthetic/profiles/work",
      configHome: "isolated",
      runtime,
      signal: expect.any(AbortSignal),
    }]);
    expect(projection).toEqual({
      accountId: "account-a",
      email: "account-a@example.test",
      organizationId: "organization-a",
      signedIn: true,
    });
  });

  test("does not project metadata when the current status is signed out", async () => {
    const projection = await readClaudeAccountProjection({
      configDir: "/synthetic/.claude",
      configHome: "personal",
      runtime,
      signal: new AbortController().signal,
      readMetadata: async () => accountMetadata(),
      probeAuthStatus: async () => ({ loggedIn: false }),
    });

    expect(projection).toEqual({ signedIn: false });
  });

  test("rejects an identity swap across the protected status read", async () => {
    let reads = 0;
    const projection = readClaudeAccountProjection({
      configDir: "/synthetic/.claude",
      configHome: "personal",
      runtime,
      signal: new AbortController().signal,
      readMetadata: async () => {
        reads += 1;
        return accountMetadata({ accountUuid: reads === 1 ? "account-a" : "account-b" });
      },
      probeAuthStatus: async () => ({ loggedIn: true }),
    });

    await expect(projection).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
  });

  test("rejects bounded and unsafe metadata before trusting status", async () => {
    for (const accountUuid of ["x".repeat(321), "account\u0000-a"]) {
      let probed = false;
      const projection = readClaudeAccountProjection({
        configDir: "/synthetic/.claude",
        configHome: "personal",
        runtime,
        signal: new AbortController().signal,
        readMetadata: async () => accountMetadata({ accountUuid }),
        probeAuthStatus: async () => {
          probed = true;
          return { loggedIn: true };
        },
      });

      await expect(projection).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
      expect(probed).toBeFalse();
    }
  });

  test("rejects a metadata document that fails its custody mode check", async () => {
    const root = await mkdtemp(join(tmpdir(), "hra-claude-account-"));
    const configDir = join(root, "config");
    const accountPath = claudeAccountDocumentPath(configDir, "isolated");
    try {
      await mkdir(configDir, { recursive: true, mode: 0o700 });
      await writeFile(accountPath, JSON.stringify(accountMetadata()), { mode: 0o644 });
      await chmod(accountPath, 0o644);
      let probed = false;
      const projection = readClaudeAccountProjection({
        configDir,
        configHome: "isolated",
        runtime,
        signal: new AbortController().signal,
        probeAuthStatus: async () => {
          probed = true;
          return { loggedIn: true };
        },
      });

      await expect(projection).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
      expect(probed).toBeFalse();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("refuses a swapped account FIFO without waiting for a writer", async () => {
    if (!fifoTestsSupported()) return;
    const root = await mkdtemp(join(tmpdir(), "hra-claude-account-fifo-"));
    const configDir = join(root, "config");
    const accountPath = claudeAccountDocumentPath(configDir, "isolated");
    try {
      await mkdir(configDir, { recursive: true, mode: 0o700 });
      makeFifo(accountPath);
      let probed = false;
      const projection = readClaudeAccountProjection({
        configDir,
        configHome: "isolated",
        runtime,
        signal: new AbortController().signal,
        probeAuthStatus: async () => {
          probed = true;
          return { loggedIn: true };
        },
      });

      await rejectBeforeFifoWriter(projection, accountPath);
      expect(probed).toBeFalse();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
