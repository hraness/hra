import { describe, expect, test } from "bun:test";
import {
  AGENT_SESSION_HEARTBEAT_MS,
  AGENT_SESSION_IDLE_MS,
  CLAIM_RENEWAL_THRESHOLD_MS,
  DEFAULT_CLAIM_LEASE_MS,
  createBearerSecret,
  createLocator,
  formatCredentialToken,
  uuidV7Schema,
  type CredentialToken,
  type SessionId,
} from "@hraness/agent-tasks-protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RandomSource, StoragePaths, TaskctlEnvironment } from "./config";
import { runCli } from "./index";
import type { CliIo } from "./output";

const SERVER_NOW = 1_800_000_000_000;
const REQUEST_ID = "req_00000000000000000000000000";
const TASK_KEY = "OPS-7K2M4Q9";
const SUBMISSION_ID = "sub_00000000000000000000000000";
const WORKER_SESSION: SessionId = "ses_00000000000000000000000000";
const REVIEWER_SESSION: SessionId = "ses_11111111111111111111111111";
const CLAIM_KEY = "018f22e2-7b44-7cc0-8e5d-657f31f9064a"; // gitleaks:allow - deterministic test vector
const UPDATE_KEY = "018f22e2-7b44-7cc0-8e5d-657f31f9064b"; // gitleaks:allow - deterministic test vector
const SUBMIT_KEY = "018f22e2-7b44-7cc0-8e5d-657f31f9064c"; // gitleaks:allow - deterministic test vector
const ACCEPT_KEY = "018f22e2-7b44-7cc0-8e5d-657f31f9064d"; // gitleaks:allow - deterministic test vector

const deterministicRandom: RandomSource = (length) =>
  Uint8Array.from({ length }, (_, index) => (length + index * 29) % 256);

function token(offset: number): CredentialToken {
  return formatCredentialToken(
    createLocator(Uint8Array.from({ length: 26 }, (_, index) => index + offset)),
    createBearerSecret(Uint8Array.from({ length: 32 }, (_, index) => index + offset + 60)),
  );
}

function captureIo(): { readonly io: CliIo; readonly stdout: string[]; readonly stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      readStdin: () => Promise.resolve(""),
      stdinIsTTY: false,
    },
  };
}

function inputUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}

function stringBody(body: RequestInit["body"]): string {
  if (typeof body !== "string") throw new Error("expected a JSON request body");
  return body;
}

interface CapturedRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly idempotencyKey: string | null;
  readonly body: unknown;
}

