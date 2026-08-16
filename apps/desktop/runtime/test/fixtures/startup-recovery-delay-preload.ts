import { appendFileSync, existsSync } from "node:fs";

import { LocalQueuedRunExecutor } from "../../src/tasks/local-run-executor";

const gatePath = process.env.HRA_GATEWAY_TEST_STARTUP_RECOVERY_GATE;
const enteredPath = process.env.HRA_GATEWAY_TEST_STARTUP_RECOVERY_ENTERED;
if (gatePath === undefined || enteredPath === undefined) {
  throw new Error("Startup recovery delay fixture paths are required.");
}

const originalStart = Reflect.get(
  LocalQueuedRunExecutor.prototype,
  "start",
);
let recorded = false;
LocalQueuedRunExecutor.prototype.start = async function delayedStartupRun(
  this: LocalQueuedRunExecutor,
  input: Parameters<LocalQueuedRunExecutor["start"]>[0],
) {
  if (!recorded) {
    recorded = true;
    appendFileSync(enteredPath, `${input.work.kind}\n`, "utf8");
  }
  while (existsSync(gatePath)) await Bun.sleep(10);
  return await Reflect.apply(originalStart, this, [input]);
};
