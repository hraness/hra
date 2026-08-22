import { afterEach, describe, expect, test } from "bun:test";
import type { LocalObservationResponse } from "@hraness/hra-local-observation-protocol/wire";

import { queryLocalDesktop, LocalCliFailure } from "./client";
import {
  createFakeHome,
  startFakeLocalRuntime,
  type FakeLocalRuntime,
} from "./test-support";

const runtimes: FakeLocalRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(async (runtime) => await runtime.close()));
});

function success(type: "attention" | "panes"): LocalObservationResponse {
  return type === "attention"
    ? {
        version: 1,
        ok: true,
        result: {
          type,
          projection: { version: 1, completeness: "complete", items: [] },
        },
      }
    : {
        version: 1,
        ok: true,
        result: {
          type,
          projection: { version: 1, panes: [], truncated: false },
        },
      };
}

async function failureOf(operation: Promise<unknown>): Promise<LocalCliFailure> {
  try {
    await operation;
  } catch (error: unknown) {
    if (error instanceof LocalCliFailure) return error;
    throw error;
  }
  throw new Error("Expected the local observation operation to fail.");
}

describe("bounded local observation client", () => {
  test("sends a capability-bound operation to one fixed runtime", async () => {
    const home = createFakeHome();
    let observed: unknown = null;
    runtimes.push(await startFakeLocalRuntime({
      home,
      profile: "development",
      response: (text) => {
        observed = JSON.parse(text) as unknown;
        return success("panes");
      },
    }));
    expect(await queryLocalDesktop("panes.list", { homeDirectory: home }))
      .toEqual(success("panes"));
    expect(observed).toEqual({
      version: 1,
      capability: "A".repeat(43),
      operation: "panes.list",
    });
  });

  test("fails closed when both fixed runtimes answer", async () => {
    const home = createFakeHome();
    runtimes.push(await startFakeLocalRuntime({
      home,
      profile: "production",
      response: () => success("attention"),
    }));
    // Both runtimes share one synthetic home; close them manually so either
    // cleanup cannot remove the other's root before its server closes.
    const development = await startFakeLocalRuntime({
      home,
      profile: "development",
      response: () => success("attention"),
    });
    runtimes.push({ ...development, close: async () => await development.close() });
    expect(await failureOf(queryLocalDesktop("attention.list", { homeDirectory: home })))
      .toMatchObject({ code: "multiple_runtimes" });
  });

  test("rejects mismatched, malformed, and oversized responses", async () => {
    for (const [response, expected] of [
      [success("attention"), "invalid_response"],
      ["not-json", "invalid_response"],
      ["x".repeat(256 * 1_024 + 1), "invalid_response"],
    ] as const) {
      const home = createFakeHome();
      const runtime = await startFakeLocalRuntime({
        home,
        profile: "production",
        response: () => response,
      });
      const failure = await failureOf(queryLocalDesktop("panes.list", {
        homeDirectory: home,
      }));
      expect(failure).toBeInstanceOf(LocalCliFailure);
      expect(failure).toMatchObject({ code: expected });
      await runtime.close();
    }
  });

  test("bounds a silent runtime", async () => {
    const home = createFakeHome();
    runtimes.push(await startFakeLocalRuntime({
      home,
      profile: "production",
      response: () => undefined,
    }));
    expect(await failureOf(queryLocalDesktop("attention.list", {
      homeDirectory: home,
      timeoutMilliseconds: 25,
    }))).toMatchObject({ code: "runtime_unavailable" });
  });

  test("uses one absolute deadline while a runtime trickles response bytes", async () => {
    const home = createFakeHome();
    let trickleWrites = 0;
    runtimes.push(await startFakeLocalRuntime({
      home,
      profile: "production",
      response: (_request, socket) => {
        let writes = 0;
        const trickle = setInterval(() => {
          if (socket.destroyed || writes >= 8) {
            clearInterval(trickle);
            return;
          }
          socket.write(" ");
          writes += 1;
          trickleWrites += 1;
        }, 15);
        socket.once("close", () => clearInterval(trickle));
        return undefined;
      },
    }));
    expect(await failureOf(queryLocalDesktop("attention.list", {
      homeDirectory: home,
      timeoutMilliseconds: 40,
    }))).toMatchObject({ code: "runtime_unavailable" });
    expect(trickleWrites).toBeLessThan(8);
  });
});
