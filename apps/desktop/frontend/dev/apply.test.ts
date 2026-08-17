import { describe, expect, test } from "bun:test";

import type { RuntimeSnapshot } from "../../contracts/runtime";
import { emptyRuntimeSnapshot } from "../src/runtime/test-fixtures";

import {
  applyStagedDevelopmentUpdate,
  runtimeSnapshotHasActiveWork,
} from "./apply";
import type { DevStatusClient } from "./status-client";
import {
  DevelopmentReloadAcceptedUnconfirmedError,
  DevelopmentReloadOutcomeUnconfirmedError,
  parseDevStatusEnvelope,
  type DevStatusEnvelope,
  type DevelopmentReloadResponse,
} from "./protocol";

const sessionId = "a".repeat(64);
const candidateId = "b".repeat(64);

function status(
  state: DevStatusEnvelope["state"],
  revision: number,
): DevStatusEnvelope {
  return parseDevStatusEnvelope({
    schema: "hra-dev-status/v1",
    sessionId,
    authority: "launcher",
    revision,
    state,
    target: state === "current" ? "none" : "gateway",
    changeCount: state === "current" ? 0 : 1,
    candidateId: state === "staged" || state === "applying" ? candidateId : null,
  });
}

function activeSnapshot(overrides: Readonly<Record<string, unknown>>): RuntimeSnapshot {
  return {
    ...emptyRuntimeSnapshot(),
    chat: {
      revision: 1,
      panes: [{
        state: "ready",
        workspace: null,
        harness: null,
        ...overrides,
      }],
    },
  } as unknown as RuntimeSnapshot;
}

function statusClient(
  events: string[],
  read = status("staged", 1),
  reserve = status("applying", 2),
  final = status("current", 3),
): DevStatusClient {
  return {
    read() {
      events.push("status");
      return Promise.resolve(read);
    },
    reserve(receivedSession, receivedCandidate) {
      events.push(`reserve:${receivedSession}:${receivedCandidate}`);
      return Promise.resolve(reserve);
    },
    acknowledge(receivedSession, receivedCandidate) {
      events.push(`ack:${receivedSession}:${receivedCandidate}`);
      return Promise.resolve(final);
    },
    cancel(receivedSession, receivedCandidate) {
      events.push(`cancel:${receivedSession}:${receivedCandidate}`);
      return Promise.resolve(status("staged", 3));
    },
  };
}

describe("runtime activity preflight", () => {
  test("admits a settled authoritative snapshot", () => {
    expect(runtimeSnapshotHasActiveWork(emptyRuntimeSnapshot())).toBeFalse();
  });

  test("protects active panes and workspace preparation or capacity waits", () => {
    expect(runtimeSnapshotHasActiveWork(activeSnapshot({ state: "streaming" }))).toBeTrue();
    expect(runtimeSnapshotHasActiveWork(activeSnapshot({
      workspace: { state: "preparing" },
    }))).toBeTrue();
    expect(runtimeSnapshotHasActiveWork(activeSnapshot({
      workspace: { state: "waitingCapacity" },
    }))).toBeTrue();
  });

  test("fails closed for active or omitted harness descendants", () => {
    expect(runtimeSnapshotHasActiveWork(activeSnapshot({
      harness: {
        descendants: {
          truncated: false,
          children: [{ state: "waiting" }],
        },
      },
    }))).toBeTrue();
    expect(runtimeSnapshotHasActiveWork(activeSnapshot({
      harness: {
        descendants: { truncated: true, children: [] },
      },
    }))).toBeTrue();
  });
});