describe("claim-bound CLI dispatch", () => {
  test("claims, automatically renews an edit, submits, queues, and accepts as a distinct reviewer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taskctl-claim-dispatch-"));
    const paths: StoragePaths = {
      credentialFile: join(directory, "credentials.json"),
      profileFile: join(directory, "profile.json"),
    };
    const worker = token(0);
    const reviewer = token(9);
    const requests: CapturedRequest[] = [];
    let status: "open" | "in_progress" | "in_review" | "done" = "open";
    let revision = 1;
    let reviewRevision = 1;
    let title = "Automatic renewal";
    let leaseGeneration = 0;
    let leaseUntil = 0;
    const fence = 7;

    const task = () => {
      const base = {
        id: "tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        key: TASK_KEY,
        title,
        type: "task" as const,
        priority: 2,
        availableAt: 0,
        isReady: status === "open",
        unresolvedBlockerCount: 0,
        cancelledBlockerCount: 0,
        revision,
        reviewRevision,
        createdAt: 1,
        updatedAt: SERVER_NOW,
      };
      switch (status) {
        case "open":
          return { ...base, status };
        case "in_progress":
          return {
            ...base,
            status,
            isReady: false,
            currentClaim: {
              id: "claim-1",
              agentId: "worker-agent",
              fence,
              leaseGeneration,
              leaseUntil,
            },
          };
        case "in_review":
          return { ...base, status, isReady: false };
        case "done":
          return { ...base, status, isReady: false };
      }
    };
    const pendingSubmission = () => ({
      id: SUBMISSION_ID,
      taskKey: TASK_KEY,
      submittedBy: { kind: "agent" as const, agentId: "worker-agent" },
      reviewRevision,
      summary: "implemented",
      evidence: [{ kind: "test" as const, command: "bun test" }],
      submittedAt: SERVER_NOW + 3,
      status: "pending" as const,
    });

    const fetchMock = (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = new URL(inputUrl(input));
      const headers = new Headers(init?.headers);
      const method = init?.method ?? "GET";
      const body: unknown =
        init?.body === undefined ? null : JSON.parse(stringBody(init.body));
      requests.push({
        method,
        path: `${url.pathname}${url.search}`,
        authorization: headers.get("Authorization"),
        idempotencyKey: headers.get("Idempotency-Key"),
        body,
      });

      const authorization = headers.get("Authorization");
      const agentId = authorization === `Bearer ${reviewer}` ? "reviewer-agent" : "worker-agent";
      let data: unknown;
      if (url.pathname === "/v1/context") {
        data = {
          principal: {
            kind: "agent",
            agentId,
            name: agentId,
            scopes: ["tasks:read", "tasks:edit", "tasks:claim", "tasks:submit", "tasks:review"],
            sessionId: agentId === "worker-agent" ? WORKER_SESSION : REVIEWER_SESSION,
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
          counts: { readyTasks: 0, activeClaims: status === "in_progress" ? 1 : 0, reviewRequests: status === "in_review" ? 1 : 0 },
          readyTasks: [],
          activeClaims: [],
          reviewRequests: [],
          cursors: { readyTasks: null, activeClaims: null, reviewRequests: null },
          workflowRules: ["Renew claim-bound commands."],
        };
      } else if (url.pathname === `/v1/tasks/${TASK_KEY}/claim`) {
        expect(authorization).toBe(`Bearer ${worker}`);
        status = "in_progress";
        revision = 2;
        leaseGeneration = 1;
        leaseUntil = SERVER_NOW + CLAIM_RENEWAL_THRESHOLD_MS;
        data = { task: task() };
      } else if (url.pathname === `/v1/tasks/${TASK_KEY}` && method === "GET") {
        data = { task: task(), description: "", labels: [] };
      } else if (url.pathname === `/v1/tasks/${TASK_KEY}/claim/renew`) {
        expect(body).toEqual({ fence });
        revision += 1;
        leaseGeneration += 1;
        leaseUntil = SERVER_NOW + DEFAULT_CLAIM_LEASE_MS;
        data = { task: task() };
      } else if (url.pathname === `/v1/tasks/${TASK_KEY}/update`) {
        expect(body).toEqual({ revision: 3, fence, title: "Renewed edit" });
        title = "Renewed edit";
        revision += 1;
        reviewRevision += 1;
        data = { task: task(), description: "", labels: [] };
      } else if (url.pathname === `/v1/tasks/${TASK_KEY}/submit`) {
        expect(body).toEqual({
          fence,
          summary: "implemented",
          evidence: [{ kind: "test", command: "bun test" }],
        });
        status = "in_review";
        revision += 1;
        data = { task: task(), submission: pendingSubmission() };
      } else if (url.pathname === "/v1/reviews") {
        expect(authorization).toBe(`Bearer ${reviewer}`);
        data = { reviews: [{ task: task(), submission: pendingSubmission() }], cursor: null };
      } else if (url.pathname === `/v1/tasks/${TASK_KEY}/accept`) {
        expect(authorization).toBe(`Bearer ${reviewer}`);
        expect(body).toEqual({ submissionId: SUBMISSION_ID, reviewRevision });
        status = "done";
        revision += 1;
        data = {
          task: task(),
          submission: {
            ...pendingSubmission(),
            status: "accepted",
            reviewedAt: SERVER_NOW + 4,
          },
        };
      } else {
        throw new Error(`unexpected fake route ${method} ${url.pathname}`);
      }
      return Promise.resolve(Response.json({ ok: true, data, requestId: REQUEST_ID }));
    };

    const run = async (
      argv: readonly string[],
      credential: CredentialToken,
      sessionId: SessionId,
    ) => {
      const captured = captureIo();
      const environment: TaskctlEnvironment = {
        TASKCTL_API_URL: "http://127.0.0.1:3211",
        TASKCTL_TOKEN: credential,
        TASKCTL_SESSION_ID: sessionId,
      };
      const exitCode = await runCli(argv, {
        environment,
        fetch: fetchMock,
        io: captured.io,
        now: () => SERVER_NOW,
        random: deterministicRandom,
        storagePaths: paths,
      });
      return { exitCode, ...captured };
    };

    try {
      const claim = await run(
        ["task", "claim", TASK_KEY, "--idempotency-key", CLAIM_KEY, "--json"],
        worker,
        WORKER_SESSION,
      );
      const update = await run(
        [
          "task",
          "update",
          TASK_KEY,
          "--revision",
          "1",
          "--fence",
          "99",
          "--title",
          "Renewed edit",
          "--idempotency-key",
          UPDATE_KEY,
          "--json",
        ],
        worker,
        WORKER_SESSION,
      );
      const submit = await run(
        [
          "task",
          "submit",
          TASK_KEY,
          "--fence",
          "1",
          "--summary",
          "implemented",
          "--evidence-json",
          '[{"kind":"test","command":"bun test"}]',
          "--idempotency-key",
          SUBMIT_KEY,
          "--json",
        ],
        worker,
        WORKER_SESSION,
      );
      const queue = await run(["review", "queue", "--json"], reviewer, REVIEWER_SESSION);
      const accept = await run(
        [
          "task",
          "accept",
          TASK_KEY,
          "--submission",
          SUBMISSION_ID,
          "--review-revision",
          "2",
          "--idempotency-key",
          ACCEPT_KEY,
          "--json",
        ],
        reviewer,
        REVIEWER_SESSION,
      );

      expect([claim.exitCode, update.exitCode, submit.exitCode, queue.exitCode, accept.exitCode]).toEqual([
        0,
        0,
        0,
        0,
        0,
      ]);
      const updateOutput = JSON.parse(update.stdout.join("")) as {
        readonly idempotencyKey: string;
        readonly automaticClaimRenewal: {
          readonly idempotencyKey: string;
          readonly revision: number;
          readonly fence: number;
          readonly leaseGeneration: number;
          readonly leaseUntil: number;
        };
      };
      expect(updateOutput.idempotencyKey).toBe(UPDATE_KEY);
      expect(updateOutput.automaticClaimRenewal).toMatchObject({
        revision: 3,
        fence,
        leaseGeneration: 2,
        leaseUntil: SERVER_NOW + DEFAULT_CLAIM_LEASE_MS,
      });
      expect(updateOutput.automaticClaimRenewal.idempotencyKey).not.toBe(UPDATE_KEY);
      expect(uuidV7Schema.safeParse(updateOutput.automaticClaimRenewal.idempotencyKey).success).toBeTrue();

      expect(requests.map((request) => request.path)).toEqual([
        `/v1/tasks/${TASK_KEY}/claim`,
        `/v1/tasks/${TASK_KEY}`,
        "/v1/context",
        `/v1/tasks/${TASK_KEY}/claim/renew`,
        `/v1/tasks/${TASK_KEY}/update`,
        `/v1/tasks/${TASK_KEY}`,
        "/v1/context",
        `/v1/tasks/${TASK_KEY}/submit`,
        "/v1/reviews?limit=20",
        `/v1/tasks/${TASK_KEY}/accept`,
      ]);
      const renewalRequest = requests[3];
      const updateRequest = requests[4];
      expect(renewalRequest?.idempotencyKey).toBe(updateOutput.automaticClaimRenewal.idempotencyKey);
      expect(updateRequest?.idempotencyKey).toBe(UPDATE_KEY);
      expect(renewalRequest?.idempotencyKey).not.toBe(updateRequest?.idempotencyKey);
      expect(String(status)).toBe("done");
      expect(title).toBe("Renewed edit");

      const allOutput = [claim, update, submit, queue, accept]
        .flatMap((result) => [...result.stdout, ...result.stderr])
        .join("");
      expect(allOutput).not.toContain(worker);
      expect(allOutput).not.toContain(reviewer);
      expect(allOutput).not.toContain(worker.slice(-43));
      expect(allOutput).not.toContain(reviewer.slice(-43));
      expect(allOutput).not.toContain(WORKER_SESSION);
      expect(allOutput).not.toContain(REVIEWER_SESSION);
      expect([claim, update, submit, queue, accept].flatMap((result) => result.stderr)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("comments and reviewer commands bypass claim preflight", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taskctl-non-claim-dispatch-"));
    const paths: StoragePaths = {
      credentialFile: join(directory, "credentials.json"),
      profileFile: join(directory, "profile.json"),
    };
    const reviewer = token(12);
    const pathsSeen: string[] = [];
    const fetchMock = (input: string | URL | Request): Promise<Response> => {
      const url = new URL(inputUrl(input));
      pathsSeen.push(`${url.pathname}${url.search}`);
      const data = url.pathname.endsWith("/comments")
        ? {
            comment: {
              id: "cmt_00000000000000000000000000",
              body: "review evidence",
              actor: { kind: "agent", agentId: "reviewer-agent" },
              createdAt: SERVER_NOW,
            },
          }
        : { reviews: [], cursor: null };
      return Promise.resolve(Response.json({ ok: true, data, requestId: REQUEST_ID }));
    };
    const environment: TaskctlEnvironment = {
      TASKCTL_API_URL: "http://127.0.0.1:3211",
      TASKCTL_TOKEN: reviewer,
      TASKCTL_SESSION_ID: REVIEWER_SESSION,
    };

    try {
      const commentIo = captureIo();
      const commentExit = await runCli(
        ["task", "comment", "add", TASK_KEY, "--body", "review evidence", "--json"],
        {
          environment,
          fetch: fetchMock,
          io: commentIo.io,
          now: () => SERVER_NOW,
          random: deterministicRandom,
          storagePaths: paths,
        },
      );
      const reviewIo = captureIo();
      const reviewExit = await runCli(["review", "queue", "--json"], {
        environment,
        fetch: fetchMock,
        io: reviewIo.io,
        now: () => SERVER_NOW,
        random: deterministicRandom,
        storagePaths: paths,
      });

      expect([commentExit, reviewExit]).toEqual([0, 0]);
      expect(pathsSeen).toEqual([
        `/v1/tasks/${TASK_KEY}/comments`,
        "/v1/reviews?limit=20",
      ]);
      expect(pathsSeen.some((path) => path === "/v1/context" || path.endsWith("/claim/renew"))).toBeFalse();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
