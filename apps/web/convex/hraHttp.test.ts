import { describe, expect, test } from "bun:test";

import http from "./http";
import {
  hraHumanAdmissionRateClass,
  nextHRAInvalidationPollDelay,
  runHRAInvalidationPoll,
} from "./hraHttp";

const WORKSPACE_ID = "wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const RUN_ID = "run_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const INTERACTION_ID = "int_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PROMOTION_ID = "promotion_01ARZ3NDEKTSV4RRFFQ69G5FAV";

function humanRouteCases(product: "hra" | "oprte" | "kitchen") {
  const base = `/v1/${product}/workspaces`;
  const workspace = `${base}/${WORKSPACE_ID}`;
  return [
    ["GET", base],
    ["GET", workspace],
    ["GET", `${workspace}/context`],
    ["GET", `${workspace}/tasks`],
    ["POST", `${workspace}/mutations`],
    ["GET", `${workspace}/invalidations`],
    [
      "GET",
      `${workspace}/runs/${RUN_ID}/interactions/${INTERACTION_ID}/reply-authority`,
    ],
    [
      "POST",
      `${workspace}/runs/${RUN_ID}/interactions/${INTERACTION_ID}/responses`,
    ],
  ] as const;
}

function promotionRouteCases(product: "hra" | "oprte" | "kitchen") {
  const base = `/v1/${product}/promotions`;
  const promotion = `${base}/${PROMOTION_ID}`;
  return [
    ["POST", base],
    ["GET", promotion],
    ["POST", `${promotion}/batches`],
    ["POST", `${promotion}/activate`],
    ["POST", `${promotion}/abort`],
    ["GET", `${promotion}/receipts`],
    ["POST", `${promotion}/cleanup`],
    ["GET", `${promotion}/cleanup/status`],
  ] as const;
}

describe("HRA HTTP route registration", () => {
  test("admits long polls through their dedicated bounded rate class", () => {
    expect(hraHumanAdmissionRateClass("poll_invalidations")).toBe(
      "human_poll",
    );
    for (const operation of [
      "list_workspaces",
      "get_workspace",
      "get_context",
      "list_repositories",
      "list_tasks",
      "lookup_task",
      "get_task",
      "mutate",
      "get_interaction_reply_authority",
      "respond_interaction",
    ] as const) {
      expect(hraHumanAdmissionRateClass(operation)).toBeNull();
    }
  });

  test("backs idle invalidation reads off to one query per second", () => {
    expect(nextHRAInvalidationPollDelay(250)).toBe(500);
    expect(nextHRAInvalidationPollDelay(500)).toBe(1_000);
    expect(nextHRAInvalidationPollDelay(1_000)).toBe(1_000);
    expect(() => nextHRAInvalidationPollDelay(249)).toThrow(RangeError);
  });

  test("stops an invalidation poll without another query when the client aborts", async () => {
    const controller = new AbortController();
    let queryCount = 0;
    const startedAt = performance.now();
    const polling = runHRAInvalidationPoll({
      deadline: performance.now() + 25_000,
      query: () => {
        queryCount += 1;
        return Promise.resolve({ invalidations: [] as readonly unknown[] });
      },
      shouldStop: () => false,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 5);

    expect(await polling).toEqual({ invalidations: [] });
    expect(queryCount).toBe(1);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  test("does not query when an invalidation request is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let queryCount = 0;

    expect(
      await runHRAInvalidationPoll({
        deadline: performance.now() + 25_000,
        query: () => {
          queryCount += 1;
          return Promise.resolve("unexpected");
        },
        shouldStop: () => false,
        signal: controller.signal,
      }),
    ).toBeNull();
    expect(queryCount).toBe(0);
  });

  test("does not begin another query after the poll deadline elapses", async () => {
    let queryCount = 0;
    let clockReads = 0;

    expect(
      await runHRAInvalidationPoll({
        deadline: 1,
        now: () => {
          clockReads += 1;
          return clockReads === 1 ? 0 : 2;
        },
        query: () => {
          queryCount += 1;
          return Promise.resolve({ invalidations: [] as readonly unknown[] });
        },
        shouldStop: () => false,
        signal: new AbortController().signal,
      }),
    ).toEqual({ invalidations: [] });
    expect(queryCount).toBe(1);
  });

  test("registers the exact human adapter surface", () => {
    for (const [method, path] of humanRouteCases("hra")) {
      expect(http.lookup(path, method)).not.toBeNull();
    }
    expect(http.lookup("/v1/hra/workspaces", "POST")).toBeNull();
  });

  test("keeps exact OPRTE and Kitchen human aliases on the same handlers", () => {
    for (const product of ["oprte", "kitchen"] as const) {
      for (const [method, path] of humanRouteCases(product)) {
        expect(http.lookup(path, method)).not.toBeNull();
      }
      expect(http.lookup(`/v1/${product}/workspaces`, "POST")).toBeNull();
    }
  });

  test("registers every promotion operation", () => {
    for (const [method, path] of promotionRouteCases("hra")) {
      expect(http.lookup(path, method)).not.toBeNull();
    }
    expect(http.lookup("/v1/hra/promotions", "GET")).toBeNull();
  });

  test("keeps exact OPRTE and Kitchen promotion aliases on the same handlers", () => {
    for (const product of ["oprte", "kitchen"] as const) {
      for (const [method, path] of promotionRouteCases(product)) {
        expect(http.lookup(path, method)).not.toBeNull();
      }
      expect(http.lookup(`/v1/${product}/promotions`, "GET")).toBeNull();
    }
  });
});
