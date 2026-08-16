import { describe, expect, test } from "bun:test";
import {
  AGENT_SESSION_HEARTBEAT_MS,
  AGENT_SESSION_IDLE_MS,
  CLAIM_RENEWAL_THRESHOLD_MS,
  DEFAULT_CLAIM_LEASE_MS,
  createBearerSecret,
  createLocator,
  formatEnrollmentToken,
  uuidV7Schema,
  type EnrollmentToken,
  type SessionId,
} from "@hraness/agent-tasks-protocol";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  activeCredentialRecord,
  credentialMetadataFile,
  generateCredentialToken,
  readStoredCredential,
  writeProfile,
  writeStoredCredential,
  type AgentSecretStore,
  type RandomSource,
  type StoragePaths,
  type TaskctlEnvironment,
} from "./config";
import { runCli } from "./index";
import type { CliIo } from "./output";

const SESSION_ID: SessionId = "ses_00000000000000000000000000";
const REQUEST_ID = "req_00000000000000000000000000";
const SERVER_NOW = 1_720_000_000_123;

const deterministicRandom: RandomSource = (length) =>
  Uint8Array.from({ length }, (_, index) => (length + index * 17) % 256);

function memoryAgentKeychain(): AgentSecretStore {
  const values = new Map<string, string>();
  return {
    get: (input) => Promise.resolve(values.get(`${input.service}:${input.name}`) ?? null),
    set: (input) => {
      values.set(`${input.service}:${input.name}`, input.value);
      return Promise.resolve();
    },
    delete: (input) => Promise.resolve(values.delete(`${input.service}:${input.name}`)),
  };
}

function enrollmentToken(): EnrollmentToken {
  return formatEnrollmentToken(
    createLocator(Uint8Array.from({ length: 26 }, (_, index) => index + 40)),
    createBearerSecret(Uint8Array.from({ length: 32 }, (_, index) => index + 80)),
  );
}

function inputUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}

function captureIo(stdin = "", stdinIsTTY = false): {
  readonly io: CliIo;
  readonly stdout: string[];
  readonly stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      readStdin: () => Promise.resolve(stdin),
      stdinIsTTY,
    },
  };
}

async function temporaryPaths(): Promise<{ readonly directory: string; readonly paths: StoragePaths }> {
  const directory = await mkdtemp(join(tmpdir(), "taskctl-index-test-"));
  return {
    directory,
    paths: {
      credentialFile: join(directory, "credentials.json"),
      profileFile: join(directory, "profile.json"),
    },
  };
}

const openTask = {
  id: "tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  key: "OPS-7K2M4Q9",
  title: "Prove the claim race",
  type: "task",
  priority: 2,
  status: "open",
  availableAt: 0,
  isReady: true,
  unresolvedBlockerCount: 0,
  cancelledBlockerCount: 0,
  revision: 1,
  reviewRevision: 1,
  createdAt: 1,
  updatedAt: 1,
} as const;

const currentClaim = {
  id: "claim-1",
  agentId: "agent-1",
  fence: 1,
  leaseGeneration: 1,
  leaseUntil: SERVER_NOW + DEFAULT_CLAIM_LEASE_MS,
} as const;

const inProgressTask = {
  ...openTask,
  status: "in_progress",
  isReady: false,
  revision: 2,
  currentClaim,
} as const;

const contextData = {
  principal: {
    kind: "agent",
    agentId: "agent-1",
    name: "builder",
    scopes: ["tasks:read", "tasks:create", "tasks:claim"],
    sessionId: SESSION_ID,
  },
  organization: { id: "organization-1", name: "Hraness" },
  workspace: { id: "workspace-1", slug: "core", name: "Core" },
  serverTime: SERVER_NOW,
  defaults: {
    claimLeaseMs: DEFAULT_CLAIM_LEASE_MS,
    claimRenewalThresholdMs: CLAIM_RENEWAL_THRESHOLD_MS,
    sessionIdleMs: AGENT_SESSION_IDLE_MS,
    sessionHeartbeatMs: AGENT_SESSION_HEARTBEAT_MS,
  },
  counts: { readyTasks: 1, activeClaims: 0, reviewRequests: 0 },
  readyTasks: [openTask],
  activeClaims: [],
  reviewRequests: [],
  cursors: { readyTasks: null, activeClaims: null, reviewRequests: null },
  workflowRules: ["Claim ready work before editing it."],
} as const;

