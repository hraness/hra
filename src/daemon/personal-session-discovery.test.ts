import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CLAUDE_PIN } from "../claude/pin";
import {
  BoundedPersonalSessionDiscovery,
  CLAUDE_REGISTRY_MAX_FILE_BYTES,
  CLAUDE_REGISTRY_MAX_RECORDS,
  PERSONAL_SESSION_DISCOVERY_RECENCY_WINDOW_MS,
  createClaudeRegistrySource,
  createLocalClaudeProcessLivenessProbe,
  createPersonalClaudeDiscoveryAdapters,
  createPsLocalProcessInspector,
  inferCodexLiveness,
  type ClaudeProcessIdentity,
  type CodexPersonalSessionPageRequest,
  type LocalProcessInspectionResult,
  type ReadonlyCommandProcess,
  type ReadonlyCommandSpawnInput,
  type ReadonlyCommandSpawner,
} from "./personal-session-discovery";

const roots: string[] = [];
const encoder = new TextEncoder();
const SYNTHETIC_PROCESS_START = "Mon Jan  5 12:34:56 2026";

function completeClaudeSnapshot(records: readonly unknown[]): unknown {
  return { records, complete: true };
}

function validClaudeRegistryRecord(sessionId: string, pid: number): Readonly<Record<string, unknown>> {
  return {
    sessionId,
    version: CLAUDE_PIN,
    pid,
    pidDomain: "darwin",
    procStart: `process-start-${pid}`,
  };
}

type ScriptedProcess = Readonly<{
  stdout?: readonly (string | Uint8Array)[];
  stderr?: readonly (string | Uint8Array)[];
  exitCode?: number;
  holdUntilTerminated?: boolean;
}>;

