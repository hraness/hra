import { describe, expect, test } from "bun:test";

import {
  inspectRealtimeDetailUpdate,
  parseRealtimeCliMarker,
  type RealtimeCliMarker,
} from "./realtime-cli-proof";

const MARKER = {
  schemaVersion: 1,
  workspaceId: "workspace-alpha",
  taskKey: "ALPHA-0000001",
  expectedAgentId: "agent-alpha-builder",
  initialStatus: "open",
  initialRevision: 1,
} as const satisfies RealtimeCliMarker;

const TASK_BASE = {
  id: "tsk_00000000000000000000000000",
  key: MARKER.taskKey,
  title: "Signed prerequisite",
  type: "task",
  priority: 2,
  availableAt: 1,
  unresolvedBlockerCount: 0,
  cancelledBlockerCount: 0,
  reviewRevision: 1,
  createdAt: 1,
  updatedAt: 1,
} as const;

function detail(task: Record<string, unknown>, events: readonly unknown[]) {
  return {
    ok: true,
    data: { task, events, truncatedCollections: [] },
    requestId: "req_00000000000000000000000000",
  };
}

describe("signed realtime taskctl proof", () => {
  test("strictly parses the secret-free coordination marker", () => {
    expect(parseRealtimeCliMarker(`${JSON.stringify(MARKER)}\n`)).toEqual(MARKER);
    expect(() =>
      parseRealtimeCliMarker(JSON.stringify({ ...MARKER, accessToken: "must-not-exist" })),
    ).toThrow("fields did not match");
  });

  test("distinguishes the initial state from an authoritative claim event", () => {
    expect(
      inspectRealtimeDetailUpdate(
        detail(
          { ...TASK_BASE, status: "open", isReady: true, revision: 1 },
          [
            {
              id: "event-created",
              type: "task.created",
              taskRevision: 1,
              actor: { kind: "agent", id: MARKER.expectedAgentId, name: "Builder" },
            },
          ],
        ),
        MARKER,
      ),
    ).toEqual({ kind: "initial", revision: 1 });

    expect(
      inspectRealtimeDetailUpdate(
        detail(
          {
            ...TASK_BASE,
            status: "in_progress",
            isReady: false,
            revision: 2,
            currentClaim: {
              id: "claim-alpha",
              agentId: MARKER.expectedAgentId,
              fence: 1,
              leaseGeneration: 1,
              leaseUntil: 10_000,
            },
          },
          [
            {
              id: "event-claimed",
              type: "task.claimed",
              taskRevision: 2,
              actor: {
                kind: "agent",
                id: MARKER.expectedAgentId,
                name: "Builder",
                status: "active",
              },
            },
          ],
        ),
        MARKER,
      ),
    ).toEqual({
      kind: "claimed",
      revision: 2,
      claimId: "claim-alpha",
      eventId: "event-claimed",
      agentId: MARKER.expectedAgentId,
    });
  });

  test("rejects a claim whose persisted event belongs to another agent", () => {
    expect(() =>
      inspectRealtimeDetailUpdate(
        detail(
          {
            ...TASK_BASE,
            status: "in_progress",
            isReady: false,
            revision: 2,
            currentClaim: {
              id: "claim-alpha",
              agentId: MARKER.expectedAgentId,
              fence: 1,
              leaseGeneration: 1,
              leaseUntil: 10_000,
            },
          },
          [
            {
              id: "event-claimed",
              type: "task.claimed",
              taskRevision: 2,
              actor: {
                kind: "agent",
                id: "agent-impostor",
                name: "Impostor",
                status: "active",
              },
            },
          ],
        ),
        MARKER,
      ),
    ).toThrow("Persisted claim event");
  });
});
