import { expect, test } from "bun:test";

import { zigArgumentsWithWorkerBudget } from "../run-zig";

test("caps uncapped Zig builds at the admitted worker budget", () => {
  expect(zigArgumentsWithWorkerBudget(
    ["build", "test", "-Dplatform=macos"],
    { HRA_CHECK_WORKER_BUDGET: "3" },
  )).toEqual(["build", "-j3", "test", "-Dplatform=macos"]);
});

test("preserves non-build and explicitly capped Zig commands", () => {
  expect(zigArgumentsWithWorkerBudget(
    ["version"],
    { HRA_CHECK_WORKER_BUDGET: "3" },
  )).toEqual(["version"]);
  expect(zigArgumentsWithWorkerBudget(
    ["build", "-j2", "test"],
    { HRA_CHECK_WORKER_BUDGET: "3" },
  )).toEqual(["build", "-j2", "test"]);
  expect(zigArgumentsWithWorkerBudget(["build", "test"], {}))
    .toEqual(["build", "test"]);
});

test("rejects malformed scheduler worker budgets", () => {
  expect(() => zigArgumentsWithWorkerBudget(
    ["build"],
    { HRA_CHECK_WORKER_BUDGET: "0" },
  )).toThrow("HRA_CHECK_WORKER_BUDGET must be a positive integer");
  expect(() => zigArgumentsWithWorkerBudget(
    ["build"],
    { HRA_CHECK_WORKER_BUDGET: "many" },
  )).toThrow("HRA_CHECK_WORKER_BUDGET must be a positive integer");
});
