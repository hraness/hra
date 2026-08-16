import { describe, expect, test } from "bun:test";

import {
  buildHostedTaskWorkspaceChangeFeed,
  decodeHostedTaskSourceToken,
  encodeHostedTaskSourceToken,
  type HostedTaskInvalidationRow,
  type HostedTaskSourceState,
} from "./humanTaskWorkspace";

const CLASSIFIED_AT = 1_735_689_600_000;
const SOURCE_TOKEN_TTL_MS = 5 * 60 * 1_000;
const VALID_WORKSPACE_ID = "wsp_00000000000000000000000000";
const VALID_TASK_ID = "tsk_00000000000000000000000000";
const VALID_RUN_ID = "run_00000000000000000000000000";

const taskViewRevisions = {
  all: 12,
  ready: 10,
  blocked: 8,
  deferred: 7,
  attention: 11,
  assigned: 9,
  review: 6,
} as const;

const feedTenant = {
  organizationId: "org_internal",
  workspaceId: "wsp_internal",
  workspacePublicId: VALID_WORKSPACE_ID,
} as const;

type HostedTaskInvalidationOverrides = Partial<Omit<
  HostedTaskInvalidationRow,
  "runPublicId" | "structure" | "taskPublicId" | "views"
>> & Readonly<{
  runPublicId?: HostedTaskInvalidationRow["runPublicId"] | undefined;
  structure?: HostedTaskInvalidationRow["structure"] | undefined;
  taskPublicId?: HostedTaskInvalidationRow["taskPublicId"] | undefined;
  views?: HostedTaskInvalidationRow["views"] | undefined;
}>;

function invalidation(
  projectionRevision: number,
  overrides: HostedTaskInvalidationOverrides = {},
): HostedTaskInvalidationRow {
  const merged = {
    ...feedTenant,
    projectionRevision,
    taskPublicId: VALID_TASK_ID,
    runPublicId: VALID_RUN_ID,
    views: ["all", "ready"] as const,
    structure: false,
    createdAt: CLASSIFIED_AT + projectionRevision,
    ...overrides,
    scope: overrides.scope ?? "run",
  };
  return {
    organizationId: merged.organizationId,
    workspaceId: merged.workspaceId,
    workspacePublicId: merged.workspacePublicId,
    projectionRevision: merged.projectionRevision,
    scope: merged.scope,
    ...(merged.taskPublicId === undefined
      ? {}
      : { taskPublicId: merged.taskPublicId }),
    ...(merged.runPublicId === undefined
      ? {}
      : { runPublicId: merged.runPublicId }),
    ...(merged.views === undefined ? {} : { views: merged.views }),
    ...(merged.structure === undefined
      ? {}
      : { structure: merged.structure }),
    createdAt: merged.createdAt,
  };
}

const validState = {
  version: 3,
  kind: "task_workspace_source",
  organizationId: "org_00000000000000000000000000",
  userId: "usr_00000000000000000000000000",
  workspaceId: VALID_WORKSPACE_ID,
  continuationRevision: 7,
  view: "assigned",
  assignedAgentId: "agent_local",
  selectedTaskId: VALID_TASK_ID,
  classifiedAt: CLASSIFIED_AT,
  expiresAt: CLASSIFIED_AT + SOURCE_TOKEN_TTL_MS,
} as const satisfies HostedTaskSourceState;

