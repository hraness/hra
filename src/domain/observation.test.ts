import { describe, expect, test } from "bun:test";

import {
  ROOT_STATUS_ATTENTION_LIMIT,
  ROOT_STATUS_MAXIMUM_BYTES,
  assertRootStatusBound,
  deriveSessionAttention,
  rootStatusAttentionRecordSchema,
  rootStatusSchema,
  sessionEventCutSchema,
  sessionInteractionObservationSchema,
  sessionStatusSchema,
} from "./observation";

const cursorWireSignature = "A".repeat(43);
const cursorWire = (label: string): string =>
  `hra1.${Buffer.from(`fixture:${label}`).toString("base64url")}.${cursorWireSignature}`;

describe("observation contract", () => {
  test("rejects an impossible event retention cut", () => {
    expect(sessionEventCutSchema.safeParse({
      streamEpoch: "00000000-0000-4000-8000-000000000001",
      floorSequence: 3,
      observedThroughSequence: 1,
    }).success).toBe(false);
    expect(sessionEventCutSchema.safeParse({
      streamEpoch: "00000000-0000-4000-8000-000000000001",
      floorSequence: 2,
      observedThroughSequence: 1,
    }).success).toBe(true);
  });

  test("binds each interaction attention state to an executable inspection intent", () => {
    const base = {
      accountId: `acct_${"a".repeat(32)}`,
      accountGeneration: 1,
      sessionId: `sess_${"b".repeat(32)}`,
      interactionId: "a0000000-0000-4000-8000-000000000001",
      interactionRevision: 2,
      blocking: true,
      deadlineAt: 3,
      observedAt: 1,
    } as const;
    const protectedPending = {
      ...base,
      kind: "interaction_pending" as const,
      interactionKind: "permission_approval" as const,
      interactionState: "pending" as const,
      intent: {
        kind: "inspect_interaction" as const,
        interactionId: base.interactionId,
        expectedRevision: base.interactionRevision,
      },
    };
    expect(rootStatusAttentionRecordSchema.parse(protectedPending))
      .toEqual(protectedPending);
    expect(rootStatusAttentionRecordSchema.safeParse({
      ...protectedPending,
      intent: { kind: "show_interaction", interactionId: base.interactionId },
    }).success).toBe(false);

    const ordinaryPending = {
      ...base,
      kind: "interaction_pending" as const,
      interactionKind: "mcp_elicitation" as const,
      interactionState: "pending" as const,
      intent: { kind: "show_interaction" as const, interactionId: base.interactionId },
    };
    expect(rootStatusAttentionRecordSchema.parse(ordinaryPending)).toEqual(ordinaryPending);
    expect(rootStatusAttentionRecordSchema.safeParse({
      ...ordinaryPending,
      intent: {
        kind: "inspect_interaction",
        interactionId: base.interactionId,
        expectedRevision: base.interactionRevision,
      },
    }).success).toBe(false);

    const inFlight = {
      ...base,
      kind: "interaction_response_in_flight" as const,
      interactionKind: "command_approval" as const,
      interactionState: "response_written" as const,
      intent: { kind: "show_interaction" as const, interactionId: base.interactionId },
    };
    expect(rootStatusAttentionRecordSchema.parse(inFlight)).toEqual(inFlight);
  });

  test("keeps execution and attention orthogonal", () => {
    expect(deriveSessionAttention({
      execution: "terminal",
      localCoverage: "complete",
      pendingInteractionCount: 1,
      responseInFlightCount: 0,
    })).toBe("human_action_required");
    expect(deriveSessionAttention({
      execution: "recovery_required",
      localCoverage: "complete",
      pendingInteractionCount: 1,
      responseInFlightCount: 0,
    })).toBe("recovery_required");
    expect(deriveSessionAttention({
      execution: "idle",
      localCoverage: "partial",
      pendingInteractionCount: 0,
      responseInFlightCount: 0,
    })).toBe("unknown");
    expect(deriveSessionAttention({
      execution: "idle",
      localCoverage: "complete",
      pendingInteractionCount: 0,
      responseInFlightCount: 1,
    })).toBe("response_in_flight");
  });

  test("enumerates every advisory combination without collapsing independent axes", () => {
    const executions = [
      "starting",
      "active",
      "idle",
      "terminal",
      "recovery_required",
    ] as const;
    const coverages = ["complete", "partial", "unavailable", "not_attempted"] as const;
    for (const execution of executions) {
      for (const localCoverage of coverages) {
        for (const pendingInteractionCount of [0, 1] as const) {
          for (const responseInFlightCount of [0, 1] as const) {
            const expected = localCoverage !== "complete"
              ? "unknown"
              : execution === "recovery_required"
                ? "recovery_required"
                : pendingInteractionCount > 0
                  ? "human_action_required"
                  : responseInFlightCount > 0
                    ? "response_in_flight"
                    : "none";
            expect(deriveSessionAttention({
              execution,
              localCoverage,
              pendingInteractionCount,
              responseInFlightCount,
            })).toBe(expected);
          }
        }
      }
    }

    const providerObservations = [
      {
        source: "codex_app_server",
        basis: "provider_read",
        state: "live",
        coverage: "complete",
        freshness: "fresh",
        profileGeneration: 1,
        observedAt: 2,
        connectionId: "00000000-0000-4000-8000-000000000001",
        mode: "connected",
      },
      {
        source: "codex_app_server",
        basis: "local_state",
        state: "unavailable",
        coverage: "unavailable",
        freshness: "fresh",
        profileGeneration: 1,
        observedAt: 2,
        code: "account_signed_out",
      },
      {
        source: "codex_app_server",
        basis: "local_state",
        state: "recovery_required",
        coverage: "partial",
        freshness: "fresh",
        profileGeneration: 1,
        observedAt: 2,
        code: "session_quarantined",
      },
      {
        source: "codex_app_server",
        basis: "local_state",
        state: "not_applicable",
        coverage: "not_attempted",
        freshness: "unknown",
        profileGeneration: 1,
        observedAt: 2,
        reason: "terminal",
      },
    ] as const;

    for (const execution of executions) {
      for (const providerObservation of providerObservations) {
        for (const pendingCount of [0, 1] as const) {
          for (const responseInFlightCount of [0, 1] as const) {
            for (const queueDepth of [0, 2] as const) {
              const attention = deriveSessionAttention({
                execution,
                localCoverage: "complete",
                pendingInteractionCount: pendingCount,
                responseInFlightCount,
              });
              const parsed = sessionStatusSchema.parse({
                version: 2,
                session: {
                  id: "sess_00000000000000000000000000000000",
                  accountId: "acct_00000000000000000000000000000000",
                  projectId: null,
                  title: "Release",
                  execution,
                  activeTurnId: null,
                  revision: 1,
                  createdAt: 1,
                  updatedAt: 2,
                },
                advisory: { execution, attention, queueDepth },
                localObservation: {
                  source: "sqlite",
                  coverage: "complete",
                  freshness: "fresh",
                  observedAt: 2,
                },
                providerObservation,
                eventStream: {
                  streamEpoch: "00000000-0000-4000-8000-000000000002",
                  floorSequence: 1,
                  observedThroughSequence: 0,
                  cursor: cursorWire("cursor"),
                  retentionFloorCursor: cursorWire("floor"),
                },
                interactions: {
                  pendingCount,
                  responseInFlightCount,
                  pending: pendingCount === 0 ? [] : [{
                    id: "00000000-0000-4000-8000-000000000003",
                    kind: "user_input",
                    revision: 1,
                    blocking: true,
                    summary: "Choose a target",
                    requestedAt: 1,
                    deadlineAt: 3,
                  }],
                  truncated: false,
                },
                queue: {
                  depth: queueDepth,
                  dispatchingCount: 1,
                  ambiguousCount: 1,
                  failedCount: 1,
                },
              });
              expect({
                attention: parsed.advisory.attention,
                execution: parsed.advisory.execution,
                provider: parsed.providerObservation.state,
                queueDepth: parsed.advisory.queueDepth,
              }).toEqual({
                attention,
                execution,
                provider: providerObservation.state,
                queueDepth,
              });
            }
          }
        }
      }
    }
  });

  test("requires truthful interaction truncation", () => {
    expect(sessionInteractionObservationSchema.safeParse({
      pendingCount: 2,
      responseInFlightCount: 0,
      pending: [],
      truncated: false,
    }).success).toBe(false);
    expect(sessionInteractionObservationSchema.safeParse({
      pendingCount: 2,
      responseInFlightCount: 1,
      pending: [{
        id: "00000000-0000-4000-8000-000000000001",
        kind: "user_input",
        revision: 1,
        blocking: true,
        summary: "Choose a target",
        requestedAt: 1,
        deadlineAt: 2,
      }],
      truncated: true,
    }).success).toBe(true);
  });

  test("rejects a torn session advisory", () => {
    const status = {
      version: 2,
      session: {
        id: "sess_00000000000000000000000000000000",
        accountId: "acct_00000000000000000000000000000000",
        projectId: null,
        title: "Release",
        execution: "idle",
        activeTurnId: null,
        revision: 1,
        createdAt: 1,
        updatedAt: 2,
      },
      advisory: { execution: "active", attention: "none", queueDepth: 0 },
      localObservation: {
        source: "sqlite",
        coverage: "complete",
        freshness: "fresh",
        observedAt: 2,
      },
      providerObservation: {
        source: "codex_app_server",
        basis: "provider_read",
        state: "live",
        coverage: "complete",
        freshness: "fresh",
        profileGeneration: 1,
        observedAt: 2,
        connectionId: "00000000-0000-4000-8000-000000000001",
        mode: "connected",
      },
      eventStream: {
        streamEpoch: "00000000-0000-4000-8000-000000000002",
        floorSequence: 1,
        observedThroughSequence: 0,
        cursor: cursorWire("cursor"),
        retentionFloorCursor: cursorWire("floor"),
      },
      interactions: {
        pendingCount: 0,
        responseInFlightCount: 0,
        pending: [],
        truncated: false,
      },
      queue: { depth: 0, dispatchingCount: 0, ambiguousCount: 0, failedCount: 0 },
    };
    expect(sessionStatusSchema.safeParse(status).success).toBe(false);
    expect(sessionStatusSchema.safeParse({
      ...status,
      advisory: { execution: "idle", attention: "human_action_required", queueDepth: 0 },
    }).success).toBe(false);
    expect(sessionStatusSchema.safeParse({
      ...status,
      providerObservation: { ...status.providerObservation, basis: "local_state" },
    }).success).toBe(false);
  });

  test("bounds the maximum root attention record shape and serialized output", () => {
    const maximum = Number.MAX_SAFE_INTEGER;
    const records = Array.from({ length: ROOT_STATUS_ATTENTION_LIMIT }, (_, index) => {
      const interactionId = `a0000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
      return {
        kind: "interaction_pending" as const,
        accountId: `acct_${"a".repeat(32)}`,
        accountGeneration: maximum,
        sessionId: `sess_${"b".repeat(32)}`,
        interactionId,
        interactionRevision: maximum,
        interactionKind: "permission_approval" as const,
        interactionState: "pending" as const,
        blocking: false,
        deadlineAt: maximum,
        observedAt: maximum,
        intent: {
          kind: "inspect_interaction" as const,
          interactionId,
          expectedRevision: maximum,
        },
      };
    });
    const status = rootStatusSchema.parse({
      version: 1,
      scope: "local_only",
      localObservation: {
        source: "sqlite",
        coverage: "complete",
        freshness: "fresh",
        observedAt: maximum,
        tables: [
          "profiles",
          "sessions",
          "provider_interactions",
          "queue_entries",
          "usage_snapshots",
          "usage_poll_failures",
        ],
      },
      providerObservation: {
        source: "codex_app_server",
        coverage: "not_attempted",
        freshness: "unknown",
        observedAt: null,
      },
      cloudObservation: {
        source: "convex",
        coverage: "not_attempted",
        freshness: "unknown",
        observedAt: null,
        devices: { registered: null, online: null },
      },
      counts: {
        accounts: {
          signedOut: maximum,
          loginPending: maximum,
          signedIn: maximum,
          recoveryRequired: maximum,
        },
        sessions: {
          starting: maximum,
          active: maximum,
          idle: maximum,
          terminal: maximum,
          recoveryRequired: maximum,
        },
        interactions: {
          pending: maximum,
          responsePrepared: maximum,
          responseWritten: maximum,
          resolved: maximum,
          declined: maximum,
          canceled: maximum,
          expired: maximum,
          resolutionUnknown: maximum,
        },
        queue: {
          pending: maximum,
          dispatching: maximum,
          applied: maximum,
          failed: maximum,
          ambiguous: maximum,
          cancelled: maximum,
        },
        usage: { observed: maximum, failed: maximum, missing: maximum },
      },
      attention: { records, total: maximum, truncated: true },
    });
    expect(status.attention.records).toHaveLength(ROOT_STATUS_ATTENTION_LIMIT);
    expect(ROOT_STATUS_ATTENTION_LIMIT).toBe(50);
    expect(assertRootStatusBound(status)).toEqual(status);
    const bytes = new TextEncoder().encode(`${JSON.stringify({
      ok: true,
      version: 1,
      command: "status",
      data: status,
    })}\n`).byteLength;
    expect(bytes).toBeLessThanOrEqual(ROOT_STATUS_MAXIMUM_BYTES);
    expect(bytes).toBeGreaterThan(25_000);
    expect(rootStatusSchema.safeParse({
      ...status,
      attention: {
        records: [...records, records[0]],
        total: maximum,
        truncated: true,
      },
    }).success).toBe(false);
  });
});