describe("auth commands", () => {
  test("enrolls from environment without printing or profiling either secret", async () => {
    const { directory, paths } = await temporaryPaths();
    const enrollment = enrollmentToken();
    const captured = captureIo("", true);
    const keychain = memoryAgentKeychain();
    const requests: {
      readonly url: string;
      readonly authorization: string | null;
      readonly idempotencyKey: string | null;
    }[] = [];
    const fetchMock = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = inputUrl(input);
      const headers = new Headers(init?.headers);
      requests.push({
        url,
        authorization: headers.get("Authorization"),
        idempotencyKey: headers.get("Idempotency-Key"),
      });
      if (new URL(url).pathname === "/v1/agent/enrollments/redeem") {
        return Promise.resolve(Response.json({
          ok: true,
          data: {
            agentId: "agent-1",
            credentialId: "credential-1",
            credentialExpiresAt: 1_800_000_000_000,
            scopes: ["tasks:read", "tasks:create", "tasks:claim"],
          },
          requestId: REQUEST_ID,
        }));
      }
      return Promise.resolve(Response.json({
        ok: true,
        data: { sessionId: SESSION_ID, expiresAt: SERVER_NOW + AGENT_SESSION_IDLE_MS },
        requestId: REQUEST_ID,
      }));
    };
    const environment: TaskctlEnvironment = {
      TASKCTL_API_URL: "http://127.0.0.1:3211",
      TASKCTL_ENROLLMENT_TOKEN: enrollment,
    };

    try {
      const exitCode = await runCli(["auth", "enroll", "--json"], {
        environment,
        fetch: fetchMock,
        io: captured.io,
        now: () => SERVER_NOW,
        random: deterministicRandom,
        storagePaths: paths,
        agentSecretStore: keychain,
      });
      expect(exitCode).toBe(0);
      expect(captured.stderr).toEqual([]);
      expect(requests).toHaveLength(2);
      const stored = await readStoredCredential(paths, keychain);
      expect(stored?.state).toBe("active");
      if (stored === null) throw new Error("credential was not stored");
      const output = captured.stdout.join("");
      const profileSource = await readFile(paths.profileFile, "utf8");
      expect(output).not.toContain(enrollment);
      expect(output).not.toContain(stored.credential);
      expect(output).not.toContain(stored.credential.slice(-43));
      expect(output).not.toContain(SESSION_ID);
      expect(profileSource).not.toContain(enrollment);
      expect(profileSource).not.toContain(stored.credential);
      expect(profileSource).not.toContain(stored.credential.slice(-43));
      expect(profileSource).not.toContain(SESSION_ID);
      expect(stat(paths.credentialFile)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await stat(credentialMetadataFile(paths))).mode & 0o777).toBe(0o600);

      const parsedOutput: unknown = JSON.parse(output);
      expect(parsedOutput).toMatchObject({ authenticated: true, recovered: false });
      const enrollmentRequest = requests[0];
      const sessionRequest = requests[1];
      expect(enrollmentRequest?.authorization).toBe(`Bearer ${enrollment}`);
      expect(sessionRequest?.authorization).toBe(`Bearer ${stored.credential}`);
      expect(uuidV7Schema.safeParse(enrollmentRequest?.idempotencyKey).success).toBeTrue();
      expect(uuidV7Schema.safeParse(sessionRequest?.idempotencyKey).success).toBeTrue();
      expect(sessionRequest?.idempotencyKey).not.toBe(enrollmentRequest?.idempotencyKey);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("accepts enrollment only from piped stdin when the environment is empty", async () => {
    const { directory, paths } = await temporaryPaths();
    const enrollment = enrollmentToken();
    const captured = captureIo(`${enrollment}\n`, false);
    const keychain = memoryAgentKeychain();
    const fetchMock = (input: string | URL | Request): Promise<Response> => {
      const path = new URL(inputUrl(input)).pathname;
      return path.endsWith("/redeem")
        ? Promise.resolve(Response.json({
            ok: true,
            data: {
              agentId: "agent-1",
              credentialId: "credential-1",
              credentialExpiresAt: 1_800_000_000_000,
              scopes: ["tasks:read"],
            },
            requestId: REQUEST_ID,
          }))
        : Promise.resolve(Response.json({
            ok: true,
            data: { sessionId: SESSION_ID, expiresAt: SERVER_NOW + AGENT_SESSION_IDLE_MS },
            requestId: REQUEST_ID,
          }));
    };
    try {
      expect(
        await runCli(["auth", "enroll", "--json"], {
          environment: { TASKCTL_API_URL: "http://127.0.0.1:3211" },
          fetch: fetchMock,
          io: captured.io,
          now: () => SERVER_NOW,
          random: deterministicRandom,
          storagePaths: paths,
          agentSecretStore: keychain,
        }),
      ).toBe(0);
      expect(captured.stdout.join("")).not.toContain(enrollment);
      expect(captured.stderr).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("migrates a legacy credential only through the explicit auth command", async () => {
    const { directory, paths } = await temporaryPaths();
    const token = generateCredentialToken(deterministicRandom);
    const legacy = activeCredentialRecord(
      token,
      SESSION_ID,
      SERVER_NOW + AGENT_SESSION_IDLE_MS,
    );
    const keychain = memoryAgentKeychain();
    const captured = captureIo();
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(paths.credentialFile, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
      const exitCode = await runCli(
        ["auth", "migrate-agent-credential", "--json"],
        {
          environment: {},
          io: captured.io,
          random: deterministicRandom,
          storagePaths: paths,
          agentSecretStore: keychain,
        },
      );
      expect(exitCode).toBe(0);
      expect(JSON.parse(captured.stdout.join(""))).toEqual({
        migrated: true,
        source: "keychain",
        state: "active",
      });
      expect(captured.stdout.join("")).not.toContain(token);
      expect(await readStoredCredential(paths, keychain)).toEqual(legacy);
      expect(stat(paths.credentialFile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("dispatches context and the complete Phase 1 task command set", async () => {
  const { directory, paths } = await temporaryPaths();
  const token = generateCredentialToken(deterministicRandom);
  const captured = captureIo();
  const seenPaths: string[] = [];
  const fetchMock = (input: string | URL | Request): Promise<Response> => {
    const url = new URL(inputUrl(input));
    seenPaths.push(`${url.pathname}${url.search}`);
    const path = url.pathname;
    const data =
      path === "/v1/context"
        ? contextData
        : path === "/v1/tasks/OPS-7K2M4Q9"
          ? { task: inProgressTask, description: "", labels: [] }
        : path === "/v1/tasks/ready"
          ? { tasks: [openTask], cursor: null }
          : path === "/v1/tasks"
            ? { task: openTask }
            : path.endsWith("/claim/renew")
              ? { task: inProgressTask }
              : path.endsWith("/claim/release")
                ? { task: openTask }
                : { task: inProgressTask };
    return Promise.resolve(Response.json({ ok: true, data, requestId: REQUEST_ID }));
  };
  try {
    await writeStoredCredential(
      paths,
      activeCredentialRecord(token, SESSION_ID, SERVER_NOW + AGENT_SESSION_IDLE_MS),
      deterministicRandom,
      memoryAgentKeychain(),
      "file",
    );
    await writeProfile(
      paths,
      {
        version: 1,
        apiUrl: "http://127.0.0.1:3211",
        agentId: "agent-1",
        credentialId: "credential-1",
        credentialExpiresAt: 1_800_000_000_000,
        scopes: ["tasks:read", "tasks:create", "tasks:claim"],
      },
      deterministicRandom,
    );

    const commands: readonly (readonly string[])[] = [
      ["context", "--json"],
      ["task", "create", "--title", "Prove the claim race", "--json"],
      ["task", "ready", "--limit", "50", "--cursor", "next page", "--json"],
      ["task", "claim", "OPS-7K2M4Q9", "--json"],
      ["task", "claim", "renew", "OPS-7K2M4Q9", "--fence", "1", "--json"],
      ["task", "release", "OPS-7K2M4Q9", "--fence", "1", "--json"],
    ];
    for (const command of commands) {
      expect(
        await runCli(command, {
          environment: {},
          fetch: fetchMock,
          io: captured.io,
          now: () => SERVER_NOW,
          random: deterministicRandom,
          storagePaths: paths,
        }),
      ).toBe(0);
    }

    expect(seenPaths).toEqual([
      "/v1/context",
      "/v1/tasks",
      "/v1/tasks/ready?cursor=next+page&limit=50",
      "/v1/tasks/OPS-7K2M4Q9/claim",
      "/v1/tasks/OPS-7K2M4Q9/claim/renew",
      "/v1/tasks/OPS-7K2M4Q9",
      "/v1/context",
      "/v1/tasks/OPS-7K2M4Q9/claim/release",
    ]);
    const rendered = captured.stdout.join("");
    expect(rendered).not.toContain(token);
    expect(rendered).not.toContain(token.slice(-43));
    expect(rendered).not.toContain(SESSION_ID);
    expect(captured.stderr).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("protocol errors render on stderr with their documented exit class", async () => {
  const { directory, paths } = await temporaryPaths();
  const token = generateCredentialToken(deterministicRandom);
  const captured = captureIo();
  let sentIdempotencyKey: string | null = null;
  try {
    await writeStoredCredential(
      paths,
      activeCredentialRecord(token, SESSION_ID, SERVER_NOW + AGENT_SESSION_IDLE_MS),
      deterministicRandom,
      memoryAgentKeychain(),
      "file",
    );
    const exitCode = await runCli(["task", "claim", "OPS-7K2M4Q9", "--json"], {
      environment: {},
      fetch: (_input, init) => {
        sentIdempotencyKey = new Headers(init?.headers).get("Idempotency-Key");
        return Promise.resolve(Response.json(
          {
            error: {
              code: "TASK_ALREADY_CLAIMED",
              message: "The task has an active claim.",
              requestId: REQUEST_ID,
              details: { taskKey: "OPS-7K2M4Q9", ownerAgentId: "agent-2" },
            },
          },
          { status: 409 },
        ));
      },
      io: captured.io,
      now: () => SERVER_NOW,
      random: deterministicRandom,
      storagePaths: paths,
    });
    expect(exitCode).toBe(4);
    expect(captured.stdout).toEqual([]);
    expect(JSON.parse(captured.stderr.join(""))).toMatchObject({
      error: {
        code: "TASK_ALREADY_CLAIMED",
        requestId: REQUEST_ID,
        details: { idempotencyKey: sentIdempotencyKey },
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bootstraps missing environment sessions and locally expired file sessions", async () => {
  const token = generateCredentialToken(deterministicRandom);
  for (const source of ["environment", "file"] as const) {
    const { directory, paths } = await temporaryPaths();
    const captured = captureIo();
    const seenPaths: string[] = [];
    try {
      if (source === "file") {
        await writeStoredCredential(
          paths,
          activeCredentialRecord(token, SESSION_ID, SERVER_NOW),
          deterministicRandom,
          memoryAgentKeychain(),
          "file",
        );
      }
      const exitCode = await runCli(["context", "--json"], {
        environment:
          source === "environment"
            ? { TASKCTL_API_URL: "http://127.0.0.1:3211", TASKCTL_TOKEN: token }
            : { TASKCTL_API_URL: "http://127.0.0.1:3211" },
        fetch: (input) => {
          const path = new URL(inputUrl(input)).pathname;
          seenPaths.push(path);
          return Promise.resolve(
            path === "/v1/agent/sessions"
              ? Response.json({
                  ok: true,
                  data: {
                    sessionId: SESSION_ID,
                    expiresAt: SERVER_NOW + AGENT_SESSION_IDLE_MS,
                  },
                  requestId: REQUEST_ID,
                })
              : Response.json({ ok: true, data: contextData, requestId: REQUEST_ID }),
          );
        },
        io: captured.io,
        now: () => SERVER_NOW,
        random: deterministicRandom,
        storagePaths: paths,
      });
      expect(exitCode).toBe(0);
      expect(seenPaths).toEqual(["/v1/agent/sessions", "/v1/context"]);
      expect(JSON.parse(captured.stdout.join(""))).toMatchObject({
        sessionIdempotencyKeys: [expect.any(String)],
      });
      expect(captured.stdout.join("")).not.toContain(SESSION_ID);
      if (source === "file") {
        expect((await readStoredCredential(paths))?.state).toBe("active");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("refreshes once on SESSION_INVALID and replays a task mutation with the same key", async () => {
  const { directory, paths } = await temporaryPaths();
  const token = generateCredentialToken(deterministicRandom);
  const captured = captureIo();
  const taskKeys: (string | null)[] = [];
  const seenPaths: string[] = [];
  try {
    await writeStoredCredential(
      paths,
      activeCredentialRecord(token, SESSION_ID, SERVER_NOW + AGENT_SESSION_IDLE_MS),
      deterministicRandom,
      memoryAgentKeychain(),
      "file",
    );
    let taskAttempt = 0;
    const exitCode = await runCli(
      ["task", "create", "--title", "Replay safely", "--json"],
      {
        environment: { TASKCTL_API_URL: "http://127.0.0.1:3211" },
        fetch: (input, init) => {
          const path = new URL(inputUrl(input)).pathname;
          seenPaths.push(path);
          if (path === "/v1/agent/sessions") {
            return Promise.resolve(Response.json({
              ok: true,
              data: { sessionId: SESSION_ID, expiresAt: SERVER_NOW + AGENT_SESSION_IDLE_MS },
              requestId: REQUEST_ID,
            }));
          }
          taskKeys.push(new Headers(init?.headers).get("Idempotency-Key"));
          taskAttempt += 1;
          return Promise.resolve(
            taskAttempt === 1
              ? Response.json(
                  {
                    error: {
                      code: "SESSION_INVALID",
                      message: "The agent session is invalid or expired.",
                      requestId: REQUEST_ID,
                      details: {},
                    },
                  },
                  { status: 401 },
                )
              : Response.json({ ok: true, data: { task: openTask }, requestId: REQUEST_ID }),
          );
        },
        io: captured.io,
        now: () => SERVER_NOW,
        random: deterministicRandom,
        storagePaths: paths,
      },
    );
    expect(exitCode).toBe(0);
    expect(seenPaths).toEqual(["/v1/tasks", "/v1/agent/sessions", "/v1/tasks"]);
    expect(taskKeys).toHaveLength(2);
    expect(taskKeys[0]).toBe(taskKeys[1]);
    expect(JSON.parse(captured.stdout.join(""))).toMatchObject({
      idempotencyKey: taskKeys[0],
      sessionIdempotencyKeys: [expect.any(String)],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persists a redeem key and reuses it after a noncommitted lost response", async () => {
  const { directory, paths } = await temporaryPaths();
  const enrollment = enrollmentToken();
  const first = captureIo();
  const keychain = memoryAgentKeychain();
  try {
    expect(
      await runCli(["auth", "enroll", "--json"], {
        environment: {
          TASKCTL_API_URL: "http://127.0.0.1:3211",
          TASKCTL_ENROLLMENT_TOKEN: enrollment,
        },
        fetch: () => Promise.reject(new Error("disconnected before commit")),
        io: first.io,
        now: () => SERVER_NOW,
        random: deterministicRandom,
        storagePaths: paths,
        agentSecretStore: keychain,
      }),
    ).toBe(6);
    const pending = await readStoredCredential(paths, keychain);
    expect(pending?.state).toBe("pending_enrollment");
    if (pending?.state !== "pending_enrollment" || pending.redeemIdempotencyKey === undefined) {
      throw new Error("expected a persisted pending enrollment key");
    }
    expect(JSON.parse(first.stderr.join(""))).toMatchObject({
      error: { details: { idempotencyKey: pending.redeemIdempotencyKey } },
    });

    const second = captureIo();
    const redeemKeys: (string | null)[] = [];
    const retryOrigins: string[] = [];
    let sessionAttempts = 0;
    expect(
      await runCli(["auth", "enroll", "--json"], {
        environment: {
          TASKCTL_API_URL: "https://changed.example",
          TASKCTL_ENROLLMENT_TOKEN: enrollment,
        },
        fetch: (input, init) => {
          const url = new URL(inputUrl(input));
          retryOrigins.push(url.origin);
          const path = url.pathname;
          if (path.endsWith("/redeem")) {
            redeemKeys.push(new Headers(init?.headers).get("Idempotency-Key"));
            return Promise.resolve(Response.json({
              ok: true,
              data: {
                agentId: "agent-1",
                credentialId: "credential-1",
                credentialExpiresAt: 1_800_000_000_000,
                scopes: ["tasks:read"],
              },
              requestId: REQUEST_ID,
            }));
          }
          sessionAttempts += 1;
          return Promise.resolve(
            sessionAttempts === 1
              ? Response.json(
                  {
                    error: {
                      code: "AUTHENTICATION_FAILED",
                      message: "Authentication failed.",
                      requestId: REQUEST_ID,
                      details: {},
                    },
                  },
                  { status: 401 },
                )
              : Response.json({
                  ok: true,
                  data: { sessionId: SESSION_ID, expiresAt: SERVER_NOW + AGENT_SESSION_IDLE_MS },
                  requestId: REQUEST_ID,
                }),
          );
        },
        io: second.io,
        now: () => SERVER_NOW,
        random: deterministicRandom,
        storagePaths: paths,
        agentSecretStore: keychain,
      }),
    ).toBe(0);
    expect(redeemKeys).toEqual([pending.redeemIdempotencyKey]);
    expect(retryOrigins).toEqual([
      "http://127.0.0.1:3211",
      "http://127.0.0.1:3211",
      "http://127.0.0.1:3211",
    ]);
    expect((await readStoredCredential(paths, keychain))?.state).toBe("active");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("repairs a commit-then-disconnect enrollment through auth status without a null profile", async () => {
  const { directory, paths } = await temporaryPaths();
  const enrollment = enrollmentToken();
  const first = captureIo();
  const keychain = memoryAgentKeychain();
  try {
    let committedRedeemKey: string | null = null;
    expect(
      await runCli(["auth", "enroll", "--json"], {
        environment: {
          TASKCTL_API_URL: "http://127.0.0.1:3211",
          TASKCTL_ENROLLMENT_TOKEN: enrollment,
        },
        fetch: (_input, init) => {
          committedRedeemKey = new Headers(init?.headers).get("Idempotency-Key");
          return Promise.reject(new Error("response lost after commit"));
        },
        io: first.io,
        now: () => SERVER_NOW,
        random: deterministicRandom,
        storagePaths: paths,
        agentSecretStore: keychain,
      }),
    ).toBe(6);
    const pending = await readStoredCredential(paths, keychain);
    expect(pending).toMatchObject({
      state: "pending_enrollment",
      redeemIdempotencyKey: committedRedeemKey,
    });

    let contextFails = true;
    const recoveryPaths: string[] = [];
    const fetchMock = (input: string | URL | Request): Promise<Response> => {
      const path = new URL(inputUrl(input)).pathname;
      recoveryPaths.push(path);
      if (path === "/v1/agent/sessions") {
        return Promise.resolve(Response.json({
          ok: true,
          data: { sessionId: SESSION_ID, expiresAt: SERVER_NOW + AGENT_SESSION_IDLE_MS },
          requestId: REQUEST_ID,
        }));
      }
      if (contextFails) {
        contextFails = false;
        return Promise.resolve(Response.json(
          {
            error: {
              code: "SERVICE_UNAVAILABLE",
              message: "The service is temporarily unavailable.",
              requestId: REQUEST_ID,
              details: {},
            },
          },
          { status: 503 },
        ));
      }
      return Promise.resolve(Response.json({ ok: true, data: contextData, requestId: REQUEST_ID }));
    };
    const second = captureIo();
    expect(
      await runCli(["auth", "status", "--json"], {
        environment: { TASKCTL_API_URL: "http://127.0.0.1:3211" },
        fetch: fetchMock,
        io: second.io,
        now: () => SERVER_NOW,
        random: deterministicRandom,
        storagePaths: paths,
        agentSecretStore: keychain,
      }),
    ).toBe(6);
    expect(second.stdout).toEqual([]);
    expect((await readStoredCredential(paths, keychain))?.state).toBe("pending_enrollment");

    const third = captureIo();
    expect(
      await runCli(["auth", "status", "--json"], {
        environment: { TASKCTL_API_URL: "http://127.0.0.1:3211" },
        fetch: fetchMock,
        io: third.io,
        now: () => SERVER_NOW,
        random: deterministicRandom,
        storagePaths: paths,
        agentSecretStore: keychain,
      }),
    ).toBe(0);
    expect(JSON.parse(third.stdout.join(""))).toMatchObject({
      authenticated: true,
      profile: { agentId: "agent-1" },
      recovered: true,
    });
    expect(recoveryPaths).not.toContain("/v1/agent/enrollments/redeem");
    expect((await readStoredCredential(paths, keychain))?.state).toBe("active");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("replays an ambiguous enrollment session start with its persisted key", async () => {
  const { directory, paths } = await temporaryPaths();
  const enrollment = enrollmentToken();
  const first = captureIo();
  const keychain = memoryAgentKeychain();
  let committedSessionKey: string | null = null;
  try {
    expect(
      await runCli(["auth", "enroll", "--json"], {
        environment: {
          TASKCTL_API_URL: "http://127.0.0.1:3211",
          TASKCTL_ENROLLMENT_TOKEN: enrollment,
        },
        fetch: (input, init) => {
          const path = new URL(inputUrl(input)).pathname;
          if (path.endsWith("/redeem")) {
            return Promise.resolve(Response.json({
              ok: true,
              data: {
                agentId: "agent-1",
                credentialId: "credential-1",
                credentialExpiresAt: 1_800_000_000_000,
                scopes: ["tasks:read"],
              },
              requestId: REQUEST_ID,
            }));
          }
          committedSessionKey = new Headers(init?.headers).get("Idempotency-Key");
          return Promise.reject(new Error("session committed but response disconnected"));
        },
        io: first.io,
        now: () => SERVER_NOW,
        random: deterministicRandom,
        storagePaths: paths,
        agentSecretStore: keychain,
      }),
    ).toBe(6);
    expect(JSON.parse(first.stderr.join(""))).toMatchObject({
      error: { details: { idempotencyKey: committedSessionKey } },
    });
    expect((await readStoredCredential(paths, keychain))?.state).toBe("pending_enrollment");

    const second = captureIo();
    const replayedSessionKeys: (string | null)[] = [];
    const replayedPaths: string[] = [];
    expect(
      await runCli(["auth", "enroll", "--json"], {
        environment: {
          TASKCTL_API_URL: "https://changed.example",
          TASKCTL_ENROLLMENT_TOKEN: enrollment,
        },
        fetch: (input, init) => {
          replayedPaths.push(new URL(inputUrl(input)).pathname);
          replayedSessionKeys.push(new Headers(init?.headers).get("Idempotency-Key"));
          return Promise.resolve(Response.json({
            ok: true,
            data: { sessionId: SESSION_ID, expiresAt: SERVER_NOW + AGENT_SESSION_IDLE_MS },
            requestId: REQUEST_ID,
          }));
        },
        io: second.io,
        now: () => SERVER_NOW + 1,
        random: deterministicRandom,
        storagePaths: paths,
        agentSecretStore: keychain,
      }),
    ).toBe(0);
    expect(replayedPaths).toEqual(["/v1/agent/sessions"]);
    expect(replayedSessionKeys).toEqual([committedSessionKey]);
    expect((await readStoredCredential(paths, keychain))?.state).toBe("active");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("replays an ambiguous expired-session refresh before continuing", async () => {
  const { directory, paths } = await temporaryPaths();
  const token = generateCredentialToken(deterministicRandom);
  const first = captureIo();
  let committedSessionKey: string | null = null;
  try {
    await writeStoredCredential(
      paths,
      activeCredentialRecord(token, SESSION_ID, SERVER_NOW),
      deterministicRandom,
      memoryAgentKeychain(),
      "file",
    );
    await writeProfile(
      paths,
      {
        version: 1,
        apiUrl: "http://127.0.0.1:3211",
        agentId: "agent-1",
        scopes: ["tasks:read"],
      },
      deterministicRandom,
    );
    expect(
      await runCli(["context", "--json"], {
        environment: {},
        fetch: (_input, init) => {
          committedSessionKey = new Headers(init?.headers).get("Idempotency-Key");
          return Promise.reject(new Error("refresh committed but response disconnected"));
        },
        io: first.io,
        now: () => SERVER_NOW,
        random: deterministicRandom,
        storagePaths: paths,
      }),
    ).toBe(6);

    const second = captureIo();
    const replayedSessionKeys: (string | null)[] = [];
    const seenPaths: string[] = [];
    expect(
      await runCli(["context", "--json"], {
        environment: {},
        fetch: (input, init) => {
          const path = new URL(inputUrl(input)).pathname;
          seenPaths.push(path);
          if (path === "/v1/agent/sessions") {
            replayedSessionKeys.push(new Headers(init?.headers).get("Idempotency-Key"));
            return Promise.resolve(Response.json({
              ok: true,
              data: { sessionId: SESSION_ID, expiresAt: SERVER_NOW + AGENT_SESSION_IDLE_MS },
              requestId: REQUEST_ID,
            }));
          }
          return Promise.resolve(Response.json({ ok: true, data: contextData, requestId: REQUEST_ID }));
        },
        io: second.io,
        now: () => SERVER_NOW + 1,
        random: deterministicRandom,
        storagePaths: paths,
      }),
    ).toBe(0);
    expect(seenPaths).toEqual(["/v1/agent/sessions", "/v1/context"]);
    expect(replayedSessionKeys).toEqual([committedSessionKey]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("replays an ambiguous SESSION_INVALID refresh before retrying once", async () => {
  const { directory, paths } = await temporaryPaths();
  const token = generateCredentialToken(deterministicRandom);
  const first = captureIo();
  let committedSessionKey: string | null = null;
  try {
    await writeStoredCredential(
      paths,
      activeCredentialRecord(token, SESSION_ID, SERVER_NOW + AGENT_SESSION_IDLE_MS),
      deterministicRandom,
      memoryAgentKeychain(),
      "file",
    );
    await writeProfile(
      paths,
      {
        version: 1,
        apiUrl: "http://127.0.0.1:3211",
        agentId: "agent-1",
        scopes: ["tasks:read"],
      },
      deterministicRandom,
    );
    let firstRequest = true;
    expect(
      await runCli(["context", "--json"], {
        environment: {},
        fetch: (_input, init) => {
          if (firstRequest) {
            firstRequest = false;
            return Promise.resolve(Response.json(
              {
                error: {
                  code: "SESSION_INVALID",
                  message: "The agent session is invalid or expired.",
                  requestId: REQUEST_ID,
                  details: {},
                },
              },
              { status: 401 },
            ));
          }
          committedSessionKey = new Headers(init?.headers).get("Idempotency-Key");
          return Promise.reject(new Error("refresh committed but response disconnected"));
        },
        io: first.io,
        now: () => SERVER_NOW,
        random: deterministicRandom,
        storagePaths: paths,
      }),
    ).toBe(6);

    const second = captureIo();
    const replayedSessionKeys: (string | null)[] = [];
    let contextAttempts = 0;
    expect(
      await runCli(["context", "--json"], {
        environment: {},
        fetch: (input, init) => {
          const path = new URL(inputUrl(input)).pathname;
          if (path === "/v1/agent/sessions") {
            replayedSessionKeys.push(new Headers(init?.headers).get("Idempotency-Key"));
            return Promise.resolve(Response.json({
              ok: true,
              data: { sessionId: SESSION_ID, expiresAt: SERVER_NOW + AGENT_SESSION_IDLE_MS },
              requestId: REQUEST_ID,
            }));
          }
          contextAttempts += 1;
          return Promise.resolve(
            contextAttempts === 1
              ? Response.json(
                  {
                    error: {
                      code: "SESSION_INVALID",
                      message: "The agent session is invalid or expired.",
                      requestId: REQUEST_ID,
                      details: {},
                    },
                  },
                  { status: 401 },
                )
              : Response.json({ ok: true, data: contextData, requestId: REQUEST_ID }),
          );
        },
        io: second.io,
        now: () => SERVER_NOW + 1,
        random: deterministicRandom,
        storagePaths: paths,
      }),
    ).toBe(0);
    expect(contextAttempts).toBe(2);
    expect(replayedSessionKeys).toEqual([committedSessionKey]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