function encodeJson(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

describe("hosted task source token codec", () => {
  test("round trips the exact closed source state", () => {
    const token = encodeHostedTaskSourceToken(validState);

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(decodeHostedTaskSourceToken(token)).toEqual(validState);
  });

  test("accepts the unfiltered source without manufacturing optional IDs", () => {
    const state = {
      ...validState,
      view: "all",
      assignedAgentId: null,
      selectedTaskId: null,
    } as const satisfies HostedTaskSourceState;

    expect(decodeHostedTaskSourceToken(encodeHostedTaskSourceToken(state)))
      .toEqual(state);
  });

  test("represents the unscoped Assigned view with a null agent filter", () => {
    const state = {
      ...validState,
      assignedAgentId: null,
    } as const satisfies HostedTaskSourceState;

    expect(decodeHostedTaskSourceToken(encodeHostedTaskSourceToken(state)))
      .toEqual(state);
  });

  test.each([
    ["empty", ""],
    ["non-base64url alphabet", "not+a-token"],
    ["malformed JSON", encodeJson("not an object")],
    ["invalid UTF-8", "_w"],
    ["oversized input", "A".repeat(8_193)],
  ] as const)("rejects %s input", (_name, token) => {
    expect(decodeHostedTaskSourceToken(token)).toBeNull();
  });

  test.each([
    ["an array", []],
    ["null", null],
    ["an object-valued view", { ...validState, view: { includes: true } }],
    ["an array-valued view", { ...validState, view: ["assigned"] }],
    ["an unknown view", { ...validState, view: "mine" }],
    ["a missing field", { ...validState, selectedTaskId: undefined }],
    ["an extra field", { ...validState, elevated: true }],
    [
      "a prototype-shaped field",
      { ...validState, ["__proto__"]: { elevated: true } },
    ],
  ] as const)("rejects %s instead of coercing it", (_name, value) => {
    expect(decodeHostedTaskSourceToken(encodeJson(value))).toBeNull();
  });

  test.each([
    ["version", { version: 1 }],
    ["kind", { kind: "task_workspace_page" }],
    ["empty organization ID", { organizationId: "" }],
    ["oversized organization ID", { organizationId: "o".repeat(129) }],
    ["empty user ID", { userId: "" }],
    ["oversized user ID", { userId: "u".repeat(129) }],
    ["malformed workspace public ID", { workspaceId: "workspace_local" }],
    ["wrong-prefix workspace public ID", { workspaceId: VALID_TASK_ID }],
    ["zero continuation revision", { continuationRevision: 0 }],
    ["fractional continuation revision", { continuationRevision: 1.5 }],
    ["unsafe continuation revision", {
      continuationRevision: Number.MAX_SAFE_INTEGER + 1,
    }],
    ["empty assigned agent ID", { assignedAgentId: "" }],
    ["oversized assigned agent ID", { assignedAgentId: "a".repeat(129) }],
    ["malformed selected task public ID", { selectedTaskId: "task_local" }],
    ["wrong-prefix selected task public ID", { selectedTaskId: VALID_WORKSPACE_ID }],
    ["negative classification time", {
      classifiedAt: -1,
      expiresAt: SOURCE_TOKEN_TTL_MS - 1,
    }],
    ["fractional classification time", {
      classifiedAt: CLASSIFIED_AT + 0.5,
      expiresAt: CLASSIFIED_AT + SOURCE_TOKEN_TTL_MS + 0.5,
    }],
    ["unsafe classification time", {
      classifiedAt: Number.MAX_SAFE_INTEGER + 1,
      expiresAt: Number.MAX_SAFE_INTEGER + 1 + SOURCE_TOKEN_TTL_MS,
    }],
    ["noncanonical expiry", { expiresAt: CLASSIFIED_AT + SOURCE_TOKEN_TTL_MS + 1 }],
  ] as const)("rejects %s", (_name, override) => {
    expect(decodeHostedTaskSourceToken(encodeJson({ ...validState, ...override })))
      .toBeNull();
  });

  test("rejects an agent filter outside the assigned view", () => {
    expect(decodeHostedTaskSourceToken(encodeJson({
      ...validState,
      view: "ready",
    }))).toBeNull();
  });

  test("refuses to emit a token outside the portable character bound", () => {
    expect(() => encodeHostedTaskSourceToken({
      ...validState,
      organizationId: "o".repeat(8_192),
    })).toThrow("Hosted task source token exceeded its portable bound.");
  });
});

describe("hosted task change feed", () => {
  test("replays every skipped global head in order", () => {
    expect(buildHostedTaskWorkspaceChangeFeed({
      tenant: feedTenant,
      afterRevision: 9,
      limit: 10,
      heads: { projectionRevision: 12, taskViewRevisions },
      rows: [
        invalidation(10),
        invalidation(11, {
          scope: "task",
          runPublicId: undefined,
          views: ["attention"],
          structure: true,
        }),
        invalidation(12),
      ],
    })).toMatchObject({
      fromRevision: 9,
      throughRevision: 12,
      projectionRevision: 12,
      taskViewRevisions,
      hasMore: false,
      resetRequired: false,
      changes: [
        { projectionRevision: 10, scope: "run", structure: false },
        { projectionRevision: 11, scope: "task", structure: true },
        { projectionRevision: 12, scope: "run", structure: false },
      ],
    });
  });

  test("uses a legacy workspace invalidation as a full-refresh fallback", () => {
    expect(buildHostedTaskWorkspaceChangeFeed({
      tenant: feedTenant,
      afterRevision: 9,
      limit: 10,
      heads: { projectionRevision: 12, taskViewRevisions },
      rows: [
        invalidation(10, {
          scope: "workspace",
          taskPublicId: undefined,
          runPublicId: undefined,
          views: undefined,
          structure: undefined,
        }),
      ],
    })).toMatchObject({
      throughRevision: 12,
      hasMore: false,
      resetRequired: true,
      changes: [{ projectionRevision: 10, scope: "workspace" }],
    });
  });

  test("fails closed when an indexed row crosses its tenant", () => {
    expect(buildHostedTaskWorkspaceChangeFeed({
      tenant: feedTenant,
      afterRevision: 9,
      limit: 10,
      heads: { projectionRevision: 10, taskViewRevisions },
      rows: [invalidation(10, { organizationId: "org_foreign" })],
    })).toBeNull();
  });

  test("bounds one page and reports another replay page", () => {
    const feed = buildHostedTaskWorkspaceChangeFeed({
      tenant: feedTenant,
      afterRevision: 9,
      limit: 2,
      heads: { projectionRevision: 12, taskViewRevisions },
      rows: [invalidation(10), invalidation(11), invalidation(12)],
    });

    expect(feed).toMatchObject({
      throughRevision: 11,
      hasMore: true,
      resetRequired: false,
    });
    expect(feed?.changes).toHaveLength(2);
  });

  test("requests a reset when an invalidation head is missing", () => {
    expect(buildHostedTaskWorkspaceChangeFeed({
      tenant: feedTenant,
      afterRevision: 9,
      limit: 10,
      heads: { projectionRevision: 12, taskViewRevisions },
      rows: [invalidation(11), invalidation(12)],
    })).toMatchObject({
      throughRevision: 12,
      hasMore: false,
      resetRequired: true,
      changes: [],
    });
  });
});