describe("reserved development apply", () => {
  test("orders snapshot, reservation, exact reload, and acknowledgement", async () => {
    const events: string[] = [];
    const outcome = await applyStagedDevelopmentUpdate(status("staged", 1), {
      statuses: statusClient(events),
      takeSnapshot() {
        events.push("snapshot");
        return Promise.resolve(emptyRuntimeSnapshot());
      },
      reloadAndConfirm(receivedCandidate): Promise<DevelopmentReloadResponse> {
        events.push(`reload:${receivedCandidate}`);
        return Promise.resolve({
          version: 1,
          mode: "developmentReload",
          status: "accepted",
          candidateId,
          currentGeneration: 4,
          nextGeneration: 5,
        });
      },
    });

    expect(outcome.kind).toBe("applied");
    expect(events).toEqual([
      "status",
      "snapshot",
      `reserve:${sessionId}:${candidateId}`,
      `reload:${candidateId}`,
      `ack:${sessionId}:${candidateId}`,
    ]);
  });

  test("never reserves or reloads while projected work is active", async () => {
    const events: string[] = [];
    const outcome = await applyStagedDevelopmentUpdate(status("staged", 1), {
      statuses: statusClient(events),
      takeSnapshot() {
        events.push("snapshot");
        return Promise.resolve(activeSnapshot({ state: "continuing" }));
      },
      reloadAndConfirm() {
        return Promise.reject(new Error("must not reload"));
      },
    });

    expect(outcome.kind).toBe("activeWork");
    expect(events).toEqual(["status", "snapshot"]);
  });

  test("releases the reservation when Native remains busy", async () => {
    const events: string[] = [];
    const outcome = await applyStagedDevelopmentUpdate(status("staged", 1), {
      statuses: statusClient(events),
      takeSnapshot: () => Promise.resolve(emptyRuntimeSnapshot()),
      reloadAndConfirm: () => Promise.resolve({
        version: 1,
        mode: "developmentReload",
        status: "busy",
        candidateId,
        currentGeneration: 4,
        nextGeneration: null,
      }),
    });

    expect(outcome.kind).toBe("runtimeBusy");
    expect(events.at(-1)).toBe(`cancel:${sessionId}:${candidateId}`);
    expect(events.some((event) => event.startsWith("ack:"))).toBeFalse();
  });

  test("keeps an accepted but unconfirmed candidate reserved", async () => {
    const events: string[] = [];
    const accepted = {
      version: 1,
      mode: "developmentReload",
      status: "accepted",
      candidateId,
      currentGeneration: 4,
      nextGeneration: 5,
    } as const;
    const outcome = await applyStagedDevelopmentUpdate(status("staged", 1), {
      statuses: statusClient(events),
      takeSnapshot: () => Promise.resolve(emptyRuntimeSnapshot()),
      reloadAndConfirm: () => Promise.reject(
        new DevelopmentReloadAcceptedUnconfirmedError(
          accepted,
          new Error("readiness timed out"),
        ),
      ),
    });

    expect(outcome.kind).toBe("acceptedUnconfirmed");
    expect(events.some((event) => event.startsWith("cancel:"))).toBeFalse();
    expect(events.some((event) => event.startsWith("ack:"))).toBeFalse();
  });

  test("keeps an invocation with an unknown Native outcome reserved", async () => {
    const events: string[] = [];
    const outcome = await applyStagedDevelopmentUpdate(status("staged", 1), {
      statuses: statusClient(events),
      takeSnapshot: () => Promise.resolve(emptyRuntimeSnapshot()),
      reloadAndConfirm: () => Promise.reject(
        new DevelopmentReloadOutcomeUnconfirmedError(
          new Error("bridge response was lost"),
        ),
      ),
    });

    expect(outcome.kind).toBe("acceptedUnconfirmed");
    expect(events.some((event) => event.startsWith("cancel:"))).toBeFalse();
    expect(events.some((event) => event.startsWith("ack:"))).toBeFalse();
  });

  test("does not cancel a confirmed runtime when coordinator acknowledgement fails", async () => {
    const events: string[] = [];
    const client = statusClient(events);
    const outcome = await applyStagedDevelopmentUpdate(status("staged", 1), {
      statuses: {
        ...client,
        acknowledge(receivedSession, receivedCandidate) {
          events.push(`ack:${receivedSession}:${receivedCandidate}`);
          return Promise.reject(new Error("coordinator unavailable"));
        },
      },
      takeSnapshot: () => Promise.resolve(emptyRuntimeSnapshot()),
      reloadAndConfirm: () => Promise.resolve({
        version: 1,
        mode: "developmentReload",
        status: "accepted",
        candidateId,
        currentGeneration: 4,
        nextGeneration: 5,
      }),
    });

    expect(outcome.kind).toBe("acceptedUnconfirmed");
    expect(events.some((event) => event.startsWith("cancel:"))).toBeFalse();
  });
});