function scriptedSpawner(
  scripts: readonly ScriptedProcess[],
  calls: ReadonlyCommandSpawnInput[],
  effects: { terminated: number; forceTerminated: number; stderrChunks: number },
): ReadonlyCommandSpawner {
  let index = 0;
  return (input): ReadonlyCommandProcess => {
    calls.push(input);
    const script = scripts[index];
    index += 1;
    if (script === undefined) throw new Error("Unexpected process spawn.");
    let resolveExit: ((code: number) => void) | undefined;
    const exited = script.holdUntilTerminated === true
      ? new Promise<number>((resolve) => {
          resolveExit = resolve;
        })
      : Promise.resolve(script.exitCode ?? 0);
    const chunks = async function* (
      values: readonly (string | Uint8Array)[],
      stderr: boolean,
    ): AsyncIterable<Uint8Array> {
      for (const value of values) {
        if (stderr) effects.stderrChunks += 1;
        yield typeof value === "string" ? encoder.encode(value) : value;
      }
      if (script.holdUntilTerminated === true) await exited;
    };
    return {
      exited,
      stdout: chunks(script.stdout ?? [], false),
      stderr: chunks(script.stderr ?? [], true),
      terminate(): void {
        effects.terminated += 1;
        resolveExit?.(143);
      },
      forceTerminate(): void {
        effects.forceTerminated += 1;
        resolveExit?.(137);
      },
    };
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("BoundedPersonalSessionDiscovery", () => {
  test("pages the injected Codex source, normalizes metadata, and infers liveness", async () => {
    const requests: CodexPersonalSessionPageRequest[] = [];
    const discovery = new BoundedPersonalSessionDiscovery({
      now: () => 1_900_000_000_000,
      codexListPage: (request) => {
        requests.push(request);
        if (request.cursor === undefined) {
          return Promise.resolve({
            sessions: [
              {
                providerThreadId: "thread-idle",
                title: "Idle thread",
                status: "idle",
                projectRoot: "/workspace/idle",
                providerUpdatedAt: 1_899_999_500_000,
              },
              {
                providerThreadId: "thread-live",
                title: "Live thread",
                status: "active",
                activeTurnId: "turn-1",
                providerUpdatedAt: 1_899_999_200_000,
              },
            ],
            nextCursor: "page-2",
          });
        }
        return Promise.resolve({
          sessions: [
            {
              providerThreadId: "thread-terminal",
              title: "Terminal thread",
              status: "terminal",
              providerUpdatedAt: 1_899_998_000_000,
            },
          ],
          nextCursor: null,
        });
      },
    });

    await expect(discovery.discover({ provider: "codex", limit: 3 })).resolves.toEqual([
      {
        provider: "codex",
        providerThreadId: "thread-idle",
        title: "Idle thread",
        projectRoot: "/workspace/idle",
        updatedAt: 1_899_999_500_000,
        liveness: "live",
      },
      {
        provider: "codex",
        providerThreadId: "thread-live",
        title: "Live thread",
        updatedAt: 1_899_999_200_000,
        liveness: "live",
      },
    ]);
    expect(requests.map(({ cursor, limit }) => ({ cursor, limit }))).toEqual([
      { cursor: undefined, limit: 3 },
      { cursor: "page-2", limit: 1 },
    ]);
    expect(requests.every((request) => request.signal.aborted)).toBe(true);
  });

  test("bounds Codex pages, stops cursor loops, and never uses ids as title fallbacks", async () => {
    let calls = 0;
    const discovery = new BoundedPersonalSessionDiscovery({
      now: () => Date.parse("2026-01-02T03:04:06.000Z"),
      codexListPage: () => {
        calls += 1;
        return Promise.resolve({
          sessions: [
            {
              providerThreadId: "thread-private-id",
              title: null,
              status: "idle",
              providerUpdatedAt: "2026-01-02T03:04:05.000Z",
            },
          ],
          nextCursor: "same-cursor",
        });
      },
    });

    const candidates = await discovery.discover({ provider: "codex", limit: 500 });
    expect(calls).toBe(2);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.title).toBe("Codex session");
    expect(candidates[0]?.title).not.toContain("thread-private-id");
    expect(candidates[0]?.updatedAt).toBe(Date.parse("2026-01-02T03:04:05.000Z"));
  });

  test("sanitizes titles, omits unsafe roots, and skips malformed Codex rows", async () => {
    const sensitiveLabel = ["to", "ken"].join("");
    const sensitiveValue = ["labelled", "value"].join("-");
    const now = 1_900_000_000_000;
    const discovery = new BoundedPersonalSessionDiscovery({
      now: () => now,
      codexListPage: () => Promise.resolve({
        sessions: [
          {
            providerThreadId: "thread-safe",
            title: `Inspect /private/location ${sensitiveLabel}: ${sensitiveValue}`,
            status: "idle",
            projectRoot: "relative/project",
            providerUpdatedAt: now - 1_000,
          },
          { providerThreadId: "thread-unknown-status", title: "Bad", status: "future" },
          { providerThreadId: "x".repeat(201), title: "Bad", status: "idle" },
        ],
        nextCursor: null,
      }),
    });

    const candidates = await discovery.discover({ provider: "codex" });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).not.toHaveProperty("projectRoot");
    expect(candidates[0]?.title).toContain("[local-path]");
    expect(candidates[0]?.title).toContain("[protected]");
    expect(candidates[0]?.title).not.toContain("private/location");
    expect(candidates[0]?.title).not.toContain(sensitiveValue);
  });

  test("does not admit terminal, stale, or timestamp-less Codex history", async () => {
    const now = 1_900_000_000_000;
    const discovery = new BoundedPersonalSessionDiscovery({
      now: () => now,
      codexListPage: () => Promise.resolve({
        sessions: [
          {
            providerThreadId: "terminal",
            title: "Terminal",
            status: "terminal",
            providerUpdatedAt: now - 1_000,
          },
          {
            providerThreadId: "stale",
            title: "Stale",
            status: "active",
            providerUpdatedAt: now - PERSONAL_SESSION_DISCOVERY_RECENCY_WINDOW_MS - 1,
          },
          { providerThreadId: "missing-time", title: "Missing", status: "active" },
          {
            providerThreadId: "recent",
            title: "Recent",
            status: "idle",
            providerUpdatedAt: now - 1_000,
          },
        ],
        nextCursor: null,
      }),
    });

    expect(await discovery.discover({ provider: "codex" })).toEqual([{
      provider: "codex",
      providerThreadId: "recent",
      title: "Recent",
      updatedAt: now - 1_000,
      liveness: "live",
    }]);
  });

  test("reads a stale Codex heartbeat target exactly without weakening metadata or liveness checks", async () => {
    const now = 1_900_000_000_000;
    const exactReads: string[] = [];
    const discovery = new BoundedPersonalSessionDiscovery({
      now: () => now,
      codexReadSession: ({ providerThreadId }) => {
        exactReads.push(providerThreadId);
        if (providerThreadId === "scheduled-terminal") {
          return Promise.resolve({
            providerThreadId,
            title: "Terminal scheduled thread",
            status: "terminal",
            providerUpdatedAt: now - 86_400_000,
          });
        }
        if (providerThreadId === "scheduled-missing-time") {
          return Promise.resolve({
            providerThreadId,
            title: "Timestamp-less scheduled thread",
            status: "idle",
          });
        }
        return Promise.resolve({
          providerThreadId,
          title: "Old scheduled thread",
          status: "idle",
          projectRoot: "/workspace/scheduled",
          providerUpdatedAt: now - 86_400_000,
        });
      },
      codexListPage: () => Promise.resolve({
        sessions: [{
          providerThreadId: "recent-thread",
          title: "Recent thread",
          status: "idle",
          providerUpdatedAt: now - 1_000,
        }],
        nextCursor: null,
      }),
    });

    await expect(discovery.discover({
      provider: "codex",
      limit: 4,
      codexScheduledThreadIds: [
        "scheduled-old",
        "scheduled-old",
        "scheduled-terminal",
        "scheduled-missing-time",
      ],
    })).resolves.toEqual([
      {
        provider: "codex",
        providerThreadId: "scheduled-old",
        title: "Old scheduled thread",
        projectRoot: "/workspace/scheduled",
        updatedAt: now - 86_400_000,
        liveness: "not_live",
        scheduledTaskTarget: true,
      },
      {
        provider: "codex",
        providerThreadId: "recent-thread",
        title: "Recent thread",
        updatedAt: now - 1_000,
        liveness: "live",
      },
    ]);
    expect(exactReads).toEqual([
      "scheduled-old",
      "scheduled-terminal",
      "scheduled-missing-time",
    ]);
  });

  test("does not let an unavailable exact scheduled-target read suppress recent discovery", async () => {
    const now = 1_900_000_000_000;
    const discovery = new BoundedPersonalSessionDiscovery({
      now: () => now,
      codexReadSession: () => Promise.reject(new Error("metadata unavailable")),
      codexListPage: () => Promise.resolve({
        sessions: [{
          providerThreadId: "recent-after-target-failure",
          title: "Recent after target failure",
          status: "idle",
          providerUpdatedAt: now - 1_000,
        }],
        nextCursor: null,
      }),
    });

    await expect(discovery.discover({
      provider: "codex",
      codexScheduledThreadIds: ["unreadable-scheduled-target"],
    })).resolves.toEqual([{
      provider: "codex",
      providerThreadId: "recent-after-target-failure",
      title: "Recent after target failure",
      updatedAt: now - 1_000,
      liveness: "live",
    }]);
  });

  test("starts every bounded scheduled read while reserving time for recent discovery", async () => {
    const exactReads: string[] = [];
    let recentPageCalls = 0;
    const scheduled = Array.from(
      { length: 50 },
      (_, index) => `slow-scheduled-${String(index).padStart(2, "0")}`,
    );
    const discovery = new BoundedPersonalSessionDiscovery({
      codexReadSession: ({ providerThreadId, signal }) => {
        exactReads.push(providerThreadId);
        return new Promise((_resolve, reject) => {
          const rejectOnAbort = (): void => {
            reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
          };
          signal.addEventListener("abort", rejectOnAbort, { once: true });
        });
      },
      codexListPage: () => {
        recentPageCalls += 1;
        const now = Date.now();
        return Promise.resolve({
          sessions: [{
            providerThreadId: "recent-despite-slow-schedules",
            title: "Recent despite slow schedules",
            status: "idle",
            providerUpdatedAt: now - 1,
          }],
          nextCursor: null,
        });
      },
    });

    const candidates = await discovery.discover({
      provider: "codex",
      codexScheduledThreadIds: scheduled,
      deadlineMs: 120,
      limit: 100,
    });

    expect(exactReads).toEqual(scheduled);
    expect(recentPageCalls).toBe(1);
    expect(candidates).toEqual([{
      provider: "codex",
      providerThreadId: "recent-despite-slow-schedules",
      title: "Recent despite slow schedules",
      updatedAt: expect.any(Number),
      liveness: "live",
    }]);
  });

  test("keeps completed scheduled targets when another exact read hangs", async () => {
    const now = Date.now();
    const discovery = new BoundedPersonalSessionDiscovery({
      codexReadSession: ({ providerThreadId, signal }) => {
        if (providerThreadId === "scheduled-hung") {
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          });
        }
        return Promise.resolve({
          providerThreadId,
          title: `Scheduled ${providerThreadId}`,
          status: "idle",
          providerUpdatedAt: now - 86_400_000,
        });
      },
      codexListPage: () => Promise.resolve({
        sessions: [{
          providerThreadId: "recent-alongside-partial-schedules",
          title: "Recent alongside partial schedules",
          status: "idle",
          providerUpdatedAt: now - 1,
        }],
        nextCursor: null,
      }),
    });

    const candidates = await discovery.discover({
      provider: "codex",
      codexScheduledThreadIds: [
        "scheduled-fast-a",
        "scheduled-hung",
        "scheduled-fast-b",
      ],
      deadlineMs: 120,
      limit: 10,
    });

    expect(candidates.map((candidate) => candidate.providerThreadId)).toEqual([
      "scheduled-fast-a",
      "scheduled-fast-b",
      "recent-alongside-partial-schedules",
    ]);
    expect(candidates.slice(0, 2).every(
      (candidate) => candidate.scheduledTaskTarget === true,
    )).toBe(true);
  });

  test("uses only pinned registry scalars and conservative process liveness", async () => {
    const probed: ClaudeProcessIdentity[] = [];
    const now = 1_900_000_100_000;
    const discovery = new BoundedPersonalSessionDiscovery({
      pinnedClaudeVersion: CLAUDE_PIN,
      now: () => now,
      claudeRegistry: () => Promise.resolve(completeClaudeSnapshot([
        {
          sessionId: "claude-live",
          name: "Registry live",
          cwd: "/workspace/live",
          updatedAt: 1_900_000_000_000,
          version: CLAUDE_PIN,
          pid: 8123,
          pidDomain: "darwin",
          procStart: "live-start",
          messagingSocketPath: "/ignored/socket",
          privateField: "ignored",
        },
        {
          sessionId: "claude-old-version",
          name: "Drifted",
          version: "0.0.0",
          pid: 8124,
          pidDomain: "darwin",
          procStart: 701,
        },
        {
          sessionId: "claude-unknown",
          name: null,
          version: CLAUDE_PIN,
        },
        {
          sessionId: "claude-stale",
          name: "Stale",
          updatedAt: now - PERSONAL_SESSION_DISCOVERY_RECENCY_WINDOW_MS - 1,
          version: CLAUDE_PIN,
          pid: 8125,
          pidDomain: "darwin",
          procStart: 702,
        },
        {
          sessionId: "claude-recent-dead",
          name: "Recent stopped session",
          updatedAt: 1_899_999_950_000,
          version: CLAUDE_PIN,
          pid: 8126,
          pidDomain: "darwin",
          procStart: "dead-start",
        },
      ])),
      claudeProcessLiveness: (identity) => {
        probed.push(identity);
        return Promise.resolve(identity.pid === 8126 ? "not_live" : "live");
      },
    });

    const candidates = await discovery.discover({ provider: "claude", limit: 3 });
    expect(candidates).toEqual([
      {
        provider: "claude",
        providerThreadId: "claude-live",
        title: "Registry live",
        projectRoot: "/workspace/live",
        updatedAt: 1_900_000_000_000,
        liveness: "live",
        admissionEligible: true,
        sourceProcessIdentity: {
          pid: 8123,
          pidDomain: "darwin",
          procStart: "live-start",
        },
      },
      {
        provider: "claude",
        providerThreadId: "claude-recent-dead",
        title: "Recent stopped session",
        updatedAt: 1_899_999_950_000,
        liveness: "not_live",
        admissionEligible: true,
        sourceProcessIdentity: {
          pid: 8126,
          pidDomain: "darwin",
          procStart: "dead-start",
        },
      },
      {
        provider: "claude",
        providerThreadId: "claude-stale",
        title: "Stale",
        updatedAt: now - PERSONAL_SESSION_DISCOVERY_RECENCY_WINDOW_MS - 1,
        liveness: "live",
        sourceProcessIdentity: null,
        admissionEligible: false,
      },
    ]);
    expect(probed).toEqual([
      { pid: 8123, pidDomain: "darwin", procStart: "live-start" },
      { pid: 8124, pidDomain: "darwin", procStart: 701 },
      { pid: 8125, pidDomain: "darwin", procStart: 702 },
      { pid: 8126, pidDomain: "darwin", procStart: "dead-start" },
    ]);
    expect(JSON.stringify(candidates)).not.toContain("messagingSocketPath");
    expect(JSON.stringify(candidates)).not.toContain("privateField");
  });

  test("merges duplicate registry rows conservatively", async () => {
    const now = 1_900_000_000_000;
    const discovery = new BoundedPersonalSessionDiscovery({
      pinnedClaudeVersion: CLAUDE_PIN,
      now: () => now,
      claudeRegistry: () => Promise.resolve(completeClaudeSnapshot([
        {
          sessionId: "same",
          name: "First registry title",
          cwd: "/workspace/first",
          updatedAt: now - 2_000,
          version: CLAUDE_PIN,
          pid: 9000,
          pidDomain: "darwin",
          procStart: "first-start",
        },
        {
          sessionId: "same",
          name: "Conflicting registry title",
          cwd: "/workspace/second",
          updatedAt: now - 1_000,
          version: CLAUDE_PIN,
          pid: 9001,
          pidDomain: "darwin",
          procStart: "second-start",
        },
      ])),
      claudeProcessLiveness: (identity) => Promise.resolve(
        identity.pid === 9000 ? "not_live" : "unknown",
      ),
    });

    expect(await discovery.discover({ provider: "claude", limit: 1 })).toEqual([
      {
        provider: "claude",
        providerThreadId: "same",
        title: "First registry title",
        updatedAt: now - 1_000,
        liveness: "unknown",
        admissionEligible: true,
        sourceProcessIdentity: null,
      },
    ]);
  });

  test("retains only one exact durable identity across duplicate Claude rows", async () => {
    const now = 1_900_000_000_000;
    const common = {
      sessionId: "same",
      name: "Same process",
      updatedAt: now - 1_000,
      version: CLAUDE_PIN,
      pid: 9000,
      pidDomain: "linux",
      procStart: "Mon Jan  5 12:34:56 2026",
    } as const;
    const discovery = new BoundedPersonalSessionDiscovery({
      pinnedClaudeVersion: CLAUDE_PIN,
      now: () => now,
      claudeRegistry: () => Promise.resolve(completeClaudeSnapshot([
        { ...common, cwd: "/workspace/same" },
        { ...common, cwd: "/workspace/same" },
      ])),
      claudeProcessLiveness: () => Promise.resolve("live"),
    });

    expect(await discovery.discover({ provider: "claude", limit: 1 })).toEqual([{
      provider: "claude",
      providerThreadId: "same",
      title: "Same process",
      projectRoot: "/workspace/same",
      updatedAt: now - 1_000,
      liveness: "live",
      admissionEligible: true,
      sourceProcessIdentity: {
        pid: 9000,
        pidDomain: "linux",
        procStart: "Mon Jan  5 12:34:56 2026",
      },
    }]);
  });

  test("clears a durable identity when any duplicate Claude row is unusable", async () => {
    const now = 1_900_000_000_000;
    const discovery = new BoundedPersonalSessionDiscovery({
      pinnedClaudeVersion: CLAUDE_PIN,
      now: () => now,
      claudeRegistry: () => Promise.resolve(completeClaudeSnapshot([
        {
          sessionId: "same",
          name: "Exact process",
          updatedAt: now - 2_000,
          version: CLAUDE_PIN,
          pid: 9000,
          pidDomain: "darwin",
          procStart: "Mon Jan  5 12:34:56 2026",
        },
        {
          sessionId: "same",
          name: "Incomplete process",
          updatedAt: now - 1_000,
          version: CLAUDE_PIN,
          pid: 9000,
          pidDomain: "darwin",
        },
      ])),
      claudeProcessLiveness: () => Promise.resolve("not_live"),
    });

    expect(await discovery.discover({ provider: "claude", limit: 1 })).toEqual([{
      provider: "claude",
      providerThreadId: "same",
      title: "Exact process",
      updatedAt: now - 1_000,
      liveness: "unknown",
      admissionEligible: true,
      sourceProcessIdentity: null,
    }]);
  });

  test("does not retain a non-ASCII process start as storage authority", async () => {
    const now = 1_900_000_000_000;
    const discovery = new BoundedPersonalSessionDiscovery({
      pinnedClaudeVersion: CLAUDE_PIN,
      now: () => now,
      claudeRegistry: () => Promise.resolve(completeClaudeSnapshot([{
        sessionId: "non-ascii-process-start",
        name: "Non-ASCII process start",
        updatedAt: now - 1_000,
        version: CLAUDE_PIN,
        pid: 9002,
        pidDomain: "darwin",
        procStart: "Mon Jan  5 12:34:56 2026é",
      }])),
      claudeProcessLiveness: () => Promise.resolve("unknown"),
    });

    expect(await discovery.discover({ provider: "claude", limit: 1 })).toEqual([{
      provider: "claude",
      providerThreadId: "non-ascii-process-start",
      title: "Non-ASCII process start",
      updatedAt: now - 1_000,
      liveness: "unknown",
      admissionEligible: true,
      sourceProcessIdentity: null,
    }]);
  });

  test("inspects a live duplicate beyond the former result-derived scan bound", async () => {
    const now = 1_900_000_000_000;
    const records = [
      {
        sessionId: "same",
        name: "Initially stopped",
        updatedAt: now - 2_000,
        version: CLAUDE_PIN,
        pid: 10_001,
        pidDomain: "darwin",
        procStart: "first-start",
      },
      ...Array.from({ length: 120 }, (_, index) => ({
        sessionId: `irrelevant-${index}`,
        version: "0.0.0",
      })),
      {
        sessionId: "same",
        name: "Still live",
        updatedAt: now - 1_000,
        version: CLAUDE_PIN,
        pid: 10_002,
        pidDomain: "darwin",
        procStart: "second-start",
      },
    ];
    const discovery = new BoundedPersonalSessionDiscovery({
      pinnedClaudeVersion: CLAUDE_PIN,
      now: () => now,
      claudeRegistry: () => Promise.resolve(completeClaudeSnapshot(records)),
      claudeProcessLiveness: (identity) => Promise.resolve(
        identity.pid === 10_002 ? "live" : "not_live",
      ),
    });

    expect(await discovery.discover({ provider: "claude", limit: 1 })).toEqual([{
      provider: "claude",
      providerThreadId: "same",
      title: "Initially stopped",
      updatedAt: now - 1_000,
      liveness: "live",
      admissionEligible: true,
      sourceProcessIdentity: null,
    }]);
  });

  test("mismatched or missing versions poison a recent stopped duplicate", async () => {
    const now = 1_900_000_000_000;
    const discovery = new BoundedPersonalSessionDiscovery({
      pinnedClaudeVersion: CLAUDE_PIN,
      now: () => now,
      claudeRegistry: () => Promise.resolve(completeClaudeSnapshot([
        {
          sessionId: "mismatched-live",
          name: "Mismatched live",
          updatedAt: now - 1_000,
          version: CLAUDE_PIN,
          pid: 11_001,
          pidDomain: "darwin",
          procStart: "matching-dead",
        },
        {
          sessionId: "mismatched-live",
          updatedAt: now - 500,
          version: "0.0.0",
          pid: 11_002,
          pidDomain: "darwin",
          procStart: "mismatched-live",
        },
        {
          sessionId: "missing-unknown",
          name: "Missing unknown",
          updatedAt: now - 1_000,
          version: CLAUDE_PIN,
          pid: 12_001,
          pidDomain: "darwin",
          procStart: "matching-dead",
        },
        {
          sessionId: "missing-unknown",
          updatedAt: now - 500,
          pid: 12_002,
          pidDomain: "darwin",
          procStart: "missing-unknown",
        },
      ])),
      claudeProcessLiveness: (identity) => Promise.resolve(
        identity.pid === 11_002
          ? "live"
          : identity.pid === 12_002
            ? "unknown"
            : "not_live",
      ),
    });

    expect(await discovery.discover({ provider: "claude", limit: 2 })).toEqual([
      {
        provider: "claude",
        providerThreadId: "mismatched-live",
        title: "Mismatched live",
        updatedAt: now - 1_000,
        liveness: "live",
        admissionEligible: true,
        sourceProcessIdentity: null,
      },
      {
        provider: "claude",
        providerThreadId: "missing-unknown",
        title: "Missing unknown",
        updatedAt: now - 1_000,
        liveness: "unknown",
        admissionEligible: true,
        sourceProcessIdentity: null,
      },
    ]);
  });

  test("a stale live row poisons a recent stopped duplicate", async () => {
    const now = 1_900_000_000_000;
    const discovery = new BoundedPersonalSessionDiscovery({
      pinnedClaudeVersion: CLAUDE_PIN,
      now: () => now,
      claudeRegistry: () => Promise.resolve(completeClaudeSnapshot([
        {
          sessionId: "same",
          name: "Recent stopped",
          updatedAt: now - 1_000,
          version: CLAUDE_PIN,
          pid: 13_001,
          pidDomain: "darwin",
          procStart: "recent-dead",
        },
        {
          sessionId: "same",
          name: "Stale live",
          updatedAt: now - PERSONAL_SESSION_DISCOVERY_RECENCY_WINDOW_MS - 1,
          version: CLAUDE_PIN,
          pid: 13_002,
          pidDomain: "darwin",
          procStart: "stale-live",
        },
      ])),
      claudeProcessLiveness: (identity) => Promise.resolve(
        identity.pid === 13_002 ? "live" : "not_live",
      ),
    });

    expect(await discovery.discover({ provider: "claude", limit: 1 })).toEqual([{
      provider: "claude",
      providerThreadId: "same",
      title: "Recent stopped",
      updatedAt: now - 1_000,
      liveness: "live",
      admissionEligible: true,
      sourceProcessIdentity: null,
    }]);
  });

  test("emits ineligible blocker rows for wrong-pin and stale live session ids", async () => {
    const now = 1_900_000_000_000;
    const discovery = new BoundedPersonalSessionDiscovery({
      pinnedClaudeVersion: CLAUDE_PIN,
      now: () => now,
      claudeRegistry: () => Promise.resolve(completeClaudeSnapshot([
        {
          sessionId: "wrong-pin-retained-id",
          name: "Wrong pin blocker",
          updatedAt: now - 500,
          version: "0.0.0",
          pid: 13_101,
          pidDomain: "darwin",
          procStart: "wrong-pin-live",
        },
        {
          sessionId: "stale-retained-id",
          name: "Stale blocker",
          updatedAt: now - PERSONAL_SESSION_DISCOVERY_RECENCY_WINDOW_MS - 1,
          version: CLAUDE_PIN,
          pid: 13_102,
          pidDomain: "darwin",
          procStart: "stale-live",
        },
      ])),
      claudeProcessLiveness: () => Promise.resolve("live"),
    });

    expect(await discovery.discover({ provider: "claude", limit: 2 })).toEqual([
      {
        provider: "claude",
        providerThreadId: "wrong-pin-retained-id",
        title: "Wrong pin blocker",
        updatedAt: now - 500,
        liveness: "live",
        sourceProcessIdentity: null,
        admissionEligible: false,
      },
      {
        provider: "claude",
        providerThreadId: "stale-retained-id",
        title: "Stale blocker",
        updatedAt: now - PERSONAL_SESSION_DISCOVERY_RECENCY_WINDOW_MS - 1,
        liveness: "live",
        sourceProcessIdentity: null,
        admissionEligible: false,
      },
    ]);
  });

  test("rejects a claimed-complete snapshot that exceeds the global record cap", async () => {
    const now = 1_900_000_000_000;
    const records = [
      {
        sessionId: "same",
        name: "Stopped",
        updatedAt: now - 1_000,
        version: CLAUDE_PIN,
        pid: 14_001,
        pidDomain: "darwin",
        procStart: "recent-dead",
      },
      ...Array.from({ length: CLAUDE_REGISTRY_MAX_RECORDS }, (_, index) => ({
        sessionId: `overflow-${index}`,
        version: "0.0.0",
      })),
    ];
    const discovery = new BoundedPersonalSessionDiscovery({
      pinnedClaudeVersion: CLAUDE_PIN,
      now: () => now,
      claudeRegistry: () => Promise.resolve({ records, complete: true }),
      claudeProcessLiveness: () => Promise.resolve("not_live"),
    });

    await expect(discovery.discover({ provider: "claude", limit: 1 }))
      .rejects.toThrow("snapshot is incomplete");
  });

  test("rejects legacy bare arrays because they cannot prove a complete scan", async () => {
    const now = 1_900_000_000_000;
    const discovery = new BoundedPersonalSessionDiscovery({
      pinnedClaudeVersion: CLAUDE_PIN,
      now: () => now,
      claudeRegistry: () => Promise.resolve([{
        sessionId: "unproven",
        name: "Unproven stopped process",
        updatedAt: now - 1_000,
        version: CLAUDE_PIN,
        pid: 15_001,
        pidDomain: "darwin",
        procStart: "unproven-dead",
      }]),
      claudeProcessLiveness: () => Promise.resolve("not_live"),
    });

    await expect(discovery.discover({ provider: "claude", limit: 1 }))
      .rejects.toThrow("snapshot is incomplete");
  });

  test("rejects malformed records even when an injected source claims completeness", async () => {
    const discovery = new BoundedPersonalSessionDiscovery({
      pinnedClaudeVersion: CLAUDE_PIN,
      claudeRegistry: () => Promise.resolve(completeClaudeSnapshot([{}])),
    });

    await expect(discovery.discover({ provider: "claude", limit: 1 }))
      .rejects.toThrow("contains an invalid record");
  });

  test("returns partial results when a later Codex page fails", async () => {
    const now = 1_900_000_000_000;
    const discovery = new BoundedPersonalSessionDiscovery({
      now: () => now,
      codexListPage: ({ cursor }) => cursor === undefined
        ? Promise.resolve({
            sessions: [{
              providerThreadId: "first",
              title: "First",
              status: "idle",
              providerUpdatedAt: now - 1_000,
            }],
            nextCursor: "next",
          })
        : Promise.reject(new Error("page unavailable")),
    });
    await expect(discovery.discover({ provider: "codex" })).resolves.toEqual([
      {
        provider: "codex",
        providerThreadId: "first",
        title: "First",
        updatedAt: now - 1_000,
        liveness: "live",
      },
    ]);
  });

  test("links a caller abort signal into an in-flight provider read", async () => {
    let providerSignal: AbortSignal | undefined;
    const discovery = new BoundedPersonalSessionDiscovery({
      codexListPage: (input) => {
        providerSignal = input.signal;
        return new Promise<never>(() => undefined);
      },
    });
    const controller = new AbortController();
    const pending = discovery.discover({
      provider: "codex",
      deadlineMs: 2_000,
      signal: controller.signal,
    });
    for (let attempt = 0; attempt < 20 && providerSignal === undefined; attempt += 1) {
      await Bun.sleep(1);
    }
    controller.abort(new Error("cancel discovery"));

    await expect(pending).rejects.toThrow("cancel discovery");
    expect(providerSignal?.aborted).toBe(true);
  });
});

