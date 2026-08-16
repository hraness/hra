import { expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";

import {
  createAgentTasksDirectWorld,
  parseAgentTasksDirectWorld,
} from "./world";

const diagnostic = fc.string({ minLength: 1, maxLength: 80 });

test("property: bounded diagnostics survive JSON round trips without aliasing", () => {
  assertProperty(fc.property(
    fc.array(diagnostic, { maxLength: 24 }),
    fc.array(diagnostic, { maxLength: 24 }),
    (requests, violations) => {
      const world = createAgentTasksDirectWorld((draft) => {
        draft.diagnostics = { requests, violations };
      });
      const parsed = parseAgentTasksDirectWorld(JSON.parse(JSON.stringify(world)) as unknown);
      expect(parsed).toEqual(world);
      expect(parsed).not.toBe(world);
      expect(parsed.diagnostics.requests).not.toBe(world.diagnostics.requests);
    },
  ));
}, 15_000);

test("property: every unknown world key is rejected by the strict parser", () => {
  const known = new Set([
    "schema", "version", "now", "workspace", "viewer", "agents", "capabilities",
    "counts", "activeView", "views", "selectedTaskKey", "details", "runner", "scripts", "diagnostics",
  ]);
  assertProperty(fc.property(
    fc.string({ minLength: 1, maxLength: 40 }).filter((key) => !known.has(key)),
    fc.jsonValue(),
    (key, value) => {
      expect(() => parseAgentTasksDirectWorld({
        ...createAgentTasksDirectWorld(),
        [key]: value,
      })).toThrow();
    },
  ));
}, 15_000);

test("property: duplicate task identities are rejected in every ready view", () => {
  assertProperty(fc.property(
    fc.constantFrom("all", "ready", "blocked", "deferred", "attention", "assigned", "review" as const),
    (view) => {
      const world = createAgentTasksDirectWorld();
      const task = world.details[0]?.task;
      if (task === undefined) throw new Error("The base world must contain one detail.");
      world.views[view] = { cursor: null, kind: "ready", tasks: [task, structuredClone(task)] };
      if (world.activeView === view) world.selectedTaskKey = task.key;
      expect(() => parseAgentTasksDirectWorld(world)).toThrow(/must be unique/u);
    },
  ));
});
