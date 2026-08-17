import { describe, expect, test } from "bun:test";

import {
  runtimeSnapshotCommand,
  runtimeTransportLifecycleEventName,
} from "../../contracts/runtime";
import type { RuntimeTransport } from "../src/runtime-bridge";
import { emptyRuntimeSnapshot } from "../src/runtime/test-fixtures";

import {
  createReadyGenerationObserver,
  reloadAndConfirmDevelopmentCandidate,
} from "./native-runtime";
import {
  DEVELOPMENT_RELOAD_COMMAND,
  DevelopmentReloadAcceptedUnconfirmedError,
  DevelopmentReloadOutcomeUnconfirmedError,
} from "./protocol";

const candidateId = "b".repeat(64);

function transportHarness(emitAcceptedReady = true) {
  const listeners = new Set<(detail: unknown) => void>();
  const invocations: Array<{ readonly command: string; readonly payload: unknown }> = [];
  const transport: RuntimeTransport = {
    invoke(command, payload) {
      invocations.push({ command, payload });
      if (command === DEVELOPMENT_RELOAD_COMMAND) {
        if (emitAcceptedReady) {
          for (const listener of listeners) listener({
            version: 1,
            state: "ready",
            generation: 7,
          });
        }
        return Promise.resolve({
          version: 1,
          mode: "developmentReload",
          status: "accepted",
          candidateId,
          currentGeneration: 6,
          nextGeneration: 7,
        });
      }
      if (command === runtimeSnapshotCommand) {
        return Promise.resolve({
          version: 3,
          snapshot: emptyRuntimeSnapshot(),
        });
      }
      return Promise.reject(new Error("unexpected native command"));
    },
    on(name, listener) {
      if (name === runtimeTransportLifecycleEventName) listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { invocations, listeners, transport };
}

describe("development runtime generation fence", () => {
  test("ignores readiness from any generation except the accepted one", async () => {
    const harness = transportHarness();
    const observer = createReadyGenerationObserver(harness.transport);
    let settled = false;
    const waiting = observer.waitFor(9, 100).then(() => {
      settled = true;
    });
    for (const listener of harness.listeners) listener({
      version: 1,
      state: "ready",
      generation: 8,
    });
    await Promise.resolve();
    expect(settled).toBeFalse();
    for (const listener of harness.listeners) listener({
      version: 1,
      state: "ready",
      generation: 9,
    });
    await waiting;
    expect(settled).toBeTrue();
    observer.dispose();
  });

  test("re-snapshots only after exact new-generation readiness", async () => {
    const harness = transportHarness();
    const response = await reloadAndConfirmDevelopmentCandidate(
      harness.transport,
      candidateId,
      100,
    );

    expect(response.status).toBe("accepted");
    expect(harness.invocations.map(({ command }) => command)).toEqual([
      DEVELOPMENT_RELOAD_COMMAND,
      runtimeSnapshotCommand,
    ]);
    expect(harness.invocations[0]?.payload).toEqual({
      version: 1,
      mode: "developmentReload",
      candidateId,
    });
  });

  test("marks post-acceptance readiness failure as ambiguous", async () => {
    const harness = transportHarness(false);
    let failure: unknown = null;
    try {
      await reloadAndConfirmDevelopmentCandidate(
        harness.transport,
        candidateId,
        1,
      );
    } catch (reason: unknown) {
      failure = reason;
    }

    expect(failure).toBeInstanceOf(DevelopmentReloadAcceptedUnconfirmedError);
    expect(harness.invocations.map(({ command }) => command)).toEqual([
      DEVELOPMENT_RELOAD_COMMAND,
    ]);
  });

  test("marks a lost Native decision as ambiguous", async () => {
    const harness = transportHarness(false);
    const transport: RuntimeTransport = {
      ...harness.transport,
      invoke(command, payload) {
        if (command === DEVELOPMENT_RELOAD_COMMAND) {
          return Promise.reject(new Error("bridge response was lost"));
        }
        return harness.transport.invoke(command, payload);
      },
    };
    let failure: unknown = null;
    try {
      await reloadAndConfirmDevelopmentCandidate(transport, candidateId, 100);
    } catch (reason: unknown) {
      failure = reason;
    }

    expect(failure).toBeInstanceOf(DevelopmentReloadOutcomeUnconfirmedError);
  });
});