describe("createClaudeRegistrySource", () => {
  test("reads only bounded pid JSON files and projects a scalar allowlist", async () => {
    const root = await mkdtemp(join(tmpdir(), "hra-session-registry-"));
    roots.push(root);
    await writeFile(join(root, "8123.json"), JSON.stringify({
      sessionId: "session-one",
      name: "One",
      cwd: "/workspace/one",
      updatedAt: 1_900_000_000_000,
      statusUpdatedAt: "2026-01-01T00:00:00Z",
      version: CLAUDE_PIN,
      pid: 8123,
      pidDomain: "darwin",
      procStart: 700,
      messagingSocketPath: "/ignored/socket",
      peerFeatures: ["ignored"],
    }));
    await writeFile(join(root, "8123.abcd.key"), "ignored");
    await writeFile(join(root, "broken.json"), "not a pid record");
    const source = createClaudeRegistrySource(root, () => 1_000);
    const snapshot = await source({
      deadlineAt: 2_000,
      maxFiles: 10,
      maxFileBytes: CLAUDE_REGISTRY_MAX_FILE_BYTES,
      signal: new AbortController().signal,
    });
    expect(snapshot).toEqual({
      records: [{
        sessionId: "session-one",
        name: "One",
        cwd: "/workspace/one",
        updatedAt: 1_900_000_000_000,
        statusUpdatedAt: "2026-01-01T00:00:00Z",
        version: CLAUDE_PIN,
        pid: 8123,
        pidDomain: "darwin",
        procStart: 700,
      }],
      complete: true,
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("messagingSocketPath");
    expect(serialized).not.toContain("peerFeatures");
    expect(serialized).not.toContain("ignored/socket");
  });

  test("rejects a registry record whose filename PID does not match its process authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "hra-session-registry-pid-mismatch-"));
    roots.push(root);
    const now = 1_900_000_000_000;
    await writeFile(join(root, "123.json"), JSON.stringify({
      ...validClaudeRegistryRecord("mismatched-pid", 456),
      updatedAt: now - 1_000,
    }));
    const source = createClaudeRegistrySource(root, () => now);
    const snapshot = await source({
      deadlineAt: now + 2_000,
      maxFiles: CLAUDE_REGISTRY_MAX_RECORDS,
      maxFileBytes: CLAUDE_REGISTRY_MAX_FILE_BYTES,
      signal: new AbortController().signal,
    });
    expect(snapshot).toEqual({ records: [], complete: false });

    const inspectedPids: number[] = [];
    const discovery = new BoundedPersonalSessionDiscovery({
      pinnedClaudeVersion: CLAUDE_PIN,
      now: () => now,
      claudeRegistry: source,
      claudeProcessLiveness: createLocalClaudeProcessLivenessProbe({
        currentPidDomain: "darwin",
        now: () => now,
        inspectProcess: (identity) => {
          inspectedPids.push(identity.pid);
          return Promise.resolve({ status: "not_found" });
        },
      }),
    });
    await expect(discovery.discover({ provider: "claude" }))
      .rejects.toThrow("The Claude registry snapshot is incomplete.");
    expect(inspectedPids).toEqual([]);
  });

  test("rejects ambiguous and non-safe decimal PID filenames", async () => {
    for (const [filename, pid] of [
      ["001.json", 1],
      ["9007199254740992.json", 1],
    ] as const) {
      const root = await mkdtemp(join(tmpdir(), "hra-session-registry-invalid-pid-name-"));
      roots.push(root);
      await writeFile(join(root, filename), JSON.stringify(validClaudeRegistryRecord(filename, pid)));
      const source = createClaudeRegistrySource(root, () => 1_000);
      await expect(source({
        deadlineAt: 2_000,
        maxFiles: CLAUDE_REGISTRY_MAX_RECORDS,
        maxFileBytes: CLAUDE_REGISTRY_MAX_FILE_BYTES,
        signal: new AbortController().signal,
      })).resolves.toEqual({ records: [], complete: false });
    }
  });

  test("honors file-count, byte, abort, and deadline bounds", async () => {
    const root = await mkdtemp(join(tmpdir(), "hra-session-registry-bounds-"));
    roots.push(root);
    await writeFile(join(root, "1.json"), JSON.stringify(validClaudeRegistryRecord("one", 1)));
    await writeFile(join(root, "2.json"), JSON.stringify(validClaudeRegistryRecord("two", 2)));
    const source = createClaudeRegistrySource(root, () => 1_000);
    const controller = new AbortController();

    const bounded = await source({
      deadlineAt: 2_000,
      maxFiles: 1,
      maxFileBytes: CLAUDE_REGISTRY_MAX_FILE_BYTES,
      signal: controller.signal,
    });
    expect(bounded).toMatchObject({ complete: false });
    expect((bounded as { records: unknown[] }).records).toHaveLength(1);

    controller.abort();
    await expect(source({
      deadlineAt: 2_000,
      maxFiles: 10,
      maxFileBytes: CLAUDE_REGISTRY_MAX_FILE_BYTES,
      signal: controller.signal,
    })).resolves.toEqual({ records: [], complete: false });
    await expect(source({
      deadlineAt: 1_000,
      maxFiles: 10,
      maxFileBytes: CLAUDE_REGISTRY_MAX_FILE_BYTES,
      signal: new AbortController().signal,
    })).resolves.toEqual({ records: [], complete: false });
  });

  test("marks malformed pid records incomplete instead of asserting EOF proof", async () => {
    const root = await mkdtemp(join(tmpdir(), "hra-session-registry-malformed-"));
    roots.push(root);
    await writeFile(join(root, "1.json"), JSON.stringify(validClaudeRegistryRecord("one", 1)));
    await writeFile(join(root, "2.json"), "{malformed");
    await mkdir(join(root, "3.json"));
    await symlink(join(root, "1.json"), join(root, "4.json"));
    const source = createClaudeRegistrySource(root, () => 1_000);

    await expect(source({
      deadlineAt: 2_000,
      maxFiles: CLAUDE_REGISTRY_MAX_RECORDS,
      maxFileBytes: CLAUDE_REGISTRY_MAX_FILE_BYTES,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ complete: false });
  });

  test("marks pid records with missing authority fields incomplete", async () => {
    const root = await mkdtemp(join(tmpdir(), "hra-session-registry-incomplete-record-"));
    roots.push(root);
    await writeFile(join(root, "1.json"), JSON.stringify({ sessionId: "missing-authority" }));
    const source = createClaudeRegistrySource(root, () => 1_000);

    await expect(source({
      deadlineAt: 2_000,
      maxFiles: CLAUDE_REGISTRY_MAX_RECORDS,
      maxFileBytes: CLAUDE_REGISTRY_MAX_FILE_BYTES,
      signal: new AbortController().signal,
    })).resolves.toEqual({ records: [], complete: false });
  });

  test("reads at most 200 pid records and detects registry overflow", async () => {
    const root = await mkdtemp(join(tmpdir(), "hra-session-registry-overflow-"));
    roots.push(root);
    await Promise.all(Array.from({ length: CLAUDE_REGISTRY_MAX_RECORDS + 1 }, async (_, index) => {
      await writeFile(
        join(root, `${index + 1}.json`),
        JSON.stringify(validClaudeRegistryRecord(`s-${index}`, index + 1)),
      );
    }));
    const source = createClaudeRegistrySource(root, () => 1_000);
    const snapshot = await source({
      deadlineAt: 2_000,
      maxFiles: CLAUDE_REGISTRY_MAX_RECORDS,
      maxFileBytes: CLAUDE_REGISTRY_MAX_FILE_BYTES,
      signal: new AbortController().signal,
    });

    expect(snapshot).toMatchObject({ complete: false });
    expect((snapshot as { records: unknown[] }).records).toHaveLength(CLAUDE_REGISTRY_MAX_RECORDS);
  });
});

describe("inferCodexLiveness", () => {
  test("uses active turns and recent updates, then admits a bounded quiet idle thread", () => {
    expect(inferCodexLiveness({ status: "active", now: 20_000 })).toBe("live");
    expect(inferCodexLiveness({ status: "idle", activeTurnId: "turn", now: 20_000 })).toBe("live");
    expect(inferCodexLiveness({ status: "idle", updatedAt: 19_000, now: 20_000 })).toBe("live");
    expect(inferCodexLiveness({ status: "idle", updatedAt: 0, now: 1_000_000 })).toBe("not_live");
    expect(inferCodexLiveness({ status: "idle", now: 1_000_000 })).toBe("unknown");
    expect(inferCodexLiveness({ status: "idle", updatedAt: 2_000_000, now: 1_000_000 })).toBe("unknown");
    expect(inferCodexLiveness({ status: "terminal", updatedAt: 20_000, now: 20_000 })).toBe("not_live");
  });
});

describe("createLocalClaudeProcessLivenessProbe", () => {
  const identity: ClaudeProcessIdentity = {
    pid: 8123,
    pidDomain: "darwin",
    procStart: SYNTHETIC_PROCESS_START,
  };

  test("distinguishes matching and mismatched start tokens, missing, inaccessible, and unsupported", async () => {
    const input = { deadlineAt: Date.now() + 2_000, signal: new AbortController().signal };
    const withInspection = (result: LocalProcessInspectionResult) =>
      createLocalClaudeProcessLivenessProbe({
        currentPidDomain: "darwin",
        inspectProcess: () => Promise.resolve(result),
      });

    await expect(withInspection({ status: "found", procStart: identity.procStart })(identity, input))
      .resolves.toBe("live");
    await expect(withInspection({ status: "found", procStart: "different process start" })(identity, input))
      .resolves.toBe("not_live");
    await expect(withInspection({ status: "not_found" })(identity, input)).resolves.toBe("not_live");
    await expect(withInspection({ status: "unknown" })(identity, input)).resolves.toBe("unknown");
    await expect(createLocalClaudeProcessLivenessProbe({
      currentPidDomain: "linux",
      inspectProcess: () => Promise.resolve({ status: "found", procStart: identity.procStart }),
    })(identity, input)).resolves.toBe("unknown");
  });

  test("default ps inspection is non-shell and compares the captured process-start token", async () => {
    const calls: ReadonlyCommandSpawnInput[] = [];
    const effects = { terminated: 0, forceTerminated: 0, stderrChunks: 0 };
    const probe = createLocalClaudeProcessLivenessProbe({
      currentPidDomain: "darwin",
      pidExists: () => "exists",
      spawn: scriptedSpawner([
        { stdout: [` ${identity.procStart} \n`], stderr: ["ignored"] },
      ], calls, effects),
    });

    await expect(probe(identity, {
      deadlineAt: Date.now() + 2_000,
      signal: new AbortController().signal,
    })).resolves.toBe("live");
    expect(calls.map((call) => call.argv)).toEqual([
      ["/bin/ps", "-p", "8123", "-o", "lstart="],
    ]);
    expect(calls[0]?.environment).toEqual({
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
      TZ: "UTC",
    });
    expect(effects.stderrChunks).toBe(1);
  });

  test("default inspection maps a mismatched start token to not live and inaccessible lookup to unknown", async () => {
    const reusedCalls: ReadonlyCommandSpawnInput[] = [];
    const reusedEffects = { terminated: 0, forceTerminated: 0, stderrChunks: 0 };
    const reused = createLocalClaudeProcessLivenessProbe({
      currentPidDomain: "darwin",
      pidExists: () => "exists",
      spawn: scriptedSpawner([{ stdout: ["Mon Jan  5 12:34:57 2026\n"] }], reusedCalls, reusedEffects),
    });
    await expect(reused(identity, {
      deadlineAt: Date.now() + 2_000,
      signal: new AbortController().signal,
    })).resolves.toBe("not_live");

    let spawned = false;
    const inaccessible = createLocalClaudeProcessLivenessProbe({
      currentPidDomain: "darwin",
      pidExists: () => "inaccessible",
      spawn: () => {
        spawned = true;
        throw new Error("must not spawn");
      },
    });
    await expect(inaccessible(identity, {
      deadlineAt: Date.now() + 2_000,
      signal: new AbortController().signal,
    })).resolves.toBe("unknown");
    expect(spawned).toBe(false);
  });

  test("rechecks a failed ps lookup so an exited process becomes not live", async () => {
    let existenceCalls = 0;
    const calls: ReadonlyCommandSpawnInput[] = [];
    const effects = { terminated: 0, forceTerminated: 0, stderrChunks: 0 };
    const inspector = createPsLocalProcessInspector({
      currentPidDomain: "darwin",
      pidExists: () => {
        existenceCalls += 1;
        return existenceCalls === 1 ? "exists" : "not_found";
      },
      spawn: scriptedSpawner([{ exitCode: 1 }], calls, effects),
    });
    await expect(inspector(identity, {
      deadlineAt: Date.now() + 2_000,
      signal: new AbortController().signal,
    })).resolves.toEqual({ status: "not_found" });
  });

  test("force-terminates a bounded ps probe when exit settlement rejects", async () => {
    let terminated = 0;
    let forceTerminated = 0;
    const exited = Promise.reject(new Error("exit settlement unavailable"));
    void exited.catch(() => undefined);
    const empty = async function* (): AsyncIterable<Uint8Array> {};
    const inspector = createPsLocalProcessInspector({
      currentPidDomain: "darwin",
      pidExists: () => "exists",
      spawn: () => ({
        exited,
        stdout: empty(),
        stderr: empty(),
        terminate(): void {
          terminated += 1;
        },
        forceTerminate(): void {
          forceTerminated += 1;
        },
      }),
    });

    await expect(inspector(identity, {
      deadlineAt: Date.now() + 2_000,
      signal: new AbortController().signal,
    })).resolves.toEqual({ status: "unknown" });
    expect(terminated).toBe(1);
    expect(forceTerminated).toBe(1);
  });
});

describe("createPersonalClaudeDiscoveryAdapters", () => {
  test("binds the registry under the supplied personal config directory", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "hra-personal-claude-adapters-"));
    roots.push(configDir);
    await mkdir(join(configDir, "sessions"));
    await writeFile(join(configDir, "sessions", "8123.json"), JSON.stringify({
      sessionId: "session-one",
      version: CLAUDE_PIN,
      pid: 8123,
      pidDomain: "darwin",
      procStart: SYNTHETIC_PROCESS_START,
    }));
    const adapters = createPersonalClaudeDiscoveryAdapters({
      configDir,
      pinnedVersion: CLAUDE_PIN,
      currentPidDomain: "darwin",
      inspectProcess: () => Promise.resolve({ status: "not_found" }),
    });

    expect(adapters.pinnedClaudeVersion).toBe(CLAUDE_PIN);
    const snapshot = await adapters.claudeRegistry({
      deadlineAt: Date.now() + 2_000,
      maxFiles: 10,
      maxFileBytes: CLAUDE_REGISTRY_MAX_FILE_BYTES,
      signal: new AbortController().signal,
    });
    expect(snapshot).toEqual({
      records: [{
        sessionId: "session-one",
        version: CLAUDE_PIN,
        pid: 8123,
        pidDomain: "darwin",
        procStart: SYNTHETIC_PROCESS_START,
      }],
      complete: true,
    });
  });
});
